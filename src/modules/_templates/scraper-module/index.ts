import { defineScraper, ScraperItem } from "../../../core/sdk/defineScraper";
import { fetchJson } from "../../../core/tools/http";

/**
 * TEMPLAT SCRAPER GAMBAR
 *
 * Cara mulai:
 * 1. Salin folder ini ke `src/modules/<nama-folder>/`.
 * 2. Di file hasil salinan, ubah import "../../../core/..." menjadi "../../core/...".
 * 3. Ganti URL, bentuk data API, rating, dan alamat gambar sesuai situs sumber.
 * 4. Jalankan `npm run typecheck` dan `npm run smoke`.
 *
 * Folder `_templates` tidak dimuat sebagai fitur bot. Setelah folder hasil salinan
 * berada langsung di `src/modules/`, registry akan memuatnya otomatis.
 */

/**
 * Contoh kode rating Danbooru:
 *   g = general      (umum/aman)
 *   s = sensitive    (sensitif; belum tentu eksplisit)
 *   q = questionable (meragukan/dewasa)
 *   e = explicit     (eksplisit/dewasa)
 *
 * Ini BUKAN standar semua situs. Kalau API sumber memakai nilai seperti
 * "safe", "adult", atau angka, ganti tipe ini dan fungsi isNsfwRating().
 */
type SourceRating = "g" | "s" | "q" | "e";

/** Contoh bentuk satu hasil dari API sumber; sesuaikan dengan dokumentasi API yang dipakai. */
interface ExamplePost {
  id: number;
  rating: SourceRating;
  preview_file_url: string;
  file_url?: string;
  large_file_url?: string;
  file_ext?: string;
  image_width?: number;
  image_height?: number;
  score?: number;
  tag_string?: string;
}

const SITE = "https://contoh.com";
const API = `${SITE}/posts.json`;
const PAGE_SIZE = 20;

/** Pada contoh Danbooru, q dan e dianggap NSFW. Sesuaikan dengan aturan situs sumber. */
function isNsfwRating(rating: SourceRating): boolean {
  return rating === "q" || rating === "e";
}

function splitTags(tags: string | undefined): string[] {
  return (tags ?? "").split(/\s+/).filter(Boolean);
}

/** Bentuk URL halaman asli. Gunakan encodeURIComponent untuk ID/teks dinamis. */
function postUrl(postId: string): string {
  return `${SITE}/posts/${encodeURIComponent(postId)}`;
}

export default defineScraper({
  meta: {
    id: "scraper-contoh", // unik; biasanya mengikuti nama folder dengan huruf kecil
    name: "Contoh",
    emoji: "🌐",
    description: "Cari gambar dari situs Contoh.",
    category: "search",
    scope: "both", // "private" = chat pribadi, "group" = grup, "both" = keduanya
    minTier: "standard", // "premium" = hanya untuk pengguna VIP
    defaultEnabled: true, // apakah fitur langsung aktif bagi pengguna
    version: "1.0.0",
  },

  prefix: ".ct", // pengguna bisa memakai /ct, .ct, atau @nama_bot .ct

  help: [
    "Tulis kata kunci untuk mencari gambar.",
    "Contoh: <code>/ct hatsune_miku</code> atau <code>@nama_bot .ct hatsune_miku</code>.",
    "Hasil dewasa hanya dapat tampil jika diizinkan oleh pengaturan bot; tandai rating dengan benar.",
  ],

  async search(query, page, options) {
    // `page` dimulai dari 1. Bentuk parameter ini contoh; sesuaikan dengan API situs.
    const tags = [
      query.trim(),
      // Minta hasil aman dari API jika pencarian dewasa tidak diizinkan.
      // Tetap isi isNsfw di bawah: filter sisi bot juga akan menahan hasil dewasa.
      options.nsfw ? "" : "rating:g",
    ]
      .filter(Boolean)
      .join(" ");

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      page: String(page),
      tags,
    });

    // fetchJson menangani timeout dan User-Agent. Jika API gagal, biarkan error
    // diteruskan ke SDK agar kegagalan pencarian dicatat dan ditangani dengan benar.
    const posts = await fetchJson<ExamplePost[]>(`${API}?${params.toString()}`);

    const items: ScraperItem[] = posts.map((post) => {
      const id = String(post.id);
      const fullImageUrl = post.large_file_url || post.file_url || post.preview_file_url;
      const extension = (post.file_ext ?? "").toLowerCase();
      const media: ScraperItem["media"] =
        extension === "mp4" ? "video" : extension === "gif" ? "gif" : "photo";

      return {
        id,
        title: `Contoh #${id}`,
        thumbnailUrl: post.preview_file_url,
        inlineUrl: fullImageUrl,
        directHdUrl: post.file_url || post.large_file_url,
        postUrl: postUrl(id),
        media,
        width: post.image_width,
        height: post.image_height,
        isNsfw: isNsfwRating(post.rating),
        // Tag diisi sebagai array biasa; SDK menampilkannya dengan aman dan
        // membuatnya bisa disaring pengguna lewat /exclude.
        tags: splitTags(post.tag_string),
        // `info` adalah HTML. Jangan masukkan teks mentah dari situs ke sini.
        info: typeof post.score === "number" ? `⭐ ${post.score}` : undefined,
      };
    });

    return {
      items,
      // Contoh pagination berbasis nomor halaman: halaman berikutnya ada
      // jika API mengembalikan satu halaman penuh.
      hasNextPage: posts.length === PAGE_SIZE,
    };
  },

  getPostUrl: postUrl,
});
