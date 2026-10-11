import { defineScraper, ScraperItem } from "../../core/sdk/defineScraper";
import { fetchJson } from "../../core/tools/http";

interface KonachanPost {
  id: number;
  tags: string;
  score: number;
  file_url: string;
  preview_url: string;
  sample_url: string;
  jpeg_url?: string;
  rating: "s" | "q" | "e";
  sample_width?: number;
  sample_height?: number;
  width: number;
  height: number;
}

const API = "https://konachan.net/post.json";
const PAGE_SIZE = 20;

async function getPost(postId: string): Promise<KonachanPost | null> {
  try {
    const posts = await fetchJson<KonachanPost[]>(`${API}?limit=1&tags=id:${encodeURIComponent(postId)}`);
    return posts?.[0] ?? null;
  } catch {
    return null;
  }
}

export default defineScraper({
  meta: {
    id: "scraper-konachan",
    name: "Konachan",
    emoji: "🌸",
    description: "Wallpaper anime kualitas tinggi (HD sampai 8K).",
    category: "search",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
  },
  prefix: ".kc",
  help: ["Kata kunci memakai gaya tag booru, mis. <code>landscape</code> atau <code>hatsune_miku</code>."],

  async search(query, page, options) {
    const tags = [query.trim(), options.nsfw ? "" : "rating:safe", query.trim() ? "" : "order:score"].filter(Boolean).join(" ");
    const posts = await fetchJson<KonachanPost[]>(`${API}?limit=${PAGE_SIZE}&page=${page}&tags=${encodeURIComponent(tags)}`);
    if (!Array.isArray(posts)) return { items: [], hasNextPage: false };

    const items: ScraperItem[] = posts.map((p) => {
      return {
        id: String(p.id),
        title: `Konachan #${p.id} (${p.width}x${p.height})`,
        thumbnailUrl: p.preview_url,
        inlineUrl: p.sample_url || p.jpeg_url,
        // Berkas asli bisa puluhan MB; versi JPEG lebih ramah untuk album
        directHdUrl: p.jpeg_url || p.file_url,
        postUrl: `https://konachan.net/post/show/${p.id}`,
        isNsfw: p.rating !== "s",
        width: p.sample_width || undefined,
        height: p.sample_height || undefined,
        info: `📐 ${p.width}x${p.height} · ⭐ ${p.score}`,
        tags: (p.tags || "").split(/\s+/).filter(Boolean),
      };
    });

    return { items, hasNextPage: posts.length >= PAGE_SIZE };
  },

  async getHdUrl(postId) {
    const p = await getPost(postId);
    return p ? p.file_url || p.jpeg_url || p.sample_url || null : null;
  },

  async getMetadata(postId) {
    const p = await getPost(postId);
    return p ? { title: `Konachan #${p.id} (${p.width}x${p.height})`, thumbUrl: p.sample_url || p.preview_url } : null;
  },

  getPostUrl: (postId) => `https://konachan.net/post/show/${postId}`,
});
