import { InlineKeyboard } from "grammy";
import { BotContext, BotModule } from "../engine/types";

/** Data tombol milik modul: `m:<ns>:<action>:<arg>`. Telegram membatasi 64 byte. */
export function cb(mod: BotModule | string, action: string, arg: string | number = ""): string {
  const ns = typeof mod === "string" ? mod : mod.callbackNs ?? mod.meta.id;
  const data = `m:${ns}:${action}:${arg}`;
  if (Buffer.byteLength(data) > 64) {
    console.warn(`[UI] Data tombol melebihi 64 byte dan akan ditolak Telegram: ${data}`);
  }
  return data;
}

export interface ShowOptions {
  keyboard?: InlineKeyboard;
  /** Paksa kirim pesan baru walau dipicu dari tombol. */
  fresh?: boolean;
}

/**
 * Tampilkan satu "layar" teks HTML.
 * Dari tombol: pesan lama diedit di tempat. Dari perintah: pesan baru dikirim.
 * Jika pesan lama tidak bisa diedit (mis. berupa foto), otomatis kirim pesan baru.
 */
export async function show(ctx: BotContext, text: string, opts: ShowOptions = {}): Promise<void> {
  const extra = {
    parse_mode: "HTML" as const,
    reply_markup: opts.keyboard,
    link_preview_options: { is_disabled: true },
  };

  if (ctx.callbackQuery && !opts.fresh) {
    try {
      await ctx.editMessageText(text, extra);
      return;
    } catch (err: any) {
      if (String(err?.description ?? "").includes("message is not modified")) return;
    }
  }

  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (chatId) await ctx.api.sendMessage(chatId, text, extra);
}

/** Notifikasi kecil (toast) atau popup (`alert`) sebagai jawaban atas penekanan tombol. */
export async function toast(ctx: BotContext, text?: string, alert = false): Promise<void> {
  if (!ctx.callbackQuery) return;
  await ctx.answerCallbackQuery(text ? { text: text.slice(0, 200), show_alert: alert } : undefined);
}

/** Balas singkat dengan HTML. */
export async function reply(ctx: BotContext, text: string, keyboard?: InlineKeyboard): Promise<void> {
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } });
}

/**
 * Pesan "sedang diproses" yang nantinya dihapus (`done`) atau diganti pesan gagal (`fail`).
 * `toChatId` mengarahkan pesan ke obrolan lain, mis. chat pribadi pengguna.
 */
export async function progress(ctx: BotContext, text: string, toChatId?: number) {
  const chatId = toChatId ?? ctx.chat?.id ?? ctx.from!.id;
  const msg = await ctx.api.sendMessage(chatId, text, { parse_mode: "HTML" });
  return {
    async update(next: string): Promise<void> {
      await ctx.api.editMessageText(chatId, msg.message_id, next, { parse_mode: "HTML" }).catch(() => {});
    },
    async done(): Promise<void> {
      await ctx.api.deleteMessage(chatId, msg.message_id).catch(() => {});
    },
    async fail(reason: string): Promise<void> {
      await ctx.api.editMessageText(chatId, msg.message_id, reason, { parse_mode: "HTML" }).catch(() => {});
    },
  };
}

/** Baris tombol halaman "◀️ 2/5 ▶️". `data(page)` membuat data tombol untuk halaman tujuan. */
export function addPager(kb: InlineKeyboard, page: number, totalPages: number, data: (page: number) => string): InlineKeyboard {
  if (totalPages <= 1) return kb;
  kb.row();
  if (page > 1) kb.text("◀️", data(page - 1));
  kb.text(`${page}/${totalPages}`, "noop");
  if (page < totalPages) kb.text("▶️", data(page + 1));
  return kb.row();
}
