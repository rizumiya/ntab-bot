import { InlineKeyboard, InputFile } from "grammy";
import { InlineQueryResultArticle } from "grammy/types";
import { BotModule, BotContext } from "../../core/engine/types";
import { getDatabase } from "../../core/db";
import { repo } from "../../core/db/repo";
import { TtlCache } from "../../core/tools/cache";
import { htmlEscape, formatDateTime } from "../../core/tools/text";
import { reply } from "../../core/tools/ui";

const MAX_LINKS_PER_CHAT = 2000;

interface Pack {
  set_name: string;
  title: string;
  sticker_count: number;
}

const db = () => getDatabase();
const packUrl = (setName: string) => `https://t.me/addstickers/${setName}`;

// Paket yang sudah diperiksa dalam 24 jam terakhir tidak ditanyakan lagi ke Telegram
const seenPacks = new TtlCache<string, true>(24 * 60 * 60_000, 2000);
const linkLogCache = new TtlCache<number, boolean>(5 * 60_000, 1000);

function searchPacks(keyword: string, limit: number): Pack[] {
  const term = `%${keyword.toLowerCase()}%`;
  return db()
    .prepare(
      "SELECT set_name, title, sticker_count FROM sticker_packs WHERE LOWER(set_name) LIKE ? OR LOWER(title) LIKE ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(term, term, limit) as unknown as Pack[];
}

/** Pencatatan tautan bersifat opt-in per grup (dinyalakan admin grup lewat /linklog on). */
function linkLogEnabled(chatId: number): boolean {
  let enabled = linkLogCache.get(chatId);
  if (enabled === undefined) {
    enabled = repo.getValue(`url-grabber:linklog:${chatId}`) === "1";
    linkLogCache.set(chatId, enabled);
  }
  return enabled;
}

async function indexStickerPack(ctx: BotContext): Promise<void> {
  const setName = ctx.message?.sticker?.set_name;
  if (!setName || seenPacks.get(setName)) return;
  seenPacks.set(setName, true);

  const known = db().prepare("SELECT 1 FROM sticker_packs WHERE set_name = ?").get(setName);
  if (known) return;

  const set = await ctx.api.getStickerSet(setName);
  db()
    .prepare("INSERT OR IGNORE INTO sticker_packs (set_name, title, sticker_count, created_at) VALUES (?, ?, ?, ?)")
    .run(setName, set.title, set.stickers.length, Date.now());
}

function logLinks(ctx: BotContext): void {
  const msg = ctx.message;
  if (!msg || !ctx.chat || ctx.chat.type === "private" || !linkLogEnabled(ctx.chat.id)) return;

  const text = msg.text ?? msg.caption ?? "";
  const urls = (msg.entities ?? msg.caption_entities ?? [])
    .map((e) => (e.type === "url" ? text.slice(e.offset, e.offset + e.length) : e.type === "text_link" ? e.url : ""))
    .filter(Boolean)
    .slice(0, 10);
  if (urls.length === 0) return;

  const insert = db().prepare("INSERT OR IGNORE INTO grabbed_links (chat_id, user_id, url, created_at) VALUES (?, ?, ?, ?)");
  let lastId = 0;
  for (const url of urls) lastId = Number(insert.run(ctx.chat.id, ctx.from!.id, url.slice(0, 500), Date.now()).lastInsertRowid) || lastId;

  // Sesekali pangkas agar tiap grup hanya menyimpan tautan terbaru
  if (lastId % 100 === 0) {
    db()
      .prepare(
        "DELETE FROM grabbed_links WHERE chat_id = ? AND id NOT IN (SELECT id FROM grabbed_links WHERE chat_id = ? ORDER BY id DESC LIMIT ?)"
      )
      .run(ctx.chat.id, ctx.chat.id, MAX_LINKS_PER_CHAT);
  }
}

const urlGrabber: BotModule = {
  meta: {
    id: "url-grabber",
    name: "Stiker & Tautan",
    emoji: "🔗",
    description: "Kumpulkan paket stiker yang lewat, dan arsipkan tautan yang dibagikan di grup.",
    category: "tool",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
  },
  help: [
    "Paket stiker tercatat otomatis saat ada yang mengirim stiker ke bot atau ke grup tempat bot berada.",
    "Arsip tautan <b>mati secara bawaan</b>. Admin grup menyalakannya dengan <code>/linklog on</code>.",
    `Tiap grup menyimpan paling banyak ${MAX_LINKS_PER_CHAT} tautan terbaru.`,
  ],

  onLoad() {
    db().exec(`
      CREATE TABLE IF NOT EXISTS sticker_packs (
        set_name TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        sticker_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grabbed_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      DELETE FROM grabbed_links WHERE id NOT IN (SELECT MIN(id) FROM grabbed_links GROUP BY chat_id, url);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique ON grabbed_links (chat_id, url);
    `);
  },

  async onMessage(ctx) {
    logLinks(ctx);
    await indexStickerPack(ctx);
  },

  inline: {
    prefix: ".st",
    description: "Cari paket stiker yang pernah dicatat bot",
    async handler(_ctx, query) {
      const packs = searchPacks(query, 25);
      if (packs.length === 0) {
        return {
          items: [
            {
              type: "article",
              id: "st_empty",
              title: "Paket stiker tidak ditemukan",
              description: "Kirim sebuah stiker ke bot agar paketnya tercatat.",
              input_message_content: { message_text: "Kirim sebuah stiker ke bot agar paketnya tercatat dan bisa dicari." },
            },
          ],
          cacheTime: 5,
        };
      }

      const items: InlineQueryResultArticle[] = packs.map((p) => ({
        type: "article",
        id: `st_${p.set_name}`.slice(0, 64),
        title: p.title,
        description: `${p.sticker_count} stiker`,
        input_message_content: {
          message_text: `🎨 <b>${htmlEscape(p.title)}</b> · ${p.sticker_count} stiker`,
          parse_mode: "HTML",
        },
        reply_markup: new InlineKeyboard().url("➕ Pasang paket", packUrl(p.set_name)),
      }));
      return { items };
    },
  },

  commands: [
    {
      command: "stickers",
      description: "Paket stiker yang baru dicatat",
      async handler(ctx) {
        const packs = searchPacks("", 10);
        if (packs.length === 0) {
          await reply(ctx, "📦 Belum ada paket stiker tercatat. Kirim sebuah stiker ke bot untuk memulai.");
          return;
        }

        const kb = new InlineKeyboard();
        for (const p of packs) kb.url(`${p.title} (${p.sticker_count})`, packUrl(p.set_name)).row();
        kb.switchInlineCurrent("🔍 Cari paket lain", ".st ");
        await reply(ctx, "📦 <b>10 paket stiker terbaru</b>\nTekan untuk memasang:", kb);
      },
    },
    {
      command: "linklog",
      description: "Nyalakan/matikan arsip tautan grup",
      usage: "/linklog on | off",
      scope: "group",
      access: "group_admin",
      async handler(ctx, args) {
        const chatId = ctx.chat!.id;
        const choice = args.toLowerCase();
        if (choice !== "on" && choice !== "off") {
          await reply(
            ctx,
            `🔗 Arsip tautan grup ini: <b>${linkLogEnabled(chatId) ? "AKTIF" : "MATI"}</b>\n` +
              `Ubah dengan <code>/linklog on</code> atau <code>/linklog off</code>.`
          );
          return;
        }
        repo.setValue(`url-grabber:linklog:${chatId}`, choice === "on" ? "1" : "0");
        linkLogCache.delete(chatId);
        await reply(
          ctx,
          choice === "on"
            ? "✅ Arsip tautan aktif. Tautan yang dibagikan di grup ini akan dicatat. Unduh dengan /links."
            : "✅ Arsip tautan dimatikan. Tautan baru tidak lagi dicatat."
        );
      },
    },
    {
      command: "links",
      aliases: ["export"],
      description: "Unduh arsip tautan grup sebagai berkas",
      scope: "group",
      access: "group_admin",
      async handler(ctx) {
        const links = db()
          .prepare("SELECT url, user_id, created_at FROM grabbed_links WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
          .all(ctx.chat!.id, MAX_LINKS_PER_CHAT) as Array<{ url: string; user_id: number; created_at: number }>;

        if (links.length === 0) {
          await reply(
            ctx,
            linkLogEnabled(ctx.chat!.id)
              ? "ℹ️ Belum ada tautan yang tercatat di grup ini."
              : "ℹ️ Arsip tautan belum dinyalakan. Aktifkan dengan <code>/linklog on</code>."
          );
          return;
        }

        const lines = links.map((l) => `${formatDateTime(l.created_at)}\t${l.user_id}\t${l.url}`);
        const file = new InputFile(Buffer.from(["Waktu\tUser ID\tTautan", ...lines].join("\n"), "utf8"), `tautan-${ctx.chat!.id}.txt`);
        await ctx.replyWithDocument(file, { caption: `📁 ${links.length} tautan terbaru dari grup ini.` });
      },
    },
  ],
};

export default urlGrabber;
