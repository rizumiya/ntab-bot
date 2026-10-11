import { InlineKeyboard } from "grammy";
import { defineScraper, sendScraperAlbum, DefineScraperConfig, ScraperItem, ScraperSearchResult } from "../../core/sdk/defineScraper";
import { nsfwAllowed } from "../../core/engine/gate";
import { config } from "../../core/config";
import { proxied } from "../../core/network/proxy";
import { fetchJson } from "../../core/tools/http";
import { htmlEscape } from "../../core/tools/text";
import { TtlCache } from "../../core/tools/cache";
import { albumJobs, sendAlbum } from "../../core/tools/media";
import { progress, reply } from "../../core/tools/ui";

/**
 * Data diambil dari endpoint web Pixiv. Tanpa PIXIV_PHPSESSID hanya karya yang terlihat tanpa login;
 * dengan cookie itu, karya berlabel dewasa ikut tersedia. Tiga bentuk kata kunci:
 *   - tag            -> pencarian Pixiv, terbaru dulu
 *   - <ID karya>     -> semua halaman karya itu
 *   - id:<ID kreator> -> karya-karya kreator itu, terbaru dulu
 *
 * ID item: "<illustId>" untuk halaman pertama, "<illustId>_p<n>" untuk halaman ke-(n+1).
 *
 * Gambar: Pixiv menyediakan beberapa ukuran untuk tiap halaman. Grid memakai ukuran kecil (±60 KB)
 * dan gambar yang dikirim memakai ukuran sedang (lebar maks 1200 px). Berkas asli (bisa belasan MB)
 * hanya diunduh saat tombol File HD ditekan.
 */

const WEB = "https://www.pixiv.net";
const PAGE_SIZE = 30;
const MAX_PACK = 50;

interface Work {
  id: string;
  title: string;
  userId: string;
  userName: string;
  pageCount: number;
  isNsfw: boolean;
  /** Bagian jalur gambar yang sama untuk semua ukuran: "2026/10/10/09/22/24". Kosong bila tidak diketahui. */
  datePath: string;
  width?: number;
  height?: number;
  tags: string[];
}

/** Header untuk situs Pixiv. Cookie sesi (bila diisi di .env) membuka karya berlabel dewasa. */
const HEADERS: Record<string, string> = {
  Referer: `${WEB}/`,
  ...(config.pixivSession ? { Cookie: `PHPSESSID=${config.pixivSession}` } : {}),
};

const ajax = <T>(pathAndQuery: string) => fetchJson<{ error: boolean; body: T }>(`${WEB}${pathAndQuery}`, { headers: HEADERS, timeoutMs: 12_000 });

const artworkUrl = (illustId: string) => `${WEB}/artworks/${illustId}`;

