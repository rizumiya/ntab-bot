import * as cheerio from "cheerio";
import { defineScraper, ScraperItem } from "../../core/sdk/defineScraper";
import { fetchText } from "../../core/tools/http";
import { htmlEscape } from "../../core/tools/text";
import { proxied } from "../../core/network/proxy";

/**
 * API Realbooru dimatikan pengelolanya, jadi daftar dibaca dari halaman HTML (42 kiriman per halaman).
 * Halaman daftar hanya memuat thumbnail dan tag; lokasi berkas penuh baru diketahui dari halaman kiriman,
 * sehingga hasil inline memakai thumbnail dan berkas penuh diambil saat tombol File HD ditekan.
 * Gambar menolak pengambilan tanpa Referer, jadi URL untuk Telegram dilewatkan `proxied()`.
 */

const SITE = "https://realbooru.com/index.php";
const PAGE_SIZE = 42;
const VIDEO_TAGS = new Set(["video", "webm", "mp4", "animated", "sound"]);

const postUrl = (id: string) => `${SITE}?page=post&s=view&id=${id}`;
const absolute = (url: string) => new URL(url, SITE).href;

async function getMetadata(postId: string) {
  const $ = cheerio.load(await fetchText(postUrl(postId)));
  const source = $("#image").attr("src") || $('meta[property="og:image"]').attr("content");
  return {
    thumbUrl: source ? proxied(absolute(source)) : undefined,
    postUrl: postUrl(postId),
  };
}

export default defineScraper({
  meta: {
    id: "scraper-realbooru",
    name: "Realbooru",
    emoji: "📷",
    description: "Galeri foto cosplay dan model (seluruhnya konten dewasa).",
    category: "search",
    scope: "both",
    minTier: "premium",
    defaultEnabled: false,
    version: "1.0.0",
  },
  prefix: ".rp",
  bookmarks: {
    category: "image",
    openButton: { label: "📥 File HD", action: "dl" },
    async resolve(postId) {
      try {
        return await getMetadata(postId);
      } catch (err) {
        console.warn("[scraper-realbooru] gagal mengambil thumbnail bookmark:", (err as Error).message);
        return { postUrl: postUrl(postId) };
      }
    },
  },
  help: [
    "Seluruh isi situs ini konten dewasa: hanya tampil bila NSFW dinyalakan di /settings, dan hanya di chat pribadi.",
    "Kata kunci memakai gaya tag booru, mis. <code>cosplay</code>. Awali dengan <code>-</code> untuk mengecualikan.",
    "Hasil inline berupa pratinjau kecil. Tekan <b>📥 File HD</b> untuk menerima foto atau video aslinya.",
    "Kiriman bertanda 🎞️ adalah video.",
  ],

  async search(query, page, options) {
    // Tanpa izin NSFW tidak ada yang boleh tampil, jadi situs tidak perlu dihubungi
    if (!options.nsfw) return { items: [], hasNextPage: false };

    const pid = Math.max(0, (page - 1) * PAGE_SIZE);
    const $ = cheerio.load(await fetchText(`${SITE}?page=post&s=list&pid=${pid}&tags=${encodeURIComponent(query.trim())}`));
    const items: ScraperItem[] = [];

    $("div.thumb").each((_, el) => {
      const id = ($(el).find("a").attr("id") || "").replace(/^p/, "");
      const img = $(el).find("img");
      const thumb = img.attr("src") || "";
      if (!/^\d+$/.test(id) || !thumb) return;

      const tags = (img.attr("title") || "").split(",").map((t) => t.trim().replace(/\s+/g, "_")).filter(Boolean);
      const isVideo = tags.some((t) => VIDEO_TAGS.has(t));

      items.push({
        id,
        title: `${isVideo ? "🎞️ " : ""}Realbooru #${id}`,
        thumbnailUrl: proxied(thumb),
        inlineUrl: proxied(thumb),
        // Album hanya berisi foto; untuk video dipakai thumbnail-nya
        directHdUrl: thumb,
        postUrl: postUrl(id),
        isNsfw: true,
        info: isVideo ? "🎞️ Video: tekan <b>File HD</b> untuk menerimanya" : htmlEscape("Tekan File HD untuk ukuran penuh"),
        tags,
      });
    });

    return { items, hasNextPage: items.length >= PAGE_SIZE };
  },

  async getHdUrl(postId) {
    try {
      const $ = cheerio.load(await fetchText(postUrl(postId)));
      const mp4 = $("video source")
        .map((_, el) => $(el).attr("src") || "")
        .get()
        .find((src) => src.endsWith(".mp4"));
      const file = mp4 || $("#image").attr("src") || $('meta[property="og:image"]').attr("content");
      return file ? absolute(file) : null;
    } catch {
      return null;
    }
  },

  getMetadata,
  getPostUrl: postUrl,
});
