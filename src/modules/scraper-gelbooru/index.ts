import * as cheerio from "cheerio";
import { defineScraper, ScraperItem, ScraperSearchResult } from "../../core/sdk/defineScraper";
import { config } from "../../core/config";
import { fetchJson, fetchText } from "../../core/tools/http";
import { htmlEscape } from "../../core/tools/text";
import { TtlCache } from "../../core/tools/cache";
import { proxied } from "../../core/network/proxy";

/**
 * Dua jalur pencarian:
 *   1. JSON API resmi (cepat; butuh GELBOORU_USER_ID dan GELBOORU_API_KEY di .env).
 *   2. Halaman HTML (tanpa akun, lebih lambat), dipakai bila kunci kosong atau API gagal.
 *
 * Gelbooru menolak pengambilan gambar tanpa Referer, jadi semua URL untuk Telegram dilewatkan `proxied()`.
 */

const SITE = "https://gelbooru.com/index.php";
const API_PAGE_SIZE = 50;
const HTML_PAGE_SIZE = 42;

const postUrl = (id: string) => `${SITE}?page=post&s=view&id=${id}`;
const isNsfwRating = (rating: string) => rating === "explicit" || rating === "questionable";
const extOf = (url: string) => url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";

/** Tambahkan penanda posisi: halaman berikutnya meminta "ID lebih kecil dari gambar terakhir". */
function withCursor(tags: string, cursor?: string): { tags: string; useCursor: boolean } {
  const useCursor = Boolean(cursor) && !tags.includes("sort:");
  return { tags: useCursor ? `${tags} id:<${cursor}` : tags, useCursor };
}

function lowestId(items: ScraperItem[]): string | undefined {
  const min = items.reduce((m, item) => Math.min(m, Number(item.id)), Infinity);
  return Number.isFinite(min) ? String(min) : undefined;
}

/** Tombol pintas dari kolom "source": karya yang bersumber dari Pixiv bisa dibuka paketnya di .px. */
function sourceShortcut(source: string): ScraperItem["shortcuts"] {
  const pixivId = source.match(/pixiv\.net\/(?:\w+\/)?artworks\/(\d+)|illust_id=(\d+)/);
  const id = pixivId?.[1] ?? pixivId?.[2];
  return id ? [{ label: "🎨 Buka di .px", query: `.px ${id}` }] : undefined;
}

async function searchApi(rawTags: string, page: number, cursor?: string): Promise<ScraperSearchResult | null> {
  const { userId, apiKey } = config.gelbooru;
  if (!userId || !apiKey) return null;

  const { tags, useCursor } = withCursor(rawTags, cursor);
  const json = await fetchJson<{ post?: Array<Record<string, any>> | Record<string, any> }>(
    `${SITE}?page=dapi&s=post&q=index&json=1&limit=${API_PAGE_SIZE}&pid=${useCursor ? 0 : Math.max(0, page - 1)}` +
      `&tags=${encodeURIComponent(tags)}&user_id=${encodeURIComponent(userId)}&api_key=${encodeURIComponent(apiKey)}`,
    // Telegram hanya menunggu jawaban inline beberapa detik; lebih baik cepat gagal lalu memakai jalur HTML
    { timeoutMs: 5000 }
  );
  const posts = Array.isArray(json.post) ? json.post : json.post ? [json.post] : [];

  const items: ScraperItem[] = [];
  for (const p of posts) {
    const id = String(p.id);
    const rating = String(p.rating || "general");
    const fileUrl = String(p.file_url || "");
    const ext = extOf(fileUrl);
    const hasSample = Boolean(p.sample_url) && Number(p.sample) === 1;
    // Telegram hanya memutar MP4 di mode inline; WebM dilewati
    if (!fileUrl || ext === "webm") continue;

    const media = ext === "mp4" ? "video" : ext === "gif" ? "gif" : "photo";
    const shown = media === "photo" && hasSample ? String(p.sample_url) : fileUrl;

    items.push({
      id,
      title: `Gelbooru #${id}`,
      thumbnailUrl: proxied(String(p.preview_url || fileUrl)),
      inlineUrl: proxied(shown),
      directHdUrl: fileUrl,
      media,
      width: Number(hasSample && media === "photo" ? p.sample_width : p.width) || undefined,
      height: Number(hasSample && media === "photo" ? p.sample_height : p.height) || undefined,
      postUrl: postUrl(id),
      isNsfw: isNsfwRating(rating),
      info: `📊 ${htmlEscape(rating)} · ⭐ ${htmlEscape(p.score ?? 0)} · 📐 ${Number(p.width) || "?"}x${Number(p.height) || "?"}`,
      tags: String(p.tags || "").split(/\s+/).filter(Boolean),
      shortcuts: sourceShortcut(String(p.source || "")),
    });
  }

  return { items, hasNextPage: posts.length >= API_PAGE_SIZE, nextCursor: lowestId(items) };
}

