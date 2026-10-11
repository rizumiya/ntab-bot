import { InlineKeyboard } from "grammy";
import { defineScraper, DefineScraperConfig, ScraperItem } from "../../core/sdk/defineScraper";
import { createMangaReader } from "../../core/sdk/mangaReader";
import { nsfwAllowed } from "../../core/engine/gate";
import { config } from "../../core/config";
import { fetchJson } from "../../core/tools/http";
import { TtlCache } from "../../core/tools/cache";
import { htmlEscape, htmlToText, truncate } from "../../core/tools/text";
import { cb, progress, reply } from "../../core/tools/ui";

/**
 * Kiryuu memakai WordPress; datanya diambil lewat REST API bawaan situs (JSON), bukan dari halaman HTML.
 * ID manga dan chapter berupa angka.
 */
const NS = "kr";
const SITE = config.kiryuuUrl;
const PAGE_SIZE = 10;
const ADULT_GENRES = new Set(["adult", "mature", "smut", "hentai"]);

interface KiryuuManga {
  id: number;
  link: string;
  title: { rendered: string };
  excerpt?: { rendered: string };
  metadata?: {
    meta?: { thumbnail?: string; score?: string };
    tax?: Array<{ taxonomy: string; name: string; slug: string }>;
  };
}

const api = <T>(pathAndQuery: string) => fetchJson<T>(`${SITE}/wp-json${pathAndQuery}`, { timeoutMs: 15_000 });

// ============================================================================
// DATA
// ============================================================================
const genreCache = new TtlCache<"genres", Map<string, number>>(24 * 60 * 60_000, 1);
const feedCache = new TtlCache<string, { title: string; info?: string; chapters: Array<{ id: string; number: string }> }>(15 * 60_000, 30);
const pagesCache = new TtlCache<string, { urls: string[]; mangaId?: string; number: string }>(30 * 60_000, 200);

/** Daftar genre situs: nama (huruf kecil) -> ID. */
async function getGenres(): Promise<Map<string, number>> {
  const cached = genreCache.get("genres");
  if (cached) return cached;

  const genres = new Map<string, number>();
  try {
    for (const page of [1, 2]) {
      const list = await api<Array<{ id: number; name: string }>>(`/wp/v2/genre?per_page=100&page=${page}&_fields=id,name`);
      for (const g of list) genres.set(g.name.toLowerCase(), g.id);
      if (list.length < 100) break;
    }
    genreCache.set("genres", genres);
  } catch (err) {
    console.warn("[scraper-kiryuu] daftar genre gagal dimuat:", (err as Error).message);
  }
  return genres;
}

function toItem(m: KiryuuManga): ScraperItem {
  const tax = m.metadata?.tax ?? [];
  const names = (taxonomy: string) => tax.filter((t) => t.taxonomy === taxonomy).map((t) => t.name);
  const genres = names("genre").slice(0, 5).join(", ");
  const facts = [...names("type"), ...names("status")].join(" · ");
  const score = m.metadata?.meta?.score;
  const synopsis = htmlToText(m.excerpt?.rendered ?? "");

  return {
    id: String(m.id),
    title: htmlToText(m.title.rendered),
    thumbnailUrl: m.metadata?.meta?.thumbnail ?? "",
    directHdUrl: m.metadata?.meta?.thumbnail,
    postUrl: m.link,
    isNsfw: tax.some((t) => t.taxonomy === "genre" && ADULT_GENRES.has(t.slug)),
    info:
      [facts, score ? `⭐ ${score}` : ""].filter(Boolean).map(htmlEscape).join(" · ") +
      (genres ? `\n🏷️ ${htmlEscape(genres)}` : "") +
      (synopsis ? `\n\n<i>${htmlEscape(truncate(synopsis, 260))}</i>` : ""),
  };
}

