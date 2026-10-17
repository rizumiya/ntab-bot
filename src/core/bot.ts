import { Api, Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { BotContext } from "./engine/types";
import { repo } from "./db/repo";
import { registry } from "./engine/registry";
import { isGloballyEnabled } from "./engine/gate";
import { createRouter } from "./engine/router";
import { debug } from "./tools/text";

/**
 * Rakit bot: middleware dasar + router. Tidak ada fitur di sini;
 * semua perintah, menu, dan tombol berasal dari modul di `src/modules/`.
 */
export function createBot(token: string): Bot<BotContext> {
  // Tanpa batas waktu, satu permintaan ke Telegram yang menggantung membuat bot diam selamanya.
  // 60 detik aman di atas long polling (30 detik); bila terlampaui, permintaan gagal dan dicoba lagi.
  const bot = new Bot<BotContext>(token, { client: { timeoutSeconds: 60 } });

  // Ulangi otomatis saat terkena rate limit Telegram, tetapi jangan menunggu terlalu lama
  bot.api.config.use(autoRetry({ maxRetryAttempts: 2, maxDelaySeconds: 30 }));

  bot.use(async (ctx, next) => {
    if (!ctx.from) return; // update tanpa pengirim (mis. posting channel) tidak dilayani
    ctx.db = repo;
    ctx.user = repo.touchUser(ctx.from);

    debug(
      `[update] ${ctx.from.id} ` +
        (ctx.inlineQuery ? `inline "${ctx.inlineQuery.query}"` : ctx.callbackQuery ? `tombol "${ctx.callbackQuery.data}"` : "pesan")
    );
    await next();
  });

  bot.use(createRouter());

  bot.catch((err) => {
    const e = err.error as any;
    console.error(`[Bot] Error pada update ${err.ctx.update.update_id}:`, e?.description ?? e?.message ?? e);
  });

  return bot;
}

/**
 * Isi tombol "/" Telegram dari perintah modul yang bertanda `listed`.
 * Perintah fitur yang dimatikan owner tidak didaftarkan; panggil ulang setelah status fitur global berubah.
 */
export async function registerBotCommands(api: Api): Promise<void> {
  const commands = registry
    .all()
    .filter(isGloballyEnabled)
    .flatMap((mod) => mod.commands ?? [])
    .filter((c) => c.listed)
    .map((c) => ({ command: c.command, description: c.description.slice(0, 256) }));

  try {
    await api.setMyCommands(commands);
  } catch (err) {
    console.warn("[Bot] Gagal mendaftarkan daftar perintah:", (err as Error).message);
  }
}
