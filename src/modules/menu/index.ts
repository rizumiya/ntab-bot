import { InlineKeyboard } from "grammy";
import { BotModule, BotContext, CommandDef } from "../../core/engine/types";
import { registry } from "../../core/engine/registry";
import { moduleStatus } from "../../core/engine/gate";
import { config } from "../../core/config";
import { Cooldown } from "../../core/tools/limit";
import { htmlEscape, isOwner, formatDate } from "../../core/tools/text";
import { cb, reply, show } from "../../core/tools/ui";

const NS = "menu";
const STATUS_BADGE = { on: "", off: " · ⛔ nonaktif", vip: " · 🔒 VIP", maintenance: " · 🛠️ perbaikan" };
const reportCooldown = new Cooldown(60_000);

function accountLine(ctx: BotContext): string {
  if (isOwner(ctx.user.id)) return "👑 Owner";
  if (ctx.user.tier !== "premium") return "Akun gratis";
  return ctx.user.premium_until ? `⭐ VIP sampai ${formatDate(ctx.user.premium_until)}` : "⭐ VIP";
}

/**
 * Menu dan bantuan hanya memuat fitur yang benar-benar bisa dipakai user ini sekarang:
 * fitur khusus VIP (bagi akun gratis), fitur yang ia matikan di /settings, dan fitur yang dimatikan owner
 * tidak ditampilkan. Owner tetap melihat fitur yang ia matikan untuk semua (bertanda 🛠️) agar bisa mengujinya.
 */
function usableBy(mod: BotModule, ctx: BotContext): boolean {
  const status = moduleStatus(mod, ctx);
  return status === "on" || (status === "maintenance" && isOwner(ctx.user.id));
}

/** Perintah yang boleh dilihat user ini (perintah khusus owner disembunyikan dari orang lain). */
function visibleCommands(mod: BotModule, ctx: BotContext): CommandDef[] {
  return (mod.commands ?? []).filter((c) => c.access !== "owner" || isOwner(ctx.user.id));
}

async function showMainMenu(ctx: BotContext): Promise<void> {
  const searchers = registry
    .features()
    .filter((m) => m.inline && usableBy(m, ctx))
    .map((m) => `<code>${m.inline!.prefix}</code> ${m.meta.emoji} ${htmlEscape(m.meta.name)}${STATUS_BADGE[moduleStatus(m, ctx)]}`)
    .join("\n");

  const text =
    `🤖 <b>${htmlEscape(ctx.me.first_name)}</b>\n` +
    `${htmlEscape(ctx.user.first_name)} · ${accountLine(ctx)}\n\n` +
    `<b>Cari dari chat mana pun</b>\n` +
    `Ketik <code>@${ctx.me.username}</code>, lalu salah satu awalan ini dan kata kuncinya:\n` +
    `${searchers}\n\n` +
    `Contoh: <code>@${ctx.me.username} ${config.defaultInlinePrefix} sunset</code>\n` +
    `Daftar perintah lengkap ada di <b>Bantuan</b>.`;

  const kb = new InlineKeyboard().switchInlineCurrent("🔍 Mulai mencari", "").row();
  const buttons = registry
    .all()
    .flatMap((mod) => (mod.menuButtons ?? []).map((b) => ({ ...b, mod })))
    .filter((b) => !b.visible || b.visible(ctx))
    .sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

  buttons.forEach((b, i) => {
    kb.text(b.label, cb(b.mod, b.action, b.arg ?? ""));
    if (i % 2 === 1) kb.row();
  });

  await show(ctx, text, { keyboard: kb });
}

