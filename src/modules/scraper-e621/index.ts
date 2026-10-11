import { defineScraper, ScraperItem } from "../../core/sdk/defineScraper";
import { fetchJson } from "../../core/tools/http";
import { htmlEscape } from "../../core/tools/text";

interface E621Post {
  id: number;
  rating: "s" | "q" | "e";
  score: { total: number };
  file: { width: number; height: number; ext: string; url: string | null };
  preview: { url: string | null };
  sample: { url: string | null; width?: number; height?: number };
  tags: Record<string, string[]>;
}

const SITE = "https://e621.net";
const PAGE_SIZE = 50;
const PHOTO_EXT = new Set(["jpg", "jpeg", "png", "webp"]);

// User-Agent yang diterima e621 dipilih otomatis oleh `tools/http` (lihat `userAgentFor`)
const api = <T>(pathAndQuery: string) => fetchJson<T>(`${SITE}${pathAndQuery}`);

export default defineScraper({
  meta: {
    id: "scraper-e621",
    name: "e621",
    emoji: "🐾",
    description: "Galeri seni furry, dengan filter rating.",
    category: "search",
    scope: "both",
    minTier: "premium",
    defaultEnabled: false,
    version: "1.0.0",
  },
  prefix: ".fur",
  help: [
    "Kata kunci memakai gaya tag booru, mis. <code>my_little_pony</code>. Awali dengan <code>-</code> untuk mengecualikan.",
    "Tombol <b>👤 Kreator</b> pada tiap hasil mencari karya lain dari artis yang sama.",
    "Konten dewasa hanya muncul bila NSFW dinyalakan di /settings, dan hanya di chat pribadi.",
    "Tanpa login, e621 menyembunyikan sebagian kiriman; itu sebabnya hasilnya bisa lebih sedikit daripada di situsnya.",
  ],

  async search(query, _page, options) {
    // Tanpa kata kunci: kiriman terbaru. (Urutan "skor tertinggi" didominasi video WebM, yang tidak bisa
    // ditampilkan Telegram, sehingga halaman pertamanya bisa kosong sama sekali.)
    const tags = [query.trim(), options.nsfw ? "" : "rating:s"].filter(Boolean).join(" ");
    // "b<id>" = kiriman sebelum ID itu: paginasi bawaan e621 yang tidak pernah mengulang gambar
    const position = options.cursor ? `&page=b${options.cursor}` : "";
    const { posts } = await api<{ posts: E621Post[] }>(`/posts.json?limit=${PAGE_SIZE}&tags=${encodeURIComponent(tags)}${position}`);

    const items: ScraperItem[] = [];
    for (const p of posts) {
      const isGif = p.file.ext === "gif";
      // Video e621 berformat WebM, yang tidak bisa diputar Telegram di mode inline
      if (!p.file.url || !p.preview.url || (!isGif && !PHOTO_EXT.has(p.file.ext))) continue;

      const artist = (p.tags.artist ?? []).find((name) => !["conditional_dnp", "sound_warning", "unknown_artist"].includes(name));
      items.push({
        id: String(p.id),
        title: `e621 #${p.id}`,
        thumbnailUrl: p.preview.url,
        inlineUrl: isGif ? p.file.url : p.sample.url || p.file.url,
        directHdUrl: isGif ? p.file.url : p.sample.url || p.file.url,
        media: isGif ? "gif" : "photo",
        width: (isGif ? p.file.width : p.sample.width) || undefined,
        height: (isGif ? p.file.height : p.sample.height) || undefined,
        postUrl: `${SITE}/posts/${p.id}`,
        isNsfw: p.rating !== "s",
        info: (artist ? `🎨 ${htmlEscape(artist)} · ` : "") + `⭐ ${p.score.total} · 📐 ${p.file.width}x${p.file.height}`,
        tags: [...(p.tags.character ?? []), ...(p.tags.copyright ?? []), ...(p.tags.species ?? []), ...(p.tags.general ?? [])],
        shortcuts: artist ? [{ label: "👤 Kreator", query: `.fur ${artist}` }] : undefined,
      });
    }

    const last = posts[posts.length - 1];
    // Urutan berdasarkan skor tidak mengikuti ID, jadi penanda posisi hanya dipakai pada urutan bawaan
    const sorted = tags.includes("order:");
    return { items, hasNextPage: !sorted && posts.length >= PAGE_SIZE, nextCursor: last ? String(last.id) : undefined };
  },

  async getHdUrl(postId) {
    try {
      return (await api<{ post: E621Post }>(`/posts/${encodeURIComponent(postId)}.json`)).post.file.url;
    } catch {
      return null;
    }
  },

  async getMetadata(postId) {
    try {
      const { post } = await api<{ post: E621Post }>(`/posts/${encodeURIComponent(postId)}.json`);
      return { thumbUrl: post.sample.url || post.preview.url || undefined };
    } catch {
      return null;
    }
  },

  getPostUrl: (postId) => `${SITE}/posts/${postId}`,
});
