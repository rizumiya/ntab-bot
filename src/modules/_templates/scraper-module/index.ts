import { defineScraper, ScraperItem } from "../../../core/sdk/defineScraper";
import { fetchJson } from "../../../core/tools/http";
import { htmlEscape } from "../../../core/tools/text";

/**
 * TEMPLAT MODUL PENCARIAN GAMBAR
 *
 * 1. Salin folder ini ke `src/modules/scraper-<nama>/` (jalur import menjadi "../../core/...").
 * 2. Ubah `meta`, `prefix`, dan isi `search`.
 * 3. Jalankan ulang bot. Mode inline, perintah album, tombol File HD, bookmark,
 *    menu, dan halaman bantuan terbentuk otomatis.
 */
export default defineScraper({
  meta: {
    id: "scraper-contoh", // unik, huruf kecil dan tanda hubung
    name: "Contoh",
    emoji: "🌐",
    description: "Satu kalimat: apa yang bisa dicari di sini.",
    category: "search",
    scope: "both", // "private" | "group" | "both"
    minTier: "standard", // "premium" = khusus VIP
    defaultEnabled: true,
    version: "1.0.0",
  },
  prefix: ".ct", // menjadi `@bot .ct`, `/ct`, dan `.ct`
  help: ["Tips singkat untuk pengguna (opsional, HTML)."],

  async search(query, page, options) {
    // `fetchJson` sudah memakai batas waktu dan User-Agent. Error cukup dilempar: SDK yang menanganinya.
    const data = await fetchJson<Array<{ id: number; preview: string; file: string; nsfw: boolean; tags: string }>>(
      `https://api.contoh.com/posts?q=${encodeURIComponent(query)}&page=${page}&safe=${options.nsfw ? 0 : 1}`
    );

    const items: ScraperItem[] = data.map((p) => ({
      id: String(p.id),
      title: `Contoh #${p.id}`,
      thumbnailUrl: p.preview,
      directHdUrl: p.file, // opsional
      postUrl: `https://contoh.com/post/${p.id}`,
      isNsfw: p.nsfw, // item NSFW otomatis disembunyikan dari yang tidak berhak
      info: `🏷️ ${htmlEscape(p.tags)}`, // teks dari situs sumber WAJIB di-htmlEscape
    }));

    return { items, hasNextPage: data.length > 0 };
  },

  // Opsional: bila URL berkas asli tidak ada di hasil pencarian
  async getHdUrl(postId) {
    return `https://contoh.com/full/${postId}.jpg`;
  },

  getPostUrl: (postId) => `https://contoh.com/post/${postId}`,
});