function parseItemId(itemId: string): { illustId: string; pageIndex: number } {
  const [illustId, page] = itemId.replace(/^#/, "").split("_p");
  return { illustId, pageIndex: parseInt(page, 10) || 0 };
}

// ============================================================================
// GAMBAR
// ============================================================================
/** Ambil jalur tanggal dari URL gambar Pixiv ukuran apa pun. Animasi (ugoira) tidak punya "_p0" dan dilewati. */
function datePathOf(url: string | undefined): string {
  return url?.match(/\/img\/(\d{4}\/\d\d\/\d\d\/\d\d\/\d\d\/\d\d)\/\d+_p\d+/)?.[1] ?? "";
}

/** Alamat asli di server gambar Pixiv. Hanya bisa diambil dengan Referer Pixiv (ditangani `tools/http`). */
function pximg(work: Work, pageIndex: number, size: "small" | "regular"): string {
  const prefix = size === "small" ? "/c/540x540_70" : "";
  return `https://i.pximg.net${prefix}/img-master/img/${work.datePath}/${work.id}_p${pageIndex}_master1200.jpg`;
}

/**
 * Alamat yang bisa diambil Telegram: lewat image proxy bot ini bila aktif,
 * kalau tidak lewat cermin publik i.pixiv.re.
 */
function forTelegram(url: string): string {
  return config.proxy.enabled && config.proxy.publicUrl ? proxied(url) : url.replace("i.pximg.net", "i.pixiv.re");
}

/** pixiv.cat meneruskan berkas resolusi asli; dipakai untuk File HD dan bila jalur tanggal tidak diketahui. */
function originalUrl(work: Pick<Work, "id" | "pageCount">, pageIndex: number): string {
  return work.pageCount > 1 ? `https://pixiv.cat/${work.id}-${pageIndex + 1}.jpg` : `https://pixiv.cat/${work.id}.jpg`;
}

function toItem(work: Work, pageIndex: number): ScraperItem {
  const known = Boolean(work.datePath);
  const pageNote = work.pageCount > 1 ? ` (${pageIndex + 1}/${work.pageCount})` : "";
  const item: ScraperItem = {
    id: pageIndex === 0 ? work.id : `${work.id}_p${pageIndex}`,
    title: `${work.title}${pageNote}`,
    thumbnailUrl: known ? forTelegram(pximg(work, pageIndex, "small")) : originalUrl(work, pageIndex),
    inlineUrl: known ? forTelegram(pximg(work, pageIndex, "regular")) : originalUrl(work, pageIndex),
    // Untuk album: bot mengunduh ukuran sedang langsung dari Pixiv, tanpa memutar lewat proxy
    directHdUrl: known ? pximg(work, pageIndex, "regular") : originalUrl(work, pageIndex),
    postUrl: artworkUrl(work.id),
    isNsfw: work.isNsfw,
    // Ukuran hanya diketahui pasti untuk halaman pertama
    ...(pageIndex === 0 && work.width && work.height ? { width: work.width, height: work.height } : {}),
    info: `🎨 ${htmlEscape(work.userName)}` + (work.pageCount > 1 && pageIndex === 0 ? ` · ${work.pageCount} halaman` : ""),
    tags: work.tags,
    shortcuts: [
      ...(work.userId ? [{ label: "👤 Kreator", query: `.px id:${work.userId}` }] : []),
      ...(work.pageCount > 1 ? [{ label: `🖼️ Semua halaman (${work.pageCount})`, query: `.px ${work.id}` }] : []),
    ],
  };
  return item;
}

// ============================================================================
// DATA
// ============================================================================
const workCache = new TtlCache<string, Work | null>(30 * 60_000, 500);
const authorCache = new TtlCache<string, string[]>(10 * 60_000, 100);

/** Bentuk seragam dari item pencarian, karya kreator, dan peringkat harian. */
function toWork(raw: any): Work | null {
  const id = String(raw.id ?? raw.illust_id ?? "");
  const datePath = datePathOf(raw.url);
  if (!id || !datePath) return null;

  const work: Work = {
    id,
    title: String(raw.title || `Pixiv #${id}`),
    userId: String(raw.userId ?? raw.user_id ?? ""),
    userName: String(raw.userName ?? raw.user_name ?? "-"),
    pageCount: Number(raw.pageCount ?? raw.illust_page_count) || 1,
    isNsfw: Number(raw.xRestrict ?? 0) > 0,
    datePath,
    width: Number(raw.width) || undefined,
    height: Number(raw.height) || undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
  };
  workCache.set(id, work);
  return work;
}

/** Info satu karya. Satu permintaan; hasilnya (termasuk "tidak ada") di-cache 30 menit. */
async function getWork(illustId: string): Promise<Work | null> {
  const cached = workCache.get(illustId);
  if (cached !== undefined) return cached;

  let work: Work | null = null;
  try {
    const { error, body } = await ajax<any>(`/ajax/illust/${illustId}`);
    if (!error && body) {
      work = {
        id: illustId,
        title: String(body.illustTitle || `Pixiv #${illustId}`),
        userId: String(body.userId ?? ""),
        userName: String(body.userName ?? "-"),
        pageCount: Number(body.pageCount) || 1,
        isNsfw: Number(body.xRestrict) > 0,
        // URL gambar utama disembunyikan untuk karya dewasa bila tanpa login,
        // tetapi thumbnail di daftar karya kreator tetap memuat jalur tanggalnya
        datePath: datePathOf(body.urls?.regular) || datePathOf(body.userIllusts?.[illustId]?.url),
        width: Number(body.width) || undefined,
        height: Number(body.height) || undefined,
        // Terjemahan Inggris dipakai bila ada, agar tag Jepang tetap terbaca
        tags: (body.tags?.tags ?? []).map((t: any) => String(t.translation?.en || t.tag)),
      };
    }
  } catch (err) {
    // 404 = karya tidak ada (boleh di-cache). Gangguan lain jangan di-cache agar bisa dicoba lagi.
    if ((err as Error).message !== "HTTP 404") throw err;
  }

  workCache.set(illustId, work);
  return work;
}

const searchCache = new TtlCache<string, { works: Work[]; total: number }>(3 * 60_000, 60);

/**
 * Pixiv memberi 60 hasil per halaman, sedangkan Telegram menerima paling banyak 50 hasil inline.
 * Jadi satu halaman Pixiv dibagi menjadi dua halaman inline berisi 30; halaman Pixiv-nya di-cache
 * agar paruh kedua tidak meminta ulang.
 */
async function searchByTag(tag: string, page: number, nsfw: boolean): Promise<ScraperSearchResult> {
  const sourcePage = Math.ceil(page / 2);
  const key = `${nsfw ? "all" : "safe"}:${sourcePage}:${tag.toLowerCase()}`;

  let hit = searchCache.get(key);
  if (!hit) {
    const word = encodeURIComponent(tag);
    const { body } = await ajax<{ illustManga?: { data?: any[]; total?: number } }>(
      `/ajax/search/artworks/${word}?word=${word}&order=date_d&mode=${nsfw ? "all" : "safe"}&p=${sourcePage}&s_mode=s_tag&type=illust`
    );
    hit = {
      works: (body.illustManga?.data ?? []).map(toWork).filter((w) => w !== null),
      total: body.illustManga?.total ?? 0,
    };
    searchCache.set(key, hit);
  }

  const firstHalf = page % 2 === 1;
  const works = firstHalf ? hit.works.slice(0, PAGE_SIZE) : hit.works.slice(PAGE_SIZE);
  const moreInSource = firstHalf && hit.works.length > PAGE_SIZE;
  return { items: works.map((w) => toItem(w, 0)), hasNextPage: moreInSource || sourcePage * 60 < hit.total };
}

async function searchByAuthor(userId: string, page: number): Promise<ScraperSearchResult> {
  let ids = authorCache.get(userId);
  if (!ids) {
    const { body } = await ajax<{ illusts?: Record<string, unknown> }>(`/ajax/user/${userId}/profile/all`);
    ids = Object.keys(body.illusts ?? {}).sort((a, b) => Number(b) - Number(a));
    authorCache.set(userId, ids);
  }

  const start = (page - 1) * PAGE_SIZE;
  const slice = ids.slice(start, start + PAGE_SIZE);
  if (slice.length === 0) return { items: [], hasNextPage: false };

  const query = slice.map((id) => `ids%5B%5D=${id}`).join("&");
  const { body } = await ajax<{ works?: Record<string, any> }>(
    `/ajax/user/${userId}/profile/illusts?${query}&work_category=illust&is_first_page=0`
  );
  const works = slice.map((id) => (body.works?.[id] ? toWork(body.works[id]) : null)).filter((w) => w !== null);
  return { items: works.map((w) => toItem(w, 0)), hasNextPage: start + PAGE_SIZE < ids.length };
}

async function dailyRanking(page: number, nsfw: boolean): Promise<ScraperSearchResult> {
  const json = await fetchJson<{ contents?: any[]; next?: number | false }>(
    `${WEB}/ranking.php?mode=${nsfw ? "daily_r18" : "daily"}&content=illust&p=${page}&format=json`,
    { headers: HEADERS, timeoutMs: 12_000 }
  ).catch(() => fetchJson<{ contents?: any[]; next?: number | false }>(`${WEB}/ranking.php?mode=daily&content=illust&p=${page}&format=json`, {
    headers: HEADERS,
    timeoutMs: 12_000,
  }));
  const works = (json.contents ?? []).map(toWork).filter((w) => w !== null);
  return { items: works.map((w) => toItem(w, 0)), hasNextPage: Boolean(json.next) };
}

/** Semua halaman satu karya (maks 50), 30 per halaman hasil. */
async function packOf(illustId: string, page: number): Promise<ScraperSearchResult> {
  const work = await getWork(illustId);
  if (!work) return { items: [], hasNextPage: false };

  const total = Math.min(work.pageCount, MAX_PACK);
  const start = (page - 1) * PAGE_SIZE;
  const items = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, total - start)) }, (_, i) => toItem(work, start + i));
  return { items, hasNextPage: start + PAGE_SIZE < total };
}

