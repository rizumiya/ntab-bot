import { defineScraper, ScraperItem } from "../../core/sdk/defineScraper";
import { fetchJson } from "../../core/tools/http";
import { htmlEscape } from "../../core/tools/text";

interface DanbooruPost {
  id: number;
  rating: "g" | "s" | "q" | "e";
  score: number;
  file_ext: string;
  file_url?: string;
  large_file_url?: string;
  preview_file_url?: string;
  image_width: number;
  image_height: number;
  pixiv_id?: number | null;
  tag_string_artist?: string;
  tag_string_character?: string;
  tag_string_copyright?: string;
  tag_string_general?: string;
  media_asset?: { variants?: Array<{ type: string; url: string; width: number; height: number }> };
}

const SITE = "https://danbooru.donmai.us";
const PAGE_SIZE = 50;

// User-Agent yang diterima Danbooru dipilih otomatis oleh `tools/http` (lihat `userAgentFor`)
const api = <T>(pathAndQuery: string) => fetchJson<T>(`${SITE}${pathAndQuery}`);

const words = (text: string | undefined) => (text ?? "").split(/\s+/).filter(Boolean);

export default defineScraper({
  meta: {
    id: "scraper-danbooru",
    name: "Danbooru",
    emoji: "📦",
    description: "Galeri anime dengan penandaan tag paling teliti: gambar, GIF, dan video.",
    category: "search",
    scope: "both",
    minTier: "premium",
    defaultEnabled: false,
    version: "1.0.0",
  },
  prefix: ".db",
  help: [
    "Kata kunci memakai gaya tag booru, mis. <code>hatsune_miku</code>.",
    "Tanpa akun, Danbooru hanya menerima <b>dua tag</b> per pencarian (filter rating tidak dihitung).",
    "Tombol <b>👤 Kreator</b> mencari karya lain dari artis yang sama.",
    "Konten dewasa hanya muncul bila NSFW dinyalakan di /settings, dan hanya di chat pribadi.",
  ],

  async search(query, _page, options) {
    const tags = [query.trim(), options.nsfw ? "" : "rating:g"].filter(Boolean).join(" ");
    // "b<id>" = kiriman sebelum ID itu, sehingga gambar tidak terulang antar halaman
    const position = options.cursor ? `&page=b${options.cursor}` : "";
    const posts = await api<DanbooruPost[]>(`/posts.json?limit=${PAGE_SIZE}&tags=${encodeURIComponent(tags)}${position}`);
    if (!Array.isArray(posts)) return { items: [], hasNextPage: false };

    const items: ScraperItem[] = [];
    for (const p of posts) {
      // Tanpa file_url = kiriman khusus anggota berbayar. WebM dan ugoira (zip) tidak bisa diputar Telegram.
      const media = p.file_ext === "mp4" ? "video" : p.file_ext === "gif" ? "gif" : "photo";
      if (!p.file_url || !p.preview_file_url || p.file_ext === "webm" || p.file_ext === "zip") continue;

      const variant = (type: string) => p.media_asset?.variants?.find((v) => v.type === type);
      const sample = variant("sample");
      const artist = words(p.tag_string_artist)[0];

      items.push({
        id: String(p.id),
        title: `Danbooru #${p.id}`,
        thumbnailUrl: variant("360x360")?.url ?? p.preview_file_url,
        inlineUrl: media === "photo" ? p.large_file_url || p.file_url : p.file_url,
        directHdUrl: p.file_url,
        media,
        width: (media === "photo" && sample ? sample.width : p.image_width) || undefined,
        height: (media === "photo" && sample ? sample.height : p.image_height) || undefined,
        postUrl: `${SITE}/posts/${p.id}`,
        isNsfw: p.rating === "q" || p.rating === "e",
        info: (artist ? `🎨 ${htmlEscape(artist)} · ` : "") + `⭐ ${p.score} · 📐 ${p.image_width}x${p.image_height}`,
        tags: [...words(p.tag_string_character), ...words(p.tag_string_copyright), ...words(p.tag_string_general)],
        shortcuts: [
          ...(artist ? [{ label: "👤 Kreator", query: `.db ${artist}` }] : []),
          ...(p.pixiv_id ? [{ label: "🎨 Buka di .px", query: `.px ${p.pixiv_id}` }] : []),
        ],
      });
    }

    const last = posts[posts.length - 1];
    return { items, hasNextPage: posts.length >= PAGE_SIZE, nextCursor: last ? String(last.id) : undefined };
  },

  async getHdUrl(postId) {
    try {
      return (await api<DanbooruPost>(`/posts/${encodeURIComponent(postId)}.json`)).file_url ?? null;
    } catch {
      return null;
    }
  },

  async getMetadata(postId) {
    try {
      const p = await api<DanbooruPost>(`/posts/${encodeURIComponent(postId)}.json`);
      return { thumbUrl: p.large_file_url || p.preview_file_url };
    } catch {
      return null;
    }
  },

  getPostUrl: (postId) => `${SITE}/posts/${postId}`,
});
