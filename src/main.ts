import * as dns from "dns";
import { run } from "@grammyjs/runner";
import { config } from "./core/config";
import { closeDatabase, runDatabaseMaintenance } from "./core/db";
import { setupDnsResolver } from "./core/network/dns";
import { startImageProxy, stopImageProxy } from "./core/network/proxy";
import { registry } from "./core/engine/registry";
import { createBot, registerBotCommands } from "./core/bot";
import { cleanStaleTempDirs } from "./core/tools/http";

const DAY_MS = 24 * 60 * 60 * 1000;

process.on("unhandledRejection", (reason) => {
  console.error("[Proses] Promise gagal tanpa penanganan:", reason);
});
// Setelah exception tak tertangani, kondisi proses tidak bisa dipercaya: keluar dan biarkan systemd menyalakan ulang.
process.on("uncaughtException", (err) => {
  console.error("[Proses] Exception fatal:", err);
  process.exit(1);
});

async function start(): Promise<void> {
  if (!config.botToken) {
    console.error("BOT_TOKEN belum diisi. Salin .env.example menjadi .env lalu isi nilainya.");
    process.exit(1);
  }
  if (!config.ownerId) {
    console.warn("OWNER_ID belum diisi: panel admin dan backup otomatis tidak aktif.");
  }

  // Jalur IPv6 sebuah server bisa menggantung tanpa error (terjadi pada VPS produksi, ke Telegram).
  // Mendahulukan IPv4 membuat bot tidak bergantung pada kesehatan jalur IPv6.
  dns.setDefaultResultOrder("ipv4first");

  cleanStaleTempDirs();
  setupDnsResolver();
  await registry.loadAll();

  const bot = createBot(config.botToken);
  await bot.init();
  await bot.api.deleteWebhook();
  await registerBotCommands(bot);
  startImageProxy();

  // Jumlah update yang diproses bersamaan dibatasi agar lonjakan pemakaian tidak membebani server
  const runner = run(bot, { sink: { concurrency: config.limits.updateConcurrency } });
  console.log(`[Bot] @${bot.botInfo.username} aktif.`);

  for (const mod of registry.all()) {
    try {
      await mod.onStart?.({ api: bot.api, me: bot.botInfo });
    } catch (err) {
      console.error(`[${mod.meta.id}] onStart gagal:`, err);
    }
  }

  const maintain = () => {
    try {
      runDatabaseMaintenance();
    } catch (err) {
      console.error("[DB] Perawatan berkala gagal:", err);
    }
  };
  maintain();
  const maintenance = setInterval(maintain, DAY_MS);
  maintenance.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[Bot] Menerima ${signal}, berhenti...`);

    // Jangan menggantung selamanya bila ada handler yang macet
    setTimeout(() => process.exit(0), 10_000).unref();

    clearInterval(maintenance);
    for (const mod of registry.all()) {
      try {
        await mod.onStop?.();
      } catch {}
    }
    stopImageProxy();
    if (runner.isRunning()) await runner.stop().catch(() => {});
    closeDatabase();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((err) => {
  console.error("[Bot] Gagal memulai:", err);
  process.exit(1);
});
