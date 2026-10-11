import * as http from "http";
import * as crypto from "crypto";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { config } from "../config";
import { BROWSER_UA, refererFor } from "../tools/http";

/**
 * Image proxy: menjembatani gambar dari CDN ber-proteksi hotlink ke Telegram.
 *
 * Pengaman:
 * - hanya domain di daftar izin (anti-SSRF), termasuk setiap tujuan redirect;
 * - URL wajib bertanda tangan bot ini, jadi orang luar tidak bisa menumpang bandwidth;
 * - jumlah koneksi, ukuran, dan durasi dibatasi.
 */

// Hanya situs yang gambarnya memang dilewatkan `proxied()` oleh sebuah modul.
// Menambah modul yang butuh proxy berarti menambah domainnya di sini.
const ALLOWED_HOSTS = [
  /(^|\.)gelbooru\.com$/i,
  /(^|\.)realbooru\.com$/i,
  /(^|\.)pximg\.net$/i,
];

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
// Telegram hanya mau mengambil video lewat URL sampai 20 MB
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 3;

let server: http.Server | null = null;
let activeConnections = 0;

// Telegram mengambil hingga 50 gambar sekaligus untuk satu halaman hasil inline.
// Permintaan di atas batas koneksi menunggu giliran; hanya ditolak bila antrean penuh atau menunggu terlalu lama.
const MAX_QUEUE = 200;
const MAX_WAIT_MS = 8000;
const waiting: Array<(granted: boolean) => void> = [];

function acquireSlot(): Promise<boolean> {
  if (activeConnections < config.limits.proxyConnections) {
    activeConnections++;
    return Promise.resolve(true);
  }
  if (waiting.length >= MAX_QUEUE) return Promise.resolve(false);

  return new Promise((resolve) => {
    const entry = (granted: boolean) => {
      clearTimeout(timer);
      resolve(granted);
    };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(entry);
      if (index >= 0) waiting.splice(index, 1);
      resolve(false);
    }, MAX_WAIT_MS);
    waiting.push(entry);
  });
}

/** Serahkan slot ke penunggu berikutnya, atau kosongkan bila tidak ada yang menunggu. */
function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next(true);
  else activeConnections--;
}

function isAllowed(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    return u.protocol === "https:" && ALLOWED_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

function sign(url: string): string {
  return crypto.createHmac("sha256", config.botToken).update(url).digest("base64url").slice(0, 22);
}

/**
 * Bungkus URL gambar agar dilewatkan proxy. Jika proxy tidak aktif atau belum punya
 * alamat publik (PROXY_PUBLIC_URL), URL asli dikembalikan apa adanya.
 */
export function proxied(url: string): string {
  if (!config.proxy.enabled || !config.proxy.publicUrl || !url) return url;
  return `${config.proxy.publicUrl}/proxy/img?url=${encodeURIComponent(url)}&sig=${sign(url)}`;
}

async function fetchUpstream(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const referer = refererFor(current);
    const res = await fetch(current, {
      signal,
      redirect: "manual",
      headers: { "User-Agent": BROWSER_UA, ...(referer ? { Referer: referer } : {}) },
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;

    await res.body?.cancel().catch(() => {});
    current = new URL(location, current).href;
    if (!isAllowed(current)) throw new Error("redirect ke domain yang tidak diizinkan");
  }
  throw new Error("terlalu banyak redirect");
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const u = new URL(req.url || "/", "http://localhost");
  const fail = (status: number, message: string) => {
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(message);
  };

  if (u.pathname === "/health") return fail(200, "ok");
  if (u.pathname !== "/proxy/img" || req.method !== "GET") return fail(404, "Not Found");

  const target = u.searchParams.get("url") || "";
  const sig = u.searchParams.get("sig") || "";
  const expected = sign(target);
  const validSig = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!target || !validSig || !isAllowed(target)) return fail(403, "Forbidden");

  if (!(await acquireSlot())) return fail(503, "Busy");

  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const upstream = await fetchUpstream(target, signal);

    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => {});
      return fail(502, `Upstream ${upstream.status}`);
    }
    const contentType = upstream.headers.get("content-type") || "";
    const length = Number(upstream.headers.get("content-length"));
    // Gambar, GIF, dan video MP4 (hasil inline bertipe video). Jenis lain ditolak.
    const isVideo = contentType.startsWith("video/mp4");
    const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if ((!contentType.startsWith("image/") && !isVideo) || (length && length > maxBytes)) {
      await upstream.body.cancel().catch(() => {});
      return fail(415, "Unsupported type or too large");
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
      ...(length ? { "Content-Length": String(length) } : {}),
    });

    let sent = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        sent += chunk.length;
        done(sent > maxBytes ? new Error("melebihi batas ukuran") : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(upstream.body as any), limiter, res);
  } catch {
    if (!res.headersSent) fail(502, "Proxy error");
    else res.destroy();
  } finally {
    releaseSlot();
  }
}

export function startImageProxy(): void {
  if (server || !config.proxy.enabled) return;

  const { host, port } = config.proxy;
  server = http.createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  server.requestTimeout = TIMEOUT_MS;
  server.headersTimeout = 10_000;

  server.on("error", (err: NodeJS.ErrnoException) => {
    const hint = err.code === "EADDRINUSE" ? ` Port ${port} sudah dipakai; ganti PROXY_PORT di .env.` : "";
    console.error(`[Proxy] Gagal aktif: ${err.message}.${hint} Bot tetap berjalan tanpa proxy.`);
    server = null;
  });

  server.listen(port, host, () => {
    console.log(`[Proxy] Aktif di http://${host}:${port}` + (config.proxy.publicUrl ? ` (publik: ${config.proxy.publicUrl})` : ""));
    if (!config.proxy.publicUrl) {
      console.warn("[Proxy] PROXY_PUBLIC_URL kosong, jadi proxy belum dipakai oleh modul mana pun.");
    }
  });
}

export function stopImageProxy(): void {
  server?.close();
  server?.closeAllConnections();
  server = null;
}
