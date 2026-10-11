import { defineScraper, ScraperItem } from "../../core/sdk/defineScraper";
import { fetchText, fetchJson } from "../../core/tools/http";

interface SafebooruPost {
  id: number;
  preview_url?: string;
  sample_url?: string;
  file_url?: string;
  directory: number | string;
  image: string;
  width: number;
  height: number;
  tags?: string;
}

const API = "https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1";
const PAGE_SIZE = 20;

export default defineScraper({
  meta: {
    id: "scraper-safebooru",
    name: "Safebooru",
    emoji: "🛡️",
    description: "Ilustrasi anime yang seluruhnya aman (SFW).",
    category: "search",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
  },
  prefix: ".sb",
  help: ["Kata kunci memakai gaya tag booru: spasi antar tag, garis bawah dalam satu tag (mis. <code>hatsune_miku</code>)."],

  async search(query, page) {
    const tags = query.trim() ? `&tags=${encodeURIComponent(query.trim())}` : "";
    // Safebooru membalas body kosong (bukan JSON) bila tidak ada hasil
    const body = await fetchText(`${API}&limit=${PAGE_SIZE}&pid=${Math.max(0, page - 1)}${tags}`);
    let data: SafebooruPost[] = [];
    try {
      data = body.trim() ? JSON.parse(body) : [];
    } catch {}
    if (!Array.isArray(data)) data = [];

    const items: ScraperItem[] = data.map((p) => {
      const hd = p.file_url || `https://safebooru.org/images/${p.directory}/${p.image}`;
      return {
        id: String(p.id),
        title: `Safebooru #${p.id} (${p.width}x${p.height})`,
        thumbnailUrl: p.preview_url || `https://safebooru.org/thumbnails/${p.directory}/thumbnail_${p.image}`,
        inlineUrl: p.sample_url || hd,
        directHdUrl: hd,
        postUrl: `https://safebooru.org/index.php?page=post&s=view&id=${p.id}`,
        isNsfw: false,
        info: `📐 ${p.width}x${p.height}`,
        tags: (p.tags || "").split(/\s+/).filter(Boolean),
      };
    });

    return { items, hasNextPage: data.length >= PAGE_SIZE };
  },

  async getHdUrl(postId) {
    try {
      const data = await fetchJson<SafebooruPost[]>(`${API}&id=${encodeURIComponent(postId)}`);
      return data?.[0]?.file_url || null;
    } catch {
      return null;
    }
  },

  async getMetadata(postId) {
    try {
      const p = (await fetchJson<SafebooruPost[]>(`${API}&id=${encodeURIComponent(postId)}`))?.[0];
      if (!p) return null;
      return {
        title: `Safebooru #${p.id} (${p.width}x${p.height})`,
        thumbUrl: p.sample_url || p.preview_url || p.file_url,
      };
    } catch {
      return null;
    }
  },

  getPostUrl: (postId) => `https://safebooru.org/index.php?page=post&s=view&id=${postId}`,
});