const reader = createMangaReader({
  ns: NS,
  siteName: "Kiryuu",
  searchPrefix: ".kr",
  idPattern: /^\d{1,12}$/,
  mangaUrl: (mangaId) => `${SITE}/?p=${mangaId}`,

  async getFeed(mangaId) {
    const cached = feedCache.get(mangaId);
    if (cached) return cached;

    // Endpoint yang dipakai halaman web sendiri: seluruh chapter dalam satu jawaban kecil.
    // (REST `/kiru/v1/chapter?parent_id=` hanya memberi 10 chapter terbaru, jadi tidak dipakai.)
    const [list, manga] = await Promise.all([
      fetchJson<{ data?: Array<{ url: string }> }>(`${SITE}/wp-admin/admin-ajax.php?manga_id=${mangaId}&action=get_chapters`, {
        timeoutMs: 15_000,
      }),
      api<KiryuuManga>(`/wp/v2/manga/${mangaId}?_fields=id,link,title,metadata`).catch(() => null),
    ]);

    // Tautan chapter berbentuk ".../chapter-<nomor>.<id>/"
    const chapters = (list.data ?? [])
      .map((c) => c.url.match(/\/chapter-([\d.]+)\.(\d+)\/?$/))
      .filter((m) => m !== null)
      .map((m) => ({ id: m[2], number: m[1] }))
      .sort((a, b) => (parseFloat(a.number) || 0) - (parseFloat(b.number) || 0));

    const item = manga ? toItem(manga) : undefined;
    const feed = { title: item?.title ?? `Komik #${mangaId}`, info: item?.info, chapters };
    feedCache.set(mangaId, feed);
    return feed;
  },

  async getPages(chapterId) {
    const cached = pagesCache.get(chapterId);
    if (cached) return cached;

    const ch = await api<{ content?: string; number?: string; parent_id?: string | number }>(`/kiru/v1/chapter?id=${chapterId}`);
    const urls = [...(ch.content ?? "").matchAll(/<img[^>]+src="(https:\/\/[^"]+)"/g)].map((m) => m[1]);
    if (urls.length === 0) return null;

    const pages = { urls, mangaId: ch.parent_id ? String(ch.parent_id) : undefined, number: String(ch.number ?? "?") };
    pagesCache.set(chapterId, pages);
    return pages;
  },
});