async function searchHtml(rawTags: string, page: number, cursor?: string): Promise<ScraperSearchResult> {
  const { tags, useCursor } = withCursor(rawTags, cursor);
  const pid = useCursor ? 0 : Math.max(0, (page - 1) * HTML_PAGE_SIZE);
  const $ = cheerio.load(await fetchText(`${SITE}?page=post&s=list&pid=${pid}&tags=${encodeURIComponent(tags)}`));
  const items: ScraperItem[] = [];

  $("article.thumbnail-preview").each((_, el) => {
    const link = $(el).find("a");
    const img = $(el).find("img");
    const id = (link.attr("href") || "").match(/id=(\d+)/)?.[1] || link.attr("id")?.replace(/^p/, "") || "";
    const thumb = img.attr("src") || "";
    if (!id || !thumb) return;

    const title = img.attr("title") || img.attr("alt") || "";
    const rating = title.match(/rating:(\w+)/i)?.[1].toLowerCase() ?? "general";
    const score = title.match(/score:(\d+)/i)?.[1] ?? "0";

    items.push({
      id,
      title: `Gelbooru #${id}`,
      thumbnailUrl: proxied(thumb),
      inlineUrl: proxied(thumb),
      // Tebakan lokasi berkas asli (benar bila aslinya .jpg); album otomatis kembali ke thumbnail bila salah
      directHdUrl: thumb.replace("/thumbnails/", "/images/").replace("/thumbnail_", "/"),
      postUrl: postUrl(id),
      isNsfw: isNsfwRating(rating),
      info: `📊 ${htmlEscape(rating)} · ⭐ ${htmlEscape(score)}`,
      tags: title.replace(/score:\d+/gi, "").replace(/rating:\w+/gi, "").trim().split(/[\s,]+/).filter(Boolean),
    });
  });

  return { items, hasNextPage: items.length >= HTML_PAGE_SIZE, nextCursor: lowestId(items) };
}

async function search(tags: string, page: number, cursor?: string): Promise<ScraperSearchResult> {
  try {
    const viaApi = await searchApi(tags, page, cursor);
    if (viaApi) return viaApi;
  } catch (err) {
    console.warn("[scraper-gelbooru] API gagal, beralih ke HTML:", (err as Error).message);
  }
  return searchHtml(tags, page, cursor);
}

/**
 * Lengkapi kata terakhir menjadi tag Gelbooru terpopuler yang berawalan sama,
 * mis. "hatsune_mi" menjadi "hatsune_miku". Mengembalikan null bila tidak ada padanan.
 */
async function autocompleteLastTag(query: string): Promise<string | null> {
  const words = query.trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  if (!last || /^[-~*]|[:~]/.test(last)) return null;

  try {
    const found = await fetchJson<Array<{ value: string }>>(
      `${SITE}?page=autocomplete2&term=${encodeURIComponent(last)}&limit=5&type=tag_query`,
      { timeoutMs: 5000 }
    );
    const best = found[0]?.value;
    if (!best || best === last) return null;
    return [...words.slice(0, -1), best].join(" ");
  } catch {
    return null;
  }
}

/** Kata kunci yang diketik pengguna -> kata kunci setelah tag terakhirnya dilengkapi. */
const completions = new TtlCache<string, string>(30 * 60_000, 300);

export default defineScraper({
  meta: {
    id: "scraper-gelbooru",
    name: "Gelbooru",
    emoji: "🎴",
    description: "Galeri anime terlengkap: gambar, GIF, dan video, dengan filter rating.",
    category: "search",
    scope: "both",
    minTier: "premium",
    defaultEnabled: false,
    version: "3.0.0",
  },
  prefix: ".gb",
  help: [
    "Kata kunci memakai gaya tag booru, mis. <code>blue_archive</code>. Awali dengan <code>-</code> untuk mengecualikan: <code>-animated</code>.",
    "Tag yang diketik sebagian dilengkapi otomatis: <code>hatsune_mi</code> menjadi <code>hatsune_miku</code>.",
    "GIF dan video (MP4) ikut tampil di mode inline. Hanya video: tambahkan tag <code>video</code>.",
    "Video di atas 20 MB tidak bisa dikirim lewat mode inline (batas Telegram); pakai tombol <b>Sumber</b>.",
    "Konten dewasa hanya muncul bila NSFW dinyalakan di /settings, dan hanya di chat pribadi.",
  ],

  async search(query, page, options) {
    const base = query.trim();
    // Tanpa kata kunci: kiriman terbaru. (Mengurutkan seluruh galeri berdasarkan skor membuat API Gelbooru
    // kehabisan waktu, sehingga Telegram berhenti menunggu dan tidak menampilkan apa pun.)
    const filters = [options.nsfw ? "" : "rating:general"];
    const build = (q: string) => [q, ...filters].filter(Boolean).join(" ");

    // Kata kunci yang pernah dilengkapi dipakai lagi di halaman-halaman berikutnya
    const known = completions.get(base.toLowerCase());
    if (known) return search(build(known), page, options.cursor);

    const result = await search(build(base), page, options.cursor);
    if (result.items.length > 0 || page > 1 || !base) return result;

    // Tidak ada hasil: mungkin tag terakhir baru diketik sebagian
    const completed = await autocompleteLastTag(base);
    if (!completed) return result;
    completions.set(base.toLowerCase(), completed);
    return search(build(completed), page, options.cursor);
  },

  async getHdUrl(postId) {
    try {
      const $ = cheerio.load(await fetchText(postUrl(postId)));
      return (
        $('li a:contains("Original image")').attr("href") ||
        $('meta[property="og:image"]').attr("content") ||
        $("#image").attr("src") ||
        null
      );
    } catch {
      return null;
    }
  },

  async getMetadata(postId) {
    try {
      const $ = cheerio.load(await fetchText(postUrl(postId)));
      const image = $('meta[property="og:image"]').attr("content") || $("#image").attr("src");
      return image ? { thumbUrl: proxied(image) } : null;
    } catch {
      return null;
    }
  },

  getPostUrl: postUrl,
});
