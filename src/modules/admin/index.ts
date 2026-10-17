import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Api, InlineKeyboard, InputFile } from "grammy";
import { BotModule, BotContext } from "../../core/engine/types";
import { registry } from "../../core/engine/registry";
import { registerBotCommands } from "../../core/bot";
import { repo } from "../../core/db/repo";
import { dbFilePath, snapshotDatabase } from "../../core/db";
import { config } from "../../core/config";
import { withTempDir } from "../../core/tools/http";
import { htmlEscape, isOwner, formatBytes, formatDate, formatDateTime } from "../../core/tools/text";
import { cb, reply, show, toast } from "../../core/tools/ui";

const NS = "adm";
const HOUR_MS = 60 * 60 * 1000;
const BACKUP_EVERY_MS = 24 * HOUR_MS;
const LAST_BACKUP_KEY = "admin:last_backup";

let backupTimer: NodeJS.Timeout | null = null;

/** Teks broadcast yang menunggu konfirmasi owner. Hanya satu broadcast berjalan pada satu waktu. */
let pendingBroadcast: string | null = null;
let broadcasting = false;

/**
 * Kirim satu per satu dengan jeda, jauh di bawah batas Telegram (30 pesan/detik),
 * agar bot tetap responsif untuk pengguna lain selama broadcast berjalan.
 */
