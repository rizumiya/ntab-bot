import * as path from "path";
import { InlineKeyboard, InputFile } from "grammy";
import { BotContext, CallbackDef } from "../engine/types";
import { downloadToFile, withTempDir } from "../tools/http";
import { TG_PHOTO_MAX } from "../tools/media";
import { htmlEscape } from "../tools/text";
import { cb, reply, show, toast } from "../tools/ui";
import type { ScraperItem, ScraperSearchResult } from "./defineScraper";

export interface ReaderChapter {
  id: string;
  number: string;
  /** Penanda kecil di depan nomor, mis. bendera bahasa. */
  badge?: string;
}

export interface ReaderFeed {
  title: string;
  /** Baris keterangan (HTML) di bawah judul: tipe, status, genre. */
  info?: string;
  /** Urut naik (chapter pertama di awal). */
  chapters: ReaderChapter[];
}

export interface ReaderPages {
  /** URL gambar tiap halaman, yang bisa diambil langsung oleh Telegram. */
  urls: string[];
  mangaId?: string;
  number: string;
}

export interface ReaderSource {
  /** Awalan data tombol modul (`callbackNs`). */
  ns: string;
  siteName: string;
  /** Prefix inline modul, mis. ".kr", untuk tombol "Cari komik lain". */
  searchPrefix: string;
  /** Bentuk ID yang sah; data tombol di luar pola ini diabaikan. */
  idPattern: RegExp;
  mangaUrl: (mangaId: string) => string;
  /** Wajib di-cache oleh sumber: dipanggil di setiap pergantian halaman. */
  getFeed: (mangaId: string) => Promise<ReaderFeed>;
  /** Mengembalikan null bila chapter tidak bisa dibaca. Wajib di-cache oleh sumber. */
  getPages: (chapterId: string) => Promise<ReaderPages | null>;
}

const CHAPTERS_PER_PAGE = 12;

/**
 * Pembaca manga di dalam chat: daftar chapter, navigasi halaman, lanjut ke chapter berikutnya,
 * dan "lanjut baca" (posisi terakhir tiap manga diingat per pengguna).
 *
 * Tombol yang disediakan: `read` (arg "<id manga>[:<halaman daftar>]"),
 * `p` (arg "<id chapter>:<indeks halaman>"), dan `close`.
 */
