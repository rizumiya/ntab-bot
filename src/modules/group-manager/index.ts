import { BotModule, BotContext } from "../../core/engine/types";
import { getDatabase } from "../../core/db";
import { repo } from "../../core/db/repo";
import { TtlCache } from "../../core/tools/cache";
import { htmlEscape } from "../../core/tools/text";
import { reply } from "../../core/tools/ui";

const MAX_WARNS = 3;

type Target = { id: number; first_name: string; is_bot: boolean };

const mention = (u: Target) => `<a href="tg://user?id=${u.id}">${htmlEscape(u.first_name)}</a>`;

/**
 * Anggota yang pesannya dibalas, bila boleh ditindak.
 * Mengirim penjelasan sendiri dan mengembalikan null bila tidak valid.
 */
async function pickTarget(ctx: BotContext, verb: string): Promise<Target | null> {
  const target = ctx.message?.reply_to_message?.from;
  if (!target) {
    await reply(ctx, `ℹ️ Balas (reply) pesan anggota yang ingin di-${verb}.`);
    return null;
  }
  if (target.id === ctx.me.id || target.id === ctx.from?.id) {
    await reply(ctx, "ℹ️ Perintah ini tidak bisa dipakai pada diri sendiri atau pada bot ini.");
    return null;
  }
  try {
    const member = await ctx.getChatMember(target.id);
    if (member.status === "administrator" || member.status === "creator") {
      await reply(ctx, "ℹ️ Admin grup tidak bisa ditindak.");
      return null;
    }
  } catch {}
  return target;
}

// Teks sambutan dan aturan per grup, disimpan di kv. Cache mencegah baca database di tiap anggota masuk.
const textCache = new TtlCache<string, string>(10 * 60_000, 500);
const MAX_TEXT = 1500;

function groupText(kind: "welcome" | "rules", chatId: number): string {
  const key = `group:${kind}:${chatId}`;
  let value = textCache.get(key);
  if (value === undefined) {
    value = repo.getValue(key) ?? "";
    textCache.set(key, value);
  }
  return value;
}

function setGroupText(kind: "welcome" | "rules", chatId: number, value: string): void {
  const key = `group:${kind}:${chatId}`;
  repo.setValue(key, value);
  textCache.set(key, value);
}

/** Perintah /setwelcome dan /setrules: simpan teks, "off" untuk menghapus, tanpa isi untuk melihat. */
async function editGroupText(ctx: BotContext, kind: "welcome" | "rules", args: string, label: string, hint: string): Promise<void> {
  const chatId = ctx.chat!.id;
  if (!args) {
    const current = groupText(kind, chatId);
    await reply(ctx, current ? `📝 <b>${label} saat ini</b>\n\n${htmlEscape(current)}\n\n${hint}` : `📝 ${label} belum diatur.\n\n${hint}`);
    return;
  }
  if (args.toLowerCase() === "off") {
    setGroupText(kind, chatId, "");
    await reply(ctx, `✅ ${label} dihapus.`);
    return;
  }
  if (args.length > MAX_TEXT) {
    await reply(ctx, `⚠️ Terlalu panjang (${args.length} huruf). Maksimal ${MAX_TEXT} huruf.`);
    return;
  }
  setGroupText(kind, chatId, args);
  await reply(ctx, `✅ ${label} disimpan.`);
}

const NEED_RIGHTS = "❌ Gagal. Jadikan bot ini admin grup dengan izin <b>Blokir pengguna</b>.";

function warnCount(chatId: number, userId: number): number {
  const row = getDatabase().prepare("SELECT count FROM group_warns WHERE chat_id = ? AND user_id = ?").get(chatId, userId) as
    | { count: number }
    | undefined;
  return row?.count ?? 0;
}

function setWarnCount(chatId: number, userId: number, count: number): void {
  const db = getDatabase();
  if (count <= 0) db.prepare("DELETE FROM group_warns WHERE chat_id = ? AND user_id = ?").run(chatId, userId);
  else {
    db.prepare(
      "INSERT INTO group_warns (chat_id, user_id, count) VALUES (?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET count = excluded.count"
    ).run(chatId, userId, count);
  }
}

