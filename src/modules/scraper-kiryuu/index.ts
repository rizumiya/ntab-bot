import * as cheerio from "cheerio";
import { InlineKeyboard } from "grammy";
import { defineScraper, DefineScraperConfig, ScraperItem } from "../../core/sdk/defineScraper";
import { createMangaReader } from "../../core/sdk/mangaReader";
import { nsfwAllowed } from "../../core/engine/gate";
import { config } from "../../core/config";
import { fetchJson } from "../../core/tools/http";
import { TtlCache } from "../../core/tools/cache";
import { isMinorContent } from "../../core/tools/tags";
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
const feedCache = new TtlCache<string, { title: string; info?: string; chapters: Array<{ id: string; number: string }>; blocked?: boolean }>(
  15 * 60_000,
  30
);
const pagesCache = new TtlCache<string, { urls: string[]; mangaId?: string; number: string }>(30 * 60_000, 200);

/** Samakan ejaan nama genre: "Sci-Fi" = "sci fi", "Boys' Love" = "boys love". */
const genreKey = (name: string) => name.toLowerCase().replace(/['’]/g, "").replace(/[-_\s]+/g, " ").trim();

/** Daftar genre situs: nama (lihat `genreKey`) -> ID. */
async function getGenres(): Promise<Map<string, number>> {
  const cached = genreCache.get("genres");
  if (cached) return cached;

  const genres = new Map<string, number>();
  try {
    for (const page of [1, 2]) {
      const list = await api<Array<{ id: number; name: string }>>(`/wp/v2/genre?per_page=100&page=${page}&_fields=id,name`);
      for (const g of list) genres.set(genreKey(g.name), g.id);
      if (list.length < 100) break;
    }
    genreCache.set("genres", genres);
  } catch (err) {
    console.warn("[scraper-kiryuu] daftar genre gagal dimuat:", (err as Error).message);
  }
  return genres;
}

const isAdult = (m: KiryuuManga) => (m.metadata?.tax ?? []).some((t) => t.taxonomy === "genre" && ADULT_GENRES.has(t.slug));

/** Komik bergenre anak di bawah umur (mis. Lolicon, Shotacon) tidak ditampilkan dan tidak bisa dibaca lewat bot. */
function isBlocked(m: KiryuuManga): boolean {
  const genres = (m.metadata?.tax ?? []).filter((t) => t.taxonomy === "genre").flatMap((t) => [t.slug, t.name]);
  return isMinorContent(genres, isAdult(m));
}

/**
 * Baca deretan kata sebagai nama-nama genre, mis. "mystery horror" atau "slice of life, comedy".
 * Nama terpanjang dicoba lebih dulu. Kata yang bukan genre: dilewati bila `lenient`,
 * selain itu hasilnya null (berarti kata kunci itu sebuah judul).
 */
function genresIn(text: string, genres: Map<string, number>, lenient = false): number[] | null {
  const words = genreKey(text.replace(/[,"]/g, " ")).split(" ").filter(Boolean);
  const ids: number[] = [];
  for (let i = 0; i < words.length; ) {
    let length = Math.min(4, words.length - i);
    let id: number | undefined;
    for (; length > 0; length--) {
      id = genres.get(words.slice(i, i + length).join(" "));
      if (id !== undefined) break;
    }
    if (id === undefined) {
      if (!lenient) return null;
      i++;
      continue;
    }
    ids.push(id);
    i += length;
  }
  return [...new Set(ids)];
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
    isNsfw: isAdult(m),
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
    const feed = { title: item?.title ?? `Komik #${mangaId}`, info: item?.info, chapters, blocked: manga ? isBlocked(manga) : false };
    // Tanpa data komik, genre-nya belum terperiksa: jangan disimpan, supaya permintaan berikutnya memeriksa ulang
    if (manga) feedCache.set(mangaId, feed);
    return feed;
  },

  async getPages(chapterId) {
    const cached = pagesCache.get(chapterId);
    if (cached) return cached;

    const ch = await api<{ content?: string; number?: string; parent_id?: string | number }>(`/kiru/v1/chapter?id=${chapterId}`);
    // Penulisan tag gambar di situs tidak seragam (chapter lama memakai kutip tunggal, sebagian memakai
    // data-src), jadi isinya dibaca sebagai HTML, bukan dicocokkan dengan pola teks
    const $ = cheerio.load(ch.content ?? "");
    const found = $("img")
      .map((_, el) => ($(el).attr("data-src") || $(el).attr("src") || "").trim())
      .get()
      .filter((src) => src.startsWith("https://"));
    const urls = [...new Set(found)];
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
    "Genre: <code>/kr action</code>. Beberapa genre sekaligus: <code>/kr mystery horror</code> (komik yang punya semuanya).",
    "Judul + genre: <code>/kr academy genre: action comedy</code>. Semua kata di kanan <code>genre:</code> dibaca sebagai genre.",
    "Singkirkan genre dengan tanda minus: <code>/kr genre: romance -adult -ecchi</code>. Genre dua kata pakai tanda hubung: <code>-slice-of-life</code>.",
    "Tanpa kata kunci: komik yang baru diperbarui.",
    "Posisi baca terakhir tiap komik diingat: buka daftar chapternya lalu tekan <b>Lanjut</b>.",
    "Komik dengan banyak chapter: lompat dengan <b>⏪ 5</b> / <b>5 ⏩</b>, atau tekan <b>Cari chapter lewat inline</b> lalu ketik nomornya.",
    "Tombol <b>Mode</b> di daftar chapter: baca <b>per halaman</b>, atau <b>⚡ Telegraph</b> (satu chapter penuh dalam satu halaman, tinggal gulir).",
    "Webtoon/manhwa paling nyaman di mode Telegraph: gambar yang sangat panjang dipotong otomatis. Di mode per halaman, gambar seperti itu dikirim sebagai berkas.",
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

    // Aturan kata kunci:
    //   - "judul genre: a b c" = semua yang di kanan "genre:" adalah genre, yang di kiri adalah judul;
    //   - tanpa "genre:", kata kunci dianggap genre hanya bila SEMUA katanya nama genre ("mystery horror"),
    //     selain itu seluruhnya dicari sebagai judul;
    //   - "-genre" di posisi mana pun menyingkirkan komik bergenre itu ("genre:romance -adult").
    //     Genre dua kata ditulis dengan tanda hubung: "-slice-of-life".
    const genres = await getGenres();
    const excluded: number[] = [];
    query = query.replace(/(^|[\s,])-([^\s,]+)/g, (whole, lead: string, name: string) => {
      const id = genres.get(genreKey(name));
      if (id === undefined) return whole; // bukan genre: biarkan, pencarian judul WordPress juga memahami "-kata"
      excluded.push(id);
      return lead;
    });
    const marker = query.search(/\b(?:genre|g):/i);
    let text = (marker >= 0 ? query.slice(0, marker) : query).replace(/\s+/g, " ").trim();
    const genreIds = marker >= 0 ? genresIn(query.slice(marker).replace(/\b(?:genre|g):/gi, " "), genres, true) ?? [] : [];
    const plain = text ? genresIn(text, genres) : null;
    // Beberapa kata yang semuanya nama genre bisa juga sebuah judul ("horror game"):
    // judul yang cocok ditaruh di depan hasil genre
    const alsoTitle = plain && plain.length > 1 && page === 1 ? text : "";
    if (plain) {
      genreIds.push(...plain);
      text = "";
    }

    // Beberapa genre = komik yang memiliki semuanya (bawaan WordPress adalah "salah satu")
    const unique = [...new Set(genreIds)];
    const genreFilter =
      (unique.length > 1 ? `&genre[terms]=${unique.join(",")}&genre[operator]=AND` : unique.length === 1 ? `&genre=${unique[0]}` : "") +
      (excluded.length > 0 ? `&genre_exclude=${[...new Set(excluded)].join(",")}` : "");

    const params =
      `?per_page=${PAGE_SIZE}&page=${page}&_fields=id,link,title,excerpt,metadata` +
      (text ? `&search=${encodeURIComponent(text)}` : "&orderby=modified") +
      genreFilter;

    const fields = "_fields=id,link,title,excerpt,metadata";
    let list: KiryuuManga[];
    try {
      const [byTitle, found] = await Promise.all([
        alsoTitle ? api<KiryuuManga[]>(`/wp/v2/manga?per_page=5&${fields}&search=${encodeURIComponent(alsoTitle)}`).catch(() => []) : [],
        api<KiryuuManga[]>(`/wp/v2/manga${params}`),
      ]);
      list = [...byTitle, ...found.filter((m) => !byTitle.some((t) => t.id === m.id))];
    } catch (err) {
      // WordPress membalas 400 bila nomor halaman melewati halaman terakhir
      if (page > 1 && (err as Error).message === "HTTP 400") return { items: [], hasNextPage: false };
      throw err;
    }

    return { items: list.filter((m) => !isBlocked(m)).map(toItem), hasNextPage: list.length >= PAGE_SIZE };
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
              `• <code>/kr mystery horror</code> (genre, boleh lebih dari satu)\n\n` +
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