export function createMangaReader(source: ReaderSource) {
  const { ns } = source;
  const progressKey = (mangaId: string) => `read:${ns}:${mangaId}`;

  async function showChapterList(ctx: BotContext, mangaId: string, page?: number): Promise<void> {
    // Notifikasi mengambang muncul seketika, sementara daftar chapter diambil dari situs sumber
    await toast(ctx, "📖 Memuat daftar chapter...");

    let feed: ReaderFeed;
    try {
      feed = await source.getFeed(mangaId);
    } catch {
      // Tombol sudah dijawab oleh notifikasi di atas, jadi kegagalan dikabarkan lewat pesan
      const chatId = ctx.chat?.id ?? ctx.from?.id;
      if (chatId) {
        await ctx.api.sendMessage(chatId, `❌ ${source.siteName} sedang tidak bisa dihubungi. Coba lagi nanti.`).catch(() => {});
      }
      return;
    }

    if (feed.chapters.length === 0) {
      await show(ctx, `📖 <b>${htmlEscape(feed.title)}</b>\n\nBelum ada chapter yang bisa dibaca di sini.`, {
        keyboard: new InlineKeyboard().url(`🔗 Buka di ${source.siteName}`, source.mangaUrl(mangaId)),
      });
      return;
    }

    // Posisi terakhir pengguna di manga ini: "<id chapter>:<indeks halaman>"
    const [savedChapter, savedPage] = ctx.db.getUserSetting(ctx.user.id, progressKey(mangaId)).split(":");
    const savedIndex = feed.chapters.findIndex((c) => c.id === savedChapter);

    const totalPages = Math.ceil(feed.chapters.length / CHAPTERS_PER_PAGE);
    // Tanpa nomor halaman: buka bagian daftar yang memuat chapter terakhir dibaca
    const fallbackPage = savedIndex >= 0 ? Math.floor(savedIndex / CHAPTERS_PER_PAGE) + 1 : 1;
    const current = Math.min(Math.max(1, page ?? fallbackPage), totalPages);
    const slice = feed.chapters.slice((current - 1) * CHAPTERS_PER_PAGE, current * CHAPTERS_PER_PAGE);

    const kb = new InlineKeyboard();
    if (savedIndex >= 0) {
      const ch = feed.chapters[savedIndex];
      kb.text(`▶️ Lanjut Ch. ${ch.number} hal. ${(parseInt(savedPage, 10) || 0) + 1}`, cb(ns, "p", `${ch.id}:${savedPage || 0}`)).row();
    }
    slice.forEach((ch, i) => {
      const mark = ch.id === savedChapter ? "• " : ch.badge ? `${ch.badge} ` : "";
      kb.text(`${mark}Ch. ${ch.number}`, cb(ns, "p", `${ch.id}:0`));
      if (i % 3 === 2) kb.row();
    });
    kb.row();

    // Navigasi daftar: lompat 5 halaman, mundur, posisi, maju, lompat 5 halaman
    if (totalPages > 1) {
      const to = (p: number) => cb(ns, "read", `${mangaId}:${p}`);
      if (current > 5) kb.text("⏪ 5", to(current - 5));
      if (current > 1) kb.text("◀️", to(current - 1));
      kb.text(`${current}/${totalPages}`, "noop");
      if (current < totalPages) kb.text("▶️", to(current + 1));
      if (current + 5 <= totalPages) kb.text("5 ⏩", to(current + 5));
      kb.row();
      if (totalPages > 2) kb.text("⏮️ Awal", to(1)).text("Terbaru ⏭️", to(totalPages)).row();
      kb.switchInlineCurrent("📚 Cari chapter lewat inline", `${source.searchPrefix} ch:${mangaId}`).row();
    }
    kb.text("💾 Bookmark", cb(ns, "fav", mangaId)).url(`🔗 ${source.siteName}`, source.mangaUrl(mangaId)).row();
    kb.switchInlineCurrent("🔎 Cari komik lain", `${source.searchPrefix} `).text("✖️ Tutup", cb(ns, "close"));

    const first = feed.chapters[0].number;
    const last = feed.chapters[feed.chapters.length - 1].number;
    await show(
      ctx,
      `📖 <b>${htmlEscape(feed.title)}</b>\n` +
        (feed.info ? `${feed.info}\n` : "") +
        `\n${feed.chapters.length} chapter (Ch. ${htmlEscape(first)} sampai ${htmlEscape(last)})` +
        (totalPages > 1 ? ` · halaman ${current}/${totalPages}` : "") +
        `\nPilih chapter untuk mulai membaca:`,
      { keyboard: kb }
    );
  }

  async function showPage(ctx: BotContext, chapterId: string, pageIndex: number): Promise<void> {
    const pages = await source.getPages(chapterId).catch(() => null);
    if (!pages || pages.urls.length === 0) {
      await notify(ctx, `Chapter ini tidak bisa dibuka di Telegram. Baca langsung di ${source.siteName}.`);
      return;
    }

    const total = pages.urls.length;
    const index = Math.min(Math.max(0, pageIndex), total - 1);
    const url = pages.urls[index];
    const feed = pages.mangaId ? await source.getFeed(pages.mangaId).catch(() => undefined) : undefined;
    const caption = `📖 <b>${htmlEscape(feed?.title ?? "Manga")}</b> · Ch. ${htmlEscape(pages.number)} · hal. ${index + 1}/${total}`;

    const go = (i: number) => cb(ns, "p", `${chapterId}:${i}`);
    const kb = new InlineKeyboard();
    if (index >= 5) kb.text("⏪ 5", go(index - 5));
    if (index > 0) kb.text("◀️", go(index - 1));
    kb.text(`${index + 1}/${total}`, "noop");
    if (index < total - 1) kb.text("▶️", go(index + 1));
    if (index + 5 < total) kb.text("5 ⏩", go(index + 5));
    kb.row();

    const position = feed?.chapters.findIndex((c) => c.id === chapterId) ?? -1;
    const nextChapter = position >= 0 ? feed!.chapters[position + 1] : undefined;
    if (index === total - 1 && nextChapter) {
      kb.text(`Lanjut Ch. ${nextChapter.number} ▶️`, cb(ns, "p", `${nextChapter.id}:0`)).row();
    }
    if (pages.mangaId) kb.text("📚 Chapter", cb(ns, "read", pages.mangaId));
    kb.text("✖️ Tutup", cb(ns, "close"));

    if (pages.mangaId) ctx.db.setUserSetting(ctx.user.id, progressKey(pages.mangaId), `${chapterId}:${index}`);

    const current = ctx.callbackQuery?.message;
    const chatId = ctx.chat?.id ?? ctx.from!.id;
    const options = { caption, parse_mode: "HTML" as const, reply_markup: kb };

    // Sudah di mode baca: ganti gambarnya di tempat
    if (current && (("photo" in current && current.photo) || ("document" in current && current.document))) {
      for (const type of ["photo", "document"] as const) {
        try {
          await ctx.editMessageMedia({ type, media: url, caption, parse_mode: "HTML" }, { reply_markup: kb });
          return;
        } catch (err: any) {
          if (String(err?.description ?? "").includes("message is not modified")) return;
        }
      }
    }

    try {
      await sendPageImage(ctx, chatId, url, options);
      // Daftar chapter (pesan teks) diganti oleh halaman pembaca
      if (current && ctx.chat) await ctx.deleteMessage().catch(() => {});
    } catch (err: any) {
      await notify(
        ctx,
        err?.error_code === 403
          ? `Buka chat @${ctx.me.username} dan tekan Start dulu, lalu coba lagi.`
          : "Halaman gagal dimuat. Coba lagi sebentar lagi."
      );
    }
  }

  const callbacks: CallbackDef[] = [
    {
      action: "read",
      async handler(ctx, arg) {
        const [mangaId, page] = arg.split(":");
        if (source.idPattern.test(mangaId)) await showChapterList(ctx, mangaId, parseInt(page, 10) || undefined);
      },
    },
    {
      action: "p",
      async handler(ctx, arg) {
        const [chapterId, index] = arg.split(":");
        if (source.idPattern.test(chapterId)) await showPage(ctx, chapterId, parseInt(index, 10) || 0);
      },
    },
    {
      action: "close",
      async handler(ctx) {
        if (ctx.callbackQuery?.inline_message_id) await show(ctx, "<i>Ditutup.</i>");
        else await ctx.deleteMessage().catch(() => {});
      },
    },
  ];

  const chapterItems = new WeakSet<ScraperItem>();

  /**
   * Daftar chapter sebagai hasil inline, untuk kata kunci "ch:<id manga> [nomor]".
   * Mengembalikan null bila kata kuncinya bukan permintaan daftar chapter.
   */
  async function searchChapters(query: string, page: number): Promise<ScraperSearchResult | null> {
    const match = query.trim().match(/^ch:(\S+)\s*(.*)$/i);
    if (!match) return null;
    const [, mangaId, filter] = match;
    if (!source.idPattern.test(mangaId)) return { items: [], hasNextPage: false };

    const feed = await source.getFeed(mangaId);
    // Terbaru di atas; angka setelah ID menyaring nomor chapter (mis. "ch:123 15")
    const chapters = [...feed.chapters].reverse().filter((c) => !filter || c.number.startsWith(filter.trim()));
    const start = (page - 1) * 30;

    const items = chapters.slice(start, start + 30).map((c): ScraperItem => {
      const item: ScraperItem = {
        id: c.id,
        title: `Ch. ${c.number}`,
        thumbnailUrl: "",
        postUrl: source.mangaUrl(mangaId),
        info: htmlEscape(feed.title),
      };
      chapterItems.add(item);
      return item;
    });
    return { items, hasNextPage: start + 30 < chapters.length };
  }

  /** Tombol untuk item hasil `searchChapters`; null bila item itu bukan chapter. */
  function chapterKeyboard(item: ScraperItem): InlineKeyboard | null {
    if (!chapterItems.has(item)) return null;
    return new InlineKeyboard().text("📖 Baca chapter ini", cb(ns, "p", `${item.id}:0`)).url(`🔗 ${source.siteName}`, item.postUrl);
  }

  return { callbacks, showChapterList, showPage, searchChapters, chapterKeyboard };
}