async function showHelp(ctx: BotContext): Promise<void> {
  const me = ctx.me.username;
  const text =
    `❓ <b>Bantuan</b>\n\n` +
    `<b>Tiga cara memakai bot</b>\n` +
    `1. <b>Perintah</b>: kirim <code>/wh sunset</code> (atau <code>.wh sunset</code>) ke bot untuk menerima album.\n` +
    `2. <b>Inline</b>: di chat mana pun ketik <code>@${me} .wh sunset</code>, lalu pilih hasilnya.\n` +
    `3. <b>Tombol</b>: tiap hasil punya tombol File HD, Bookmark, dan Sumber.\n\n` +
    `Pilih fitur di bawah untuk melihat perintah dan contohnya. ` +
    `Yang tampil hanya fitur yang aktif di akun Anda; fitur lain bisa dinyalakan di /settings` +
    (ctx.user.tier === "premium" ? "." : `, dan fitur khusus VIP terbuka lewat /upgrade.`);

  const kb = new InlineKeyboard();
  const modules = registry
    .all()
    .filter((m) => m.meta.id !== NS && usableBy(m, ctx) && (visibleCommands(m, ctx).length > 0 || m.inline));
  modules.forEach((m, i) => {
    kb.text(`${m.meta.emoji} ${m.meta.name}`, cb(NS, "mod", m.meta.id));
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("⬅️ Menu utama", cb(NS, "main"));

  await show(ctx, text, { keyboard: kb });
}

async function showModuleHelp(ctx: BotContext, moduleId: string): Promise<void> {
  const mod = registry.get(moduleId);
  if (!mod || !usableBy(mod, ctx)) return showHelp(ctx);

  const ACCESS_NOTE = { all: "", group_admin: " <i>(admin grup)</i>", owner: " <i>(owner)</i>" };
  const lines = [`${mod.meta.emoji} <b>${htmlEscape(mod.meta.name)}</b>${STATUS_BADGE[moduleStatus(mod, ctx)]}`, htmlEscape(mod.meta.description)];

  const commands = visibleCommands(mod, ctx);
  if (commands.length > 0) {
    lines.push("", "<b>Perintah</b>");
    for (const c of commands) {
      lines.push(`<code>${htmlEscape(c.usage ?? `/${c.command}`)}</code>${ACCESS_NOTE[c.access ?? "all"]}`, `<blockquote>${htmlEscape(c.description)}</blockquote>`);
    }
  }
  if (mod.inline) {
    lines.push("", "<b>Inline</b> (di chat mana pun)", `<code>@${ctx.me.username} ${mod.inline.prefix} kata kunci</code>`);
  }
  if (mod.help?.length) {
    lines.push("", "<b>Catatan</b>", ...mod.help.map((h) => `• ${h}`));
  }

  const kb = new InlineKeyboard();
  if (mod.inline) kb.switchInlineCurrent(`🔍 Coba ${mod.inline.prefix}`, `${mod.inline.prefix} `).row();
  kb.text("⬅️ Bantuan", cb(NS, "help")).text("🏠 Menu utama", cb(NS, "main"));

  await show(ctx, lines.join("\n"), { keyboard: kb });
}

const menu: BotModule = {
  meta: {
    id: NS,
    name: "Menu & Bantuan",
    emoji: "🏠",
    description: "Menu utama, panduan pemakaian, dan laporan ke pemilik bot.",
    category: "system",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
    system: true,
  },

  menuButtons: [
    { label: "❓ Bantuan", action: "help", order: 80 },
    { label: "📬 Lapor ke admin", action: "report", order: 85, visible: (ctx) => !isOwner(ctx.user.id) },
  ],

  commands: [
    {
      command: "start",
      description: "Mulai memakai bot",
      listed: true,
      async handler(ctx) {
        const me = ctx.me.username;
        await reply(
          ctx,
          `👋 Halo, <b>${htmlEscape(ctx.user.first_name)}</b>!\n\n` +
            `Bot ini mencari gambar anime, wallpaper, dan manga dari banyak sumber sekaligus.\n\n` +
            `<b>Coba sekarang</b>\n` +
            `• <code>/wh sunset</code> — album wallpaper\n` +
            `• <code>/kr solo leveling</code> — cari dan baca komik\n` +
            `• <code>@${me} .wh sunset</code> — cari dari chat mana pun\n\n` +
            `Semua fitur ada di menu.`,
          new InlineKeyboard().text("🏠 Buka menu", cb(NS, "main")).text("❓ Bantuan", cb(NS, "help"))
        );
      },
    },
    { command: "menu", description: "Menu utama", listed: true, handler: showMainMenu },
    { command: "help", description: "Panduan dan daftar perintah", listed: true, handler: showHelp },
    {
      command: "report",
      description: "Kirim laporan atau saran ke pemilik bot",
      usage: "/report <pesan>",
      async handler(ctx, args) {
        if (!args) return reply(ctx, "📬 Tulis pesannya setelah perintah, contoh:\n<code>/report tombol File HD tidak merespons</code>");
        if (!config.ownerId) return reply(ctx, "ℹ️ Pemilik bot belum mengatur penerima laporan.");

        const waitSeconds = reportCooldown.hit(ctx.user.id);
        if (waitSeconds > 0) return reply(ctx, `⏳ Tunggu ${waitSeconds} detik sebelum mengirim laporan lagi.`);

        const from = ctx.user.username ? `@${ctx.user.username}` : htmlEscape(ctx.user.first_name);
        await ctx.api.sendMessage(
          config.ownerId,
          `📬 <b>Laporan</b> dari ${from} (<code>${ctx.user.id}</code>)\n\n${htmlEscape(args.slice(0, 3000))}\n\n` +
            `Balas dengan me-reply pesan ini, atau <code>/reply ${ctx.user.id} pesan Anda</code>`,
          { parse_mode: "HTML" }
        );
        await reply(ctx, "✅ Laporan terkirim. Terima kasih!");
      },
    },
  ],

  callbacks: [
    { action: "main", handler: showMainMenu },
    { action: "help", handler: showHelp },
    { action: "mod", handler: showModuleHelp },
    {
      action: "report",
      async handler(ctx) {
        await show(
          ctx,
          `📬 <b>Lapor ke admin</b>\n\n` +
            `Menemukan masalah, konten yang tidak pantas, atau punya saran? Kirim lewat perintah ini:\n\n` +
            `<code>/report tulis pesan Anda di sini</code>\n\n` +
            `Pesan diteruskan ke pemilik bot bersama ID Anda, dan balasannya dikirim ke chat ini.`,
          { keyboard: new InlineKeyboard().text("⬅️ Menu utama", cb(NS, "main")) }
        );
      },
    },
  ],
};

export default menu;
