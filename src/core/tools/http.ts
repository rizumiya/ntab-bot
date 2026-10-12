import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pipeline } from "stream/promises";
import { Readable, Transform } from "stream";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Nama aplikasi yang jujur. Beberapa situs mewajibkannya dan menolak User-Agent mirip peramban. */
const APP_UA = "NtabBot/3.0 (Telegram bot)";

/**
 * User-Agent menurut situs tujuan. Danbooru dan e621 (API maupun server gambarnya) menjawab 403
 * untuk User-Agent peramban tiruan; situs lain justru menolak yang bukan peramban.
 */
export function userAgentFor(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  return /(^|\.)(donmai\.us|e621\.net|e926\.net)$/i.test(host) ? APP_UA : BROWSER_UA;
}

export interface RequestOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string | Uint8Array | FormData;
}

/** Referer yang diwajibkan CDN ber-proteksi hotlink. */
export function refererFor(url: string): string | undefined {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (/(^|\.)gelbooru\.com$/i.test(host)) return "https://gelbooru.com/";
  if (/(^|\.)realbooru\.com$/i.test(host)) return "https://realbooru.com/";
  if (/(^|\.)(pixiv\.net|pximg\.net)$/i.test(host)) return "https://www.pixiv.net/";
  return undefined;
}

/** fetch dengan batas waktu (mencakup pembacaan body), User-Agent, dan Referer otomatis. */
async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const referer = refererFor(url);
  return fetch(url, {
    method: opts.method,
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    headers: {
      "User-Agent": userAgentFor(url),
      ...(referer ? { Referer: referer } : {}),
      ...opts.headers,
    },
  });
}

/** Ambil JSON. Melempar error jika status bukan 2xx. */
export async function fetchJson<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Ambil teks/HTML. Melempar error jika status bukan 2xx. */
export async function fetchText(url: string, opts: RequestOptions = {}): Promise<string> {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Ambil hanya `bytes` pertama sebuah berkas (mis. untuk membaca header gambar).
 * Memakai Range; bila server mengabaikannya, pembacaan tetap dihentikan setelah `bytes`.
 */
export async function fetchHead(url: string, bytes: number, opts: RequestOptions = {}): Promise<Buffer> {
  const res = await request(url, { ...opts, headers: { Range: `bytes=0-${bytes - 1}`, ...opts.headers } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const chunks: Buffer[] = [];
  let received = 0;
  const reader = res.body.getReader();
  try {
    while (received < bytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      received += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, bytes);
}

/**
 * Minta sebuah URL lalu buang isinya. Dipakai untuk "memanaskan" CDN: setelah ini,
 * permintaan berikutnya ke URL yang sama dilayani dari cache CDN, bukan diolah ulang.
 * Mengembalikan false bila gagal (tidak melempar).
 */
export async function warmUrl(url: string, opts: RequestOptions = {}): Promise<boolean> {
  try {
    const res = await request(url, { timeoutMs: 30_000, ...opts });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

export class TooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Ukuran berkas melebihi batas ${(maxBytes / 1024 / 1024).toFixed(0)} MB`);
  }
}

/**
 * Unduh URL langsung ke disk (tidak ditampung di RAM) dengan batas ukuran.
 * Berkas yang gagal/terlalu besar dihapus kembali.
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  opts: RequestOptions & { maxBytes: number }
): Promise<number> {
  const res = await request(url, { timeoutMs: 30_000, ...opts });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const declared = Number(res.headers.get("content-length"));
  if (declared && declared > opts.maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new TooLargeError(opts.maxBytes);
  }

  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      received += chunk.length;
      done(received > opts.maxBytes ? new TooLargeError(opts.maxBytes) : null, chunk);
    },
  });

  try {
    await pipeline(Readable.fromWeb(res.body as any), limiter, fs.createWriteStream(destPath));
  } catch (err) {
    fs.rmSync(destPath, { force: true });
    throw err;
  }
  return received;
}

const TEMP_PREFIX = "ntab_";

/** Jalankan pekerjaan dengan folder sementara yang selalu dihapus sesudahnya. */
export async function withTempDir<T>(job: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  try {
    return await job(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Buang folder sementara yang tertinggal dari proses sebelumnya (mis. setelah crash). */
export function cleanStaleTempDirs(): void {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith(TEMP_PREFIX)) {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      }
    }
  } catch {}
}