// ============================================================================
// MODUL
// ============================================================================
const kiryuuConfig: DefineScraperConfig = {
  meta: {
    id: "scraper-kiryuu",
    name: "Kiryuu",
    emoji: "📚",
    description: "Manga, manhwa, dan manhua berbahasa Indonesia; baca langsung di Telegram.",
    category: "manga",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "1.1.0",
  },
  prefix: ".kr",
  display: "article",
  bookmarks: {
    category: "manga",
    openButton: { label: "📖 Baca", action: "read" },
    resolve: (itemId) => ({ postUrl: `${SITE}/?p=${itemId}` }),
  },
  help: [
    "Judul: <code>/kr solo leveling</code>",
    "Genre: <code>/kr genre:action</code>, atau cukup <code>/kr action</code>",
    "Tanpa kata kunci: komik yang baru diperbarui.",
    "Posisi baca terakhir tiap komik diingat: buka daftar chapternya lalu tekan <b>Lanjut</b>.",
    "Komik dengan banyak chapter: lompat dengan <b>⏪ 5</b> / <b>5 ⏩</b>, atau tekan <b>Cari chapter lewat inline</b> lalu ketik nomornya.",
    "Halaman webtoon yang sangat panjang dikirim sebagai berkas; ketuk untuk membukanya.",
  ],

  itemKeyboard: (item, query) =>
    reader.chapterKeyboard(item) ??
    new InlineKeyboard()
      .text("📖 Baca", cb(NS, "read", item.id))
      .text("💾 Bookmark", cb(NS, "fav", item.id))
      .row()
      .url("🔗 Kiryuu", item.postUrl)
      .switchInlineCurrent("🔄 Cari lagi", `.kr ${query}`.trim()),

  async search(query, page) {
    // "ch:<id komik> [nomor]": daftar chapter sebagai hasil inline
    const chapterList = await reader.searchChapters(query, page);
    if (chapterList) return chapterList;

    let text = query.trim();
    let genreId: number | undefined;

    const explicit = text.match(/\b(?:genre|g):(?:"([^"]+)"|(\S+))/i);
    const genreName = (explicit ? explicit[1] || explicit[2] : text).toLowerCase();
    if (genreName) {
      genreId = (await getGenres()).get(genreName);
      if (explicit) text = text.replace(explicit[0], "").trim();
      else if (genreId) text = "";
    }

    const params =
      `?per_page=${PAGE_SIZE}&page=${page}&_fields=id,link,title,excerpt,metadata` +
      (text ? `&search=${encodeURIComponent(text)}` : "&orderby=modified") +
      (genreId ? `&genre=${genreId}` : "");

    let list: KiryuuManga[];
    try {
      list = await api<KiryuuManga[]>(`/wp/v2/manga${params}`);
    } catch (err) {
      // WordPress membalas 400 bila nomor halaman melewati halaman terakhir
      if (page > 1 && (err as Error).message === "HTTP 400") return { items: [], hasNextPage: false };
      throw err;
    }

    return { items: list.map(toItem), hasNextPage: list.length === PAGE_SIZE };
  },

  async getMetadata(postId) {
    const m = await api<KiryuuManga>(`/wp/v2/manga/${postId}?_fields=id,link,title,metadata`);
    return { title: htmlToText(m.title.rendered), thumbUrl: m.metadata?.meta?.thumbnail, postUrl: m.link };
  },

  getPostUrl: (postId) => `${SITE}/?p=${postId}`,
  callbacks: reader.callbacks,

  commands: [
    {
      command: "kr",
      aliases: ["komik", "manga"],
      description: "Cari komik berbahasa Indonesia dan baca di Telegram",
      usage: "/kr <judul | genre>",
      listed: true,
      async handler(ctx, args) {
        if (!args) {
          await reply(
            ctx,
            `📚 <b>Kiryuu</b> · komik berbahasa Indonesia\n\n` +
              `Ketik judul atau genre setelah perintah:\n` +
              `• <code>/kr solo leveling</code>\n` +
              `• <code>/kr genre:action</code>\n\n` +
              `Atau tekan tombol di bawah untuk mencari sambil melihat sampulnya.`,
            new InlineKeyboard().switchInlineCurrent("🔍 Cari komik", ".kr ")
          );
          return;
        }

        const wait = await progress(ctx, `🔍 Mencari komik: <code>${htmlEscape(args)}</code>`);
        try {
          const nsfw = nsfwAllowed(ctx);
          const found = await kiryuuConfig.search(args, 1, { nsfw });
          const items = found.items.filter((item) => nsfw || !item.isNsfw);
          const top = items[0];
          if (!top) {
            return await wait.fail(`❌ Tidak ada komik untuk <code>${htmlEscape(args)}</code>. Coba judul lain atau ejaan bahasa Inggrisnya.`);
          }

          const kb = new InlineKeyboard()
            .text("📖 Baca", cb(NS, "read", top.id))
            .text("💾 Bookmark", cb(NS, "fav", top.id))
            .row()
            .url("🔗 Kiryuu", top.postUrl);
          if (items.length > 1) kb.switchInlineCurrent(`🔎 ${items.length - 1}+ hasil lain`, `.kr ${args}`);

          const caption = truncate(`📚 <b>${htmlEscape(top.title)}</b>\n${top.info ?? ""}`, 1000);
          await wait.done();
          if (top.thumbnailUrl) {
            await ctx.replyWithPhoto(top.thumbnailUrl, { caption, parse_mode: "HTML", reply_markup: kb }).catch(() => reply(ctx, caption, kb));
          } else {
            await reply(ctx, caption, kb);
          }
        } catch (err) {
          console.warn("[scraper-kiryuu] /kr gagal:", (err as Error).message);
          await wait.fail("❌ Kiryuu sedang tidak bisa dihubungi. Coba lagi nanti.");
        }
      },
    },
  ],
};

export default defineScraper(kiryuuConfig);