async function runBroadcast(api: Api, ownerChat: number, text: string): Promise<void> {
  broadcasting = true;
  let sent = 0;
  let failed = 0;
  try {
    for (const userId of repo.getAllUserIds()) {
      await api.sendMessage(userId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).then(
        () => sent++,
        () => failed++
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  } finally {
    broadcasting = false;
  }
  await api
    .sendMessage(ownerChat, `📣 Broadcast selesai: ${sent} terkirim, ${failed} gagal (pengguna memblokir bot atau belum menekan Start).`)
    .catch(() => {});
}

/** Kirim salinan konsisten database ke chat owner. */
async function sendBackup(api: Api, chatId: number | string, reason: string): Promise<void> {
  await withTempDir(async (dir) => {
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `bot-${date}.db`);
    snapshotDatabase(file);

    const s = repo.getStats();
    await api.sendDocument(chatId, new InputFile(file), {
      caption:
        `💾 <b>Backup database</b> (${reason})\n` +
        `${formatBytes(fs.statSync(file).size)} · ${s.users} pengguna · ${s.imageBookmarks + s.mangaBookmarks} bookmark\n\n` +
        `Untuk memulihkan: hentikan bot, ganti <code>data/bot.db</code> dengan berkas ini, lalu jalankan lagi.`,
      parse_mode: "HTML",
    });
  });
  repo.setValue(LAST_BACKUP_KEY, String(Date.now()));
}

function userLabel(u: { id: number; username: string | null; first_name: string }): string {
  return `${htmlEscape(u.first_name)} (${u.username ? `@${htmlEscape(u.username)}` : `<code>${u.id}</code>`})`;
}

async function showPanel(ctx: BotContext): Promise<void> {
  const s = repo.getStats();
  const lastBackup = Number(repo.getValue(LAST_BACKUP_KEY)) || 0;
  const top = repo.getTopActiveUsers(5);
  const recent = repo.getRecentUsers(5);

  const text = [
    "👑 <b>Panel Admin</b>",
    "",
    `Pengguna: <b>${s.users}</b> · aktif 24 jam: <b>${s.activeToday}</b> · VIP: <b>${s.premium}</b>`,
    `Bookmark: ${s.imageBookmarks} gambar · ${s.mangaBookmarks} manga`,
    `Backup terakhir: ${formatDateTime(lastBackup)}`,
    "",
    "<b>Paling aktif</b>",
    ...top.map((u, i) => `${i + 1}. ${userLabel(u)} · ${u.usage_count}x`),
    "",
    "<b>Terakhir aktif</b>",
    ...recent.map((u) => `• ${userLabel(u)} · ${formatDateTime(u.last_seen)}`),
    "",
    "Perintah: /status · /backup · /vip · /unvip · /broadcast · /reply",
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("🔄 Segarkan", cb(NS, "panel"))
    .text("💾 Backup", cb(NS, "backup"))
    .row()
    .text("🧩 Fitur global", cb(NS, "mods"))
    .text("📊 Server", cb(NS, "status"))
    .row()
    .text("⬅️ Menu utama", cb("menu", "main"));

  await show(ctx, text, { keyboard: kb });
}

async function showGlobalModules(ctx: BotContext): Promise<void> {
  const kb = new InlineKeyboard();
  registry.features().forEach((m, i) => {
    const on = repo.isModuleEnabled("global", 0, m.meta.id, true);
    kb.text(`${on ? "✅" : "🛠️"} ${m.meta.name}`, cb(NS, "mod", m.meta.id));
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("⬅️ Panel admin", cb(NS, "panel"));

  await show(
    ctx,
    "🧩 <b>Fitur global</b>\n\n" +
      "Tekan untuk mematikan sebuah fitur bagi <b>semua pengguna</b> (mis. saat situs sumbernya bermasalah). " +
      "Fitur yang dimatikan hilang dari menu, bantuan, pengaturan, dan daftar perintah pengguna; " +
      "bila dipanggil langsung, pengguna melihat keterangan \"sedang diperbaiki\". Owner tetap bisa memakainya untuk menguji.\n\n" +
      "✅ aktif · 🛠️ dimatikan",
    { keyboard: kb }
  );
}

async function showStatus(ctx: BotContext): Promise<void> {
  const mem = process.memoryUsage();
  const up = Math.floor(process.uptime());
  const dbSize = fs.existsSync(dbFilePath()) ? fs.statSync(dbFilePath()).size : 0;

  const text = [
    "📊 <b>Status server</b>",
    "",
    `Bot menyala: ${Math.floor(up / 86400)} hari ${Math.floor((up % 86400) / 3600)} jam ${Math.floor((up % 3600) / 60)} menit`,
    `Memori bot: ${formatBytes(mem.rss)}`,
    `Database: ${formatBytes(dbSize)}`,
    `Beban CPU server (1/5/15 menit): ${os.loadavg().map((n) => n.toFixed(2)).join(" / ")} dari ${os.cpus().length} core`,
    `Memori server bebas: ${formatBytes(os.freemem())} dari ${formatBytes(os.totalmem())}`,
    `Node.js ${process.version} · ${registry.all().length} modul`,
    `Image proxy: ${config.proxy.enabled ? (config.proxy.publicUrl ? "aktif" : "aktif, tetapi PROXY_PUBLIC_URL kosong") : "mati"}`,
  ].join("\n");

  await show(ctx, text, {
    keyboard: new InlineKeyboard().text("🔄 Segarkan", cb(NS, "status")).text("⬅️ Panel admin", cb(NS, "panel")),
  });
}

/** Cari user dari argumen perintah: ID angka atau @username (harus pernah memakai bot). */
function findUser(arg: string) {
  if (/^\d+$/.test(arg)) return repo.getUser(Number(arg));
  return arg ? repo.findUserByUsername(arg) : null;
}

/** Bungkus handler tombol agar hanya owner yang bisa menjalankannya. */
function ownerOnly(handler: (ctx: BotContext, arg: string) => Promise<void>) {
  return async (ctx: BotContext, arg: string) => {
    if (!isOwner(ctx.user.id)) return toast(ctx, "Khusus pemilik bot.", true);
    await handler(ctx, arg);
  };
}

const admin: BotModule = {
  meta: {
    id: "admin",
    name: "Admin",
    emoji: "👑",
    description: "Statistik, backup database, status server, dan pengelolaan VIP (khusus pemilik bot).",
    category: "system",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
    system: true,
  },
  callbackNs: NS,
  help: [
    "Database dicadangkan otomatis ke chat owner setiap 24 jam.",
    "<code>/vip</code> dan <code>/unvip</code> menerima ID angka atau @username pengguna yang pernah memakai bot.",
    "<code>/broadcast</code> menampilkan pratinjau dan meminta konfirmasi sebelum mengirim.",
  ],

  menuButtons: [{ label: "👑 Admin", action: "panel", order: 90, visible: (ctx) => isOwner(ctx.user.id) }],

  // Owner cukup membalas (reply) pesan laporan; isinya diteruskan ke pelapor
  async onMessage(ctx) {
    const repliedTo = ctx.message?.reply_to_message;
    const text = ctx.message?.text;
    if (!text || !repliedTo || !isOwner(ctx.user.id) || repliedTo.from?.id !== ctx.me.id) return;

    const reporterId = (repliedTo.text ?? "").match(/^📬 Laporan dari .*\((\d+)\)/)?.[1];
    if (!reporterId) return;

    const sent = await ctx.api
      .sendMessage(Number(reporterId), `📬 <b>Balasan dari pemilik bot</b>\n\n${htmlEscape(text.slice(0, 3500))}`, { parse_mode: "HTML" })
      .then(() => true, () => false);
    await reply(ctx, sent ? "✅ Balasan terkirim ke pelapor." : "❌ Gagal terkirim. Pelapor memblokir bot atau belum pernah menekan Start.");
  },

  commands: [
    { command: "admin", description: "Panel admin", access: "owner", scope: "private", handler: showPanel },
    { command: "status", description: "Pemakaian memori, CPU, dan ukuran database", access: "owner", scope: "private", handler: showStatus },
    {
      command: "backup",
      description: "Kirim backup database sekarang",
      access: "owner",
      scope: "private",
      handler: (ctx) => sendBackup(ctx.api, ctx.chat!.id, "manual"),
    },
    {
      command: "vip",
      description: "Beri atau perpanjang VIP seorang pengguna",
      usage: "/vip <ID | @username> [hari]",
      access: "owner",
      async handler(ctx, args) {
        const [who, daysArg] = args.split(/\s+/);
        const user = findUser(who ?? "");
        if (!user) return reply(ctx, "ℹ️ Format: <code>/vip 123456789 30</code> atau <code>/vip @username 30</code>\nPengguna harus sudah pernah memakai bot.");

        const days = Math.min(Math.max(parseInt(daysArg, 10) || 30, 1), 3650);
        const updated = repo.extendPremium(user.id, days);
        await reply(ctx, `✅ ${userLabel(user)} mendapat VIP +${days} hari, aktif sampai ${formatDate(updated?.premium_until)}.`);
        await ctx.api
          .sendMessage(user.id, `🎁 Anda mendapat Premium VIP ${days} hari dari pemilik bot. Ketik /upgrade untuk melihat statusnya.`)
          .catch(() => {});
      },
    },
    {
      command: "broadcast",
      description: "Kirim pengumuman ke semua pengguna",
      usage: "/broadcast <teks>",
      access: "owner",
      scope: "private",
      async handler(ctx, args) {
        if (!args) return reply(ctx, "📣 Tulis pengumumannya setelah perintah:\n<code>/broadcast Fitur baru: baca komik dengan /kr</code>\n\nAnda akan melihat pratinjau dan diminta konfirmasi dulu.");
        if (broadcasting) return reply(ctx, "⏳ Broadcast lain masih berjalan. Tunggu laporannya dulu.");

        pendingBroadcast = `📣 <b>Pengumuman</b>\n\n${htmlEscape(args.slice(0, 3500))}`;
        await reply(
          ctx,
          `${pendingBroadcast}\n\n———\nPratinjau di atas akan dikirim ke <b>${repo.getStats().users}</b> pengguna. Lanjutkan?`,
          new InlineKeyboard().text("✅ Kirim", cb(NS, "bc", "go")).text("✖️ Batal", cb(NS, "bc", "no"))
        );
      },
    },
    {
      command: "reply",
      description: "Balas laporan seorang pengguna",
      usage: "/reply <ID> <pesan>",
      access: "owner",
      scope: "private",
      async handler(ctx, args) {
        const match = args.match(/^(\d+)\s+([\s\S]+)$/);
        if (!match) return reply(ctx, "ℹ️ Format: <code>/reply 123456789 Terima kasih, sudah diperbaiki.</code>\nID pengguna tertera di setiap laporan yang masuk.");

        const sent = await ctx.api
          .sendMessage(Number(match[1]), `📬 <b>Balasan dari pemilik bot</b>\n\n${htmlEscape(match[2].slice(0, 3500))}`, { parse_mode: "HTML" })
          .then(() => true, () => false);
        await reply(ctx, sent ? "✅ Balasan terkirim." : "❌ Gagal terkirim. Pengguna itu memblokir bot atau belum pernah menekan Start.");
      },
    },
    {
      command: "unvip",
      description: "Cabut VIP seorang pengguna",
      usage: "/unvip <ID | @username>",
      access: "owner",
      async handler(ctx, args) {
        const user = findUser(args.split(/\s+/)[0] ?? "");
        if (!user) return reply(ctx, "ℹ️ Format: <code>/unvip 123456789</code> atau <code>/unvip @username</code>");
        repo.revokePremium(user.id);
        await reply(ctx, `✅ VIP ${userLabel(user)} dicabut.`);
      },
    },
  ],

  callbacks: [
    {
      action: "bc",
      handler: ownerOnly(async (ctx, choice) => {
        const text = pendingBroadcast;
        pendingBroadcast = null;
        if (choice !== "go" || !text) return show(ctx, "📣 Broadcast dibatalkan.");
        if (broadcasting) return toast(ctx, "Broadcast lain masih berjalan.", true);

        await show(ctx, "📣 Broadcast dimulai. Laporan dikirim setelah selesai.");
        // Sengaja tidak ditunggu: berjalan di latar agar bot tetap melayani update lain
        runBroadcast(ctx.api, ctx.from!.id, text).catch((err) => console.warn("[admin] broadcast gagal:", err?.message ?? err));
      }),
    },
    { action: "panel", handler: ownerOnly(showPanel) },
    { action: "mods", handler: ownerOnly(showGlobalModules) },
    { action: "status", handler: ownerOnly(showStatus) },
    {
      action: "backup",
      handler: ownerOnly(async (ctx) => {
        await toast(ctx, "💾 Menyiapkan backup...");
        await sendBackup(ctx.api, ctx.from!.id, "manual");
      }),
    },
    {
      action: "mod",
      handler: ownerOnly(async (ctx, moduleId) => {
        const mod = registry.get(moduleId);
        if (!mod || mod.meta.system) return;
        const next = !repo.isModuleEnabled("global", 0, moduleId, true);
        repo.setModuleEnabled("global", 0, moduleId, next);
        await toast(ctx, `${mod.meta.name}: ${next ? "aktif untuk semua" : "dimatikan untuk semua"}`);
        // Perintahnya ikut hilang/muncul di tombol "/" Telegram
        await registerBotCommands(ctx.api);
        await showGlobalModules(ctx);
      }),
    },
  ],

  onStart({ api }) {
    if (!config.ownerId) return;

    // Diperiksa tiap jam dan dicatat di database, jadi restart tidak mengacaukan jadwal 24 jam
    const tick = () => {
      const last = Number(repo.getValue(LAST_BACKUP_KEY)) || 0;
      if (Date.now() - last < BACKUP_EVERY_MS) return;
      sendBackup(api, config.ownerId, "otomatis harian").catch((err) => {
        console.warn("[admin] backup otomatis gagal:", err?.description ?? err?.message ?? err);
      });
    };

    backupTimer = setInterval(tick, HOUR_MS);
    backupTimer.unref();
    setTimeout(tick, 60_000).unref();
  },

  onStop() {
    if (backupTimer) clearInterval(backupTimer);
  },
};

export default admin;