/** Popup bila dipicu tombol, pesan biasa bila dipicu perintah. */
async function notify(ctx: BotContext, message: string): Promise<void> {
  if (ctx.callbackQuery) await toast(ctx, message, true);
  else await reply(ctx, `❌ ${htmlEscape(message)}`);
}

/**
 * Kirim satu halaman. Urutan upaya, dari yang paling ringan bagi server:
 * 1. foto lewat URL (Telegram yang mengunduh),
 * 2. dokumen lewat URL (untuk halaman webtoon yang terlalu panjang bagi foto Telegram),
 * 3. unduh lewat bot lalu unggah.
 */
async function sendPageImage(
  ctx: BotContext,
  chatId: number,
  url: string,
  options: { caption: string; parse_mode: "HTML"; reply_markup: InlineKeyboard }
): Promise<void> {
  try {
    await ctx.api.sendPhoto(chatId, url, options);
    return;
  } catch (err: any) {
    if (err?.error_code === 403) throw err;
  }
  try {
    await ctx.api.sendDocument(chatId, url, options);
    return;
  } catch {}

  await withTempDir(async (dir) => {
    const file = path.join(dir, `halaman${path.extname(new URL(url).pathname).slice(0, 6) || ".jpg"}`);
    await downloadToFile(url, file, { maxBytes: TG_PHOTO_MAX, timeoutMs: 20_000 });
    await ctx.api.sendDocument(chatId, new InputFile(file), options);
  });
}
