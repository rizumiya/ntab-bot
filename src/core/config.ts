import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config();

function str(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

function int(key: string, fallback: number): number {
  const n = parseInt(str(key), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function flag(key: string, fallback: boolean): boolean {
  const v = str(key).toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

/**
 * Satu-satunya tempat pembacaan variabel lingkungan (.env).
 * Modul memakai `config`, bukan `process.env`.
 */
export const config = {
  botToken: str("BOT_TOKEN"),
  ownerId: str("OWNER_ID"),
  dataDir: path.resolve(process.cwd(), str("DATA_DIR", "data")),
  logLevel: str("LOG_LEVEL", "info").toLowerCase() as "info" | "debug",

  proxy: {
    enabled: flag("ENABLE_IMAGE_PROXY", false),
    host: str("PROXY_HOST", "127.0.0.1"),
    port: int("PROXY_PORT", 3080),
    publicUrl: str("PROXY_PUBLIC_URL").replace(/\/+$/, ""),
  },

  customDns: flag("ENABLE_CUSTOM_DNS", false),

  /** Mesin pencari yang dipakai saat user mengetik `@bot kata kunci` tanpa prefix. */
  defaultInlinePrefix: str("DEFAULT_INLINE_PREFIX", ".wh"),

  // Batas beban. Nilai bawaan aman untuk VPS kecil yang dipakai bersama layanan lain.
  limits: {
    updateConcurrency: int("MAX_UPDATE_CONCURRENCY", 8),
    albumJobs: int("MAX_ALBUM_JOBS", 2),
    ffmpegJobs: int("MAX_FFMPEG_JOBS", 1),
    proxyConnections: int("MAX_PROXY_CONNECTIONS", 24),
  },

  /** Alamat situs Kiryuu. Domainnya sesekali berganti (v7, v8, ...), jadi bisa diubah tanpa menyentuh kode. */
  kiryuuUrl: str("KIRYUU_URL", "https://v7.kiryuu.to").replace(/\/+$/, ""),
  saucenaoKey: str("SAUCENAO_API_KEY"),
  /** Cookie PHPSESSID akun Pixiv. Dengan ini pencarian ikut memuat karya berlabel dewasa. */
  pixivSession: str("PIXIV_PHPSESSID"),

  gelbooru: {
    userId: str("GELBOORU_USER_ID"),
    apiKey: str("GELBOORU_API_KEY"),
  },
};
