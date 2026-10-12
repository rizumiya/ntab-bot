import { config } from "../config";
import { repo } from "../db/repo";
import { fetchJson } from "./http";

/**
 * Halaman Telegraph (telegra.ph): artikel yang dibuka Telegram sebagai Instant View.
 * Telegraph tidak lagi menerima unggahan berkas, jadi halaman hanya memuat TAUTAN gambar;
 * gambarnya sendiri tetap diambil pembaca dari server asalnya. Bot tidak mengunduh apa pun.
 */

const API = "https://api.telegra.ph";
const TOKEN_KEY = "telegraph:token";
/** Batas isi satu halaman Telegraph adalah 64 KB; sisanya disisakan untuk tautan "bagian berikutnya". */
const MAX_CONTENT_BYTES = 60 * 1024;
/**
 * Gambar per halaman. Telegram mengambil semua gambar sebuah halaman saat membuat Instant View dan
 * menyerah bila terlalu banyak/lama (teramati: 157 gambar berhasil, 218 gagal), jadi dijaga di bawah angka yang terbukti berhasil.
 */
const MAX_IMAGES_PER_PAGE = 150;

type Node = string | { tag: string; attrs?: Record<string, string>; children?: Node[] };

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const json = await fetchJson<{ ok: boolean; result?: T; error?: string }>(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    timeoutMs: 20_000,
  });
  if (!json.ok || json.result === undefined) throw new Error(`Telegraph: ${json.error ?? "jawaban tidak dikenal"}`);
  return json.result;
}

/** Token akun Telegraph bot ini: dari .env, atau dibuat sekali lalu disimpan di database. */
async function getToken(authorName: string, renew = false): Promise<string> {
  if (config.telegraphToken) return config.telegraphToken;

  const saved = renew ? null : repo.getValue(TOKEN_KEY);
  if (saved) return saved;

  const account = await call<{ access_token: string }>("createAccount", {
    short_name: authorName.slice(0, 32),
    author_name: authorName.slice(0, 128),
  });
  repo.setValue(TOKEN_KEY, account.access_token);
  return account.access_token;
}

async function createPage(page: { title: string; authorName: string; authorUrl?: string; content: Node[] }): Promise<string> {
  const send = async (token: string) =>
    (
      await call<{ url: string }>("createPage", {
        access_token: token,
        title: page.title.slice(0, 256),
        author_name: page.authorName.slice(0, 128),
        ...(page.authorUrl ? { author_url: page.authorUrl } : {}),
        content: page.content,
      })
    ).url;

  try {
    return await send(await getToken(page.authorName));
  } catch (err) {
    // Token tersimpan dicabut/kedaluwarsa: buat akun baru sekali, lalu ulangi
    if (config.telegraphToken || !/ACCESS_TOKEN_INVALID/.test((err as Error).message)) throw err;
    return send(await getToken(page.authorName, true));
  }
}

export interface TelegraphAlbum {
  title: string;
  authorName: string;
  authorUrl?: string;
  /** URL gambar (HTTPS, bisa diambil publik), sesuai urutan baca. */
  images: string[];
}

/**
 * Terbitkan deretan gambar sebagai halaman Telegraph.
 * Bila gambarnya terlalu banyak untuk satu halaman, dibuat beberapa bagian sama besar yang saling
 * bersambung ("Judul (2/3)"). Mengembalikan URL tiap bagian, berurutan.
 */
export async function publishTelegraphAlbum(album: TelegraphAlbum): Promise<string[]> {
  // Dibagi rata (218 gambar = 2 x 109), bukan 150 + 68
  const perPart = Math.ceil(album.images.length / Math.ceil(album.images.length / MAX_IMAGES_PER_PAGE));
  const parts: Node[][] = [[]];
  let bytes = 0;
  for (const src of album.images) {
    const node: Node = { tag: "img", attrs: { src } };
    const size = Buffer.byteLength(JSON.stringify(node)) + 1;
    const current = parts[parts.length - 1];
    if (current.length > 0 && (current.length >= perPart || bytes + size > MAX_CONTENT_BYTES)) {
      parts.push([]);
      bytes = 0;
    }
    parts[parts.length - 1].push(node);
    bytes += size;
  }

  // Dibuat dari bagian terakhir, supaya tiap bagian bisa menaut ke bagian sesudahnya
  const urls: string[] = [];
  let nextUrl = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    const content = [...parts[i]];
    if (nextUrl) {
      content.push({ tag: "p", children: [{ tag: "a", attrs: { href: nextUrl }, children: [`Lanjut ke bagian ${i + 2} dari ${parts.length} ▶`] }, " (agar tetap Instant View: kembali ke bot, tekan tombol Bagian berikutnya)"] });
    }
    nextUrl = await createPage({
      title: parts.length > 1 ? `${album.title.slice(0, 240)} (${i + 1}/${parts.length})` : album.title,
      authorName: album.authorName,
      authorUrl: album.authorUrl,
      content,
    });
    urls.unshift(nextUrl);
  }
  return urls;
}