const groupManager: BotModule = {
  meta: {
    id: "group-manager",
    name: "Moderasi Grup",
    emoji: "👥",
    description: "Peringatan bertingkat, bisukan, dan keluarkan anggota grup.",
    category: "group",
    scope: "group",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
  },
  help: [
    "Tambahkan bot ke grup sebagai admin dengan izin <b>Blokir pengguna</b>.",
    "Semua perintah (kecuali /groupinfo) khusus admin grup dan dipakai dengan membalas pesan anggota.",
    `Anggota otomatis dikeluarkan setelah ${MAX_WARNS} peringatan.`,
    "Sambutan memakai <code>{nama}</code> dan <code>{grup}</code>, contoh: <code>/setwelcome Halo {nama}, selamat datang di {grup}!</code>",
    "Hapus sambutan atau aturan dengan <code>/setwelcome off</code> atau <code>/setrules off</code>.",
  ],

  setup(composer) {
    // Sambut anggota baru bila admin grup sudah mengatur teks sambutan
    composer.on("message:new_chat_members", async (ctx) => {
      const template = groupText("welcome", ctx.chat.id);
      const members = ctx.message.new_chat_members.filter((m) => !m.is_bot);
      if (!template || members.length === 0) return;

      const names = members.map((m) => `<a href="tg://user?id=${m.id}">${htmlEscape(m.first_name)}</a>`).join(", ");
      const text = htmlEscape(template)
        .replace(/\{nama\}/gi, names)
        .replace(/\{grup\}/gi, htmlEscape("title" in ctx.chat ? ctx.chat.title : "grup ini"));
      await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
    });
  },

  onLoad() {
    getDatabase().exec(`
      CREATE TABLE IF NOT EXISTS group_warns (
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chat_id, user_id)
      );
    `);
  },

  commands: [
    {
      command: "warn",
      description: `Beri peringatan (${MAX_WARNS}x = dikeluarkan)`,
      usage: "balas pesan dengan /warn [alasan]",
      access: "group_admin",
      async handler(ctx, reason) {
        const target = await pickTarget(ctx, "peringatkan");
        if (!target) return;

        const count = warnCount(ctx.chat!.id, target.id) + 1;
        const note = reason ? `\nAlasan: ${htmlEscape(reason)}` : "";

        if (count < MAX_WARNS) {
          setWarnCount(ctx.chat!.id, target.id, count);
          await reply(ctx, `⚠️ ${mention(target)} mendapat peringatan <b>${count}/${MAX_WARNS}</b>.${note}`);
          return;
        }

        try {
          await ctx.banChatMember(target.id);
          setWarnCount(ctx.chat!.id, target.id, 0);
          await reply(ctx, `🚫 ${mention(target)} dikeluarkan setelah ${MAX_WARNS} peringatan.${note}`);
        } catch {
          await reply(ctx, NEED_RIGHTS);
        }
      },
    },
    {
      command: "unwarn",
      description: "Hapus semua peringatan anggota",
      usage: "balas pesan dengan /unwarn",
      access: "group_admin",
      async handler(ctx) {
        const target = await pickTarget(ctx, "hapus peringatannya");
        if (!target) return;
        setWarnCount(ctx.chat!.id, target.id, 0);
        await reply(ctx, `✅ Peringatan ${mention(target)} dihapus.`);
      },
    },
    {
      command: "mute",
      description: "Bisukan anggota (bawaan 60 menit)",
      usage: "balas pesan dengan /mute [menit]",
      access: "group_admin",
      async handler(ctx, args) {
        const target = await pickTarget(ctx, "bisukan");
        if (!target) return;

        const minutes = Math.min(Math.max(parseInt(args, 10) || 60, 1), 7 * 24 * 60);
        try {
          await ctx.restrictChatMember(
            target.id,
            { can_send_messages: false },
            { until_date: Math.floor(Date.now() / 1000) + minutes * 60 }
          );
          await reply(ctx, `🔇 ${mention(target)} dibisukan selama ${minutes} menit.`);
        } catch {
          await reply(ctx, NEED_RIGHTS);
        }
      },
    },
    {
      command: "unmute",
      description: "Buka bisu anggota",
      usage: "balas pesan dengan /unmute",
      access: "group_admin",
      async handler(ctx) {
        const target = await pickTarget(ctx, "buka bisunya");
        if (!target) return;
        try {
          await ctx.restrictChatMember(target.id, {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
          });
          await reply(ctx, `🔊 ${mention(target)} bisa mengirim pesan lagi.`);
        } catch {
          await reply(ctx, NEED_RIGHTS);
        }
      },
    },
    {
      command: "ban",
      description: "Keluarkan dan blokir anggota",
      usage: "balas pesan dengan /ban",
      access: "group_admin",
      async handler(ctx) {
        const target = await pickTarget(ctx, "keluarkan");
        if (!target) return;
        try {
          await ctx.banChatMember(target.id);
          await reply(ctx, `🚫 ${mention(target)} dikeluarkan dari grup.`);
        } catch {
          await reply(ctx, NEED_RIGHTS);
        }
      },
    },
    {
      command: "unban",
      description: "Izinkan anggota yang diblokir masuk lagi",
      usage: "balas pesan dengan /unban",
      access: "group_admin",
      async handler(ctx) {
        const target = ctx.message?.reply_to_message?.from;
        if (!target) return reply(ctx, "ℹ️ Balas (reply) pesan lama anggota yang ingin dibuka blokirnya.");
        try {
          await ctx.unbanChatMember(target.id, { only_if_banned: true });
          await reply(ctx, `✅ ${mention(target)} boleh bergabung lagi.`);
        } catch {
          await reply(ctx, NEED_RIGHTS);
        }
      },
    },
    {
      command: "setwelcome",
      description: "Atur pesan sambutan anggota baru",
      usage: "/setwelcome <teks | off>",
      access: "group_admin",
      handler: (ctx, args) =>
        editGroupText(ctx, "welcome", args, "Sambutan", "Ubah: <code>/setwelcome Halo {nama}, selamat datang di {grup}!</code>\nHapus: <code>/setwelcome off</code>"),
    },
    {
      command: "setrules",
      description: "Atur aturan grup",
      usage: "/setrules <teks | off>",
      access: "group_admin",
      handler: (ctx, args) =>
        editGroupText(ctx, "rules", args, "Aturan", "Ubah: <code>/setrules 1. Saling menghormati ...</code>\nHapus: <code>/setrules off</code>"),
    },
    {
      command: "rules",
      description: "Tampilkan aturan grup",
      async handler(ctx) {
        const rules = groupText("rules", ctx.chat!.id);
        await reply(ctx, rules ? `📜 <b>Aturan grup</b>\n\n${htmlEscape(rules)}` : "📜 Aturan grup belum diatur. Admin bisa mengisinya dengan <code>/setrules</code>.");
      },
    },
    {
      command: "groupinfo",
      description: "Info singkat grup ini",
      async handler(ctx) {
        const [chat, members] = await Promise.all([ctx.getChat(), ctx.getChatMemberCount()]);
        await reply(
          ctx,
          `👥 <b>${htmlEscape(chat.title ?? "Grup")}</b>\n` + `ID: <code>${chat.id}</code>\n` + `Anggota: ${members}`
        );
      },
    },
  ],
};

export default groupManager;
