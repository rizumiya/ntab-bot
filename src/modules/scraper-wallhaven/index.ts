import { defineScraper, ScraperItem } from "../../core/sdk/defineScraper";
import { fetchJson } from "../../core/tools/http";

interface WallhavenPost {
  id: string;
  url: string;
  path: string;
  purity: "sfw" | "sketchy" | "nsfw";
  resolution: string;
  favorites: number;
  file_size: number;
  thumbs: { large: string; original: string; small: string };
}

const API = "https://wallhaven.cc/api/v1";

export default defineScraper({
  meta: {
    id: "scraper-wallhaven",
    name: "Wallhaven",
    emoji: "🖼️",
    description: "Wallpaper anime & seni digital resolusi Full HD sampai 4K.",
    category: "search",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
  },
  prefix: ".wh",
  help: ["Tanpa kata kunci, yang tampil adalah wallpaper terpopuler bulan ini."],

  async search(query, page, options) {
    // Tanpa API key, Wallhaven hanya melayani SFW dan sketchy
    const purity = options.nsfw ? "110" : "100";
    const q = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : "";
    const json = await fetchJson<{ data: WallhavenPost[]; meta: { current_page: number; last_page: number } }>(
      `${API}/search?sorting=toplist&purity=${purity}&page=${page}${q}`
    );

    const items: ScraperItem[] = json.data.map((p) => ({
      id: p.id,
      title: `Wallhaven #${p.id} (${p.resolution})`,
      thumbnailUrl: p.thumbs.small,
      inlineUrl: p.thumbs.large,
      directHdUrl: p.path,
      postUrl: p.url,
      isNsfw: p.purity !== "sfw",
      info: `📐 ${p.resolution} · ❤️ ${p.favorites}`,
    }));

    return { items, hasNextPage: json.meta.current_page < json.meta.last_page };
  },

  async getHdUrl(postId) {
    try {
      const json = await fetchJson<{ data: WallhavenPost }>(`${API}/w/${encodeURIComponent(postId)}`);
      return json.data.path || null;
    } catch {
      return null;
    }
  },

  getPostUrl: (postId) => `https://wallhaven.cc/w/${postId}`,
  getThumbnailUrl: (postId) => `https://th.wallhaven.cc/small/${postId.slice(0, 2)}/${postId}.jpg`,
});