// ============================================================================
// MODUL
// ============================================================================
const ILLUST_ID = /^#?\d{4,}(_p\d+)?$/i;
const AUTHOR_ID = /^(?:id|user|u):(\d+)$/i;

const pixivConfig: DefineScraperConfig = {
  meta: {
    id: "scraper-pixiv",
    name: "Pixiv",
    emoji: "🎨",
    description: "Fanart Pixiv: cari per tag, buka semua halaman sebuah karya, atau jelajahi karya seorang kreator.",
    category: "search",
    scope: "both",
    minTier: "premium",
    defaultEnabled: false,
    version: "3.0.0",
  },
  prefix: ".px",
  help: [
    "Tag: <code>/px genshin</code> (tag berbahasa Jepang memberi hasil terbanyak)",
    "ID karya: <code>/px 99040957</code> mengirim semua halamannya",
    "Satu halaman: <code>/px 99040957_p2</code> mengirim halaman ke-3 saja",
    "ID kreator: <code>/px id:10415882</code> menampilkan karya-karyanya, terbaru dulu",
    "Tanpa kata kunci: peringkat harian Pixiv.",
    "Tiap hasil punya tombol <b>👤 Kreator</b> dan <b>🖼️ Semua halaman</b>, jadi ID tidak perlu diketik.",
  ],

  commands: [
    {
      command: "px",
      description: "Album Pixiv dari tag, ID karya, atau ID kreator",
      usage: "/px <tag | ID karya | id:ID kreator>",
      listed: true,
      async handler(ctx, args) {
        const first = args.split(/\s+/)[0] ?? "";
        if (!ILLUST_ID.test(first)) {
          // Tag dan id:<kreator> memakai alur album bawaan
          await sendScraperAlbum(pixivConfig, args, ctx);
          return;
        }

        const { illustId, pageIndex } = parseItemId(first);
        const onePage = /_p\d+$/i.test(first);

        const ran = await albumJobs.tryRun(async () => {
          const wait = await progress(ctx, `⏳ Mengambil Pixiv <code>#${illustId}</code>...`);
          const work = await getWork(illustId).catch(() => null);

          if (!work) return wait.fail(`❌ Karya <code>#${illustId}</code> tidak ditemukan di Pixiv.`);
          if (work.isNsfw && !nsfwAllowed(ctx)) {
            return wait.fail("🔞 Karya ini berlabel dewasa. Nyalakan NSFW di /settings dan buka lewat chat pribadi.");
          }

          const pages = onePage
            ? [Math.min(pageIndex, work.pageCount - 1)]
            : Array.from({ length: Math.min(work.pageCount, 20) }, (_, i) => i);

          const sent = await sendAlbum(
            ctx,
            pages.map((p) => ({
              cacheKey: `scraper-pixiv:photo:${illustId}_p${p}`,
              url: work.datePath ? pximg(work, p, "regular") : originalUrl(work, p),
              fallbackUrl: originalUrl(work, p),
            }))
          );
          if (sent === 0) return wait.fail("❌ Gambar gagal diunduh. Coba lagi nanti.");

          await wait.done();
          const kb = new InlineKeyboard().switchInlineCurrent("🔎 Pilih halaman", `.px ${illustId}`);
          if (work.userId) kb.switchInlineCurrent("👤 Karya kreator", `.px id:${work.userId}`);
          await reply(
            ctx,
            `🎨 <b>${htmlEscape(work.title)}</b> oleh ${htmlEscape(work.userName)}\n` +
              `${sent} dari ${work.pageCount} halaman · <a href="${artworkUrl(illustId)}">buka di Pixiv</a>`,
            kb
          );
        });

        if (!ran) await reply(ctx, "⏳ Server sedang memproses album lain. Coba lagi sebentar lagi.");
      },
    },
  ],

  async search(query, page, options) {
    const text = query.trim();
    if (!text) return dailyRanking(page, options.nsfw);

    const first = text.split(/\s+/)[0];
    const author = first.match(AUTHOR_ID);
    if (author) return searchByAuthor(author[1], page);
    if (ILLUST_ID.test(first)) return packOf(parseItemId(first).illustId, page);
    return searchByTag(text, page, options.nsfw);
  },

  async getHdUrl(postId) {
    const { illustId, pageIndex } = parseItemId(postId);
    const work = await getWork(illustId).catch(() => null);
    return originalUrl({ id: illustId, pageCount: work?.pageCount ?? (pageIndex > 0 ? 2 : 1) }, pageIndex);
  },

  async getMetadata(postId) {
    const { illustId, pageIndex } = parseItemId(postId);
    const work = await getWork(illustId).catch(() => null);
    if (!work) return { title: `Pixiv #${postId}`, postUrl: artworkUrl(illustId) };
    return {
      title: `${work.title} oleh ${work.userName}`,
      thumbUrl: work.datePath ? forTelegram(pximg(work, pageIndex, "regular")) : originalUrl(work, pageIndex),
      postUrl: artworkUrl(illustId),
    };
  },

  getPostUrl: (postId) => artworkUrl(parseItemId(postId).illustId),
};

export default defineScraper(pixivConfig);
