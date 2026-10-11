import * as fs from "fs";
import * as path from "path";
import { InputFile } from "grammy";
import { BotContext } from "../engine/types";
import { config } from "../config";
import { downloadToFile, withTempDir, TooLargeError } from "./http";
import { mapLimit, Semaphore } from "./limit";

/** Batas Telegram: foto maks 10 MB, dokumen kiriman bot maks 50 MB, unduhan bot maks 20 MB. */
export const TG_PHOTO_MAX = 10 * 1024 * 1024;
export const TG_UPLOAD_MAX = 50 * 1024 * 1024;
export const TG_DOWNLOAD_MAX = 20 * 1024 * 1024;

/** Cek tanda tangan berkas: JPEG, PNG, WebP, atau GIF (halaman error HTML dari CDN ditolak). */
function looksLikeImage(file: string): boolean {
  const head = Buffer.alloc(12);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  const hex = head.toString("hex");
  return hex.startsWith("ffd8") || hex.startsWith("89504e47") || hex.startsWith("47494638") || head.toString("ascii", 8, 12) === "WEBP";
}

/** Pembatas global untuk pengiriman album, dipakai bersama oleh semua modul. */
export const albumJobs = new Semaphore(config.limits.albumJobs);

export interface AlbumItem {
  /** Kunci cache file_id, mis. "scraper-wallhaven:abc123". */
  cacheKey: string;
  url: string;
  /** Dipakai jika `url` gagal atau melebihi batas ukuran foto Telegram. */
  fallbackUrl?: string;
}

/**
 * Kirim daftar gambar sebagai album (10 foto per album).
 * - Gambar yang pernah terkirim memakai file_id tersimpan: tanpa unduh ulang.
 * - Sisanya diunduh ke disk sementara (bukan RAM), paling banyak 4 sekaligus.
 * Mengembalikan jumlah foto yang terkirim.
 */
export async function sendAlbum(ctx: BotContext, items: AlbumItem[]): Promise<number> {
  let sent = 0;

  await withTempDir(async (dir) => {
    for (let start = 0; start < items.length; start += 10) {
      const chunk = items.slice(start, start + 10);

      const prepared = await mapLimit(chunk, 4, async (item, i) => {
        const cached = ctx.db.getFileId(item.cacheKey);
        if (cached) return { item, media: cached as string | InputFile };

        const file = path.join(dir, `${start + i}.img`);
        for (const url of [item.url, item.fallbackUrl]) {
          if (!url) continue;
          try {
            await downloadToFile(url, file, { maxBytes: TG_PHOTO_MAX, timeoutMs: 20_000 });
            if (!looksLikeImage(file)) continue;
            return { item, media: new InputFile(file) as string | InputFile };
          } catch {}
        }
        return null;
      });

      const ready = prepared.filter((p) => p !== null);
      if (ready.length === 0) continue;

      const remember = (item: AlbumItem, photo?: Array<{ file_id: string }>) => {
        const fileId = photo?.[photo.length - 1]?.file_id;
        if (fileId) ctx.db.setFileId(item.cacheKey, fileId, "photo");
      };

      try {
        if (ready.length === 1) {
          const msg = await ctx.replyWithPhoto(ready[0].media);
          remember(ready[0].item, msg.photo);
        } else {
          const messages = await ctx.replyWithMediaGroup(ready.map((r) => ({ type: "photo" as const, media: r.media })));
          messages.forEach((msg, i) => remember(ready[i].item, "photo" in msg ? msg.photo : undefined));
        }
        sent += ready.length;
      } catch {
        // Satu gambar bermasalah menggagalkan seluruh album: kirim ulang satu per satu
        for (const r of ready) {
          try {
            const msg = await ctx.replyWithPhoto(r.media);
            remember(r.item, msg.photo);
            sent++;
          } catch {}
        }
      }
    }
  });

  return sent;
}

/**
 * Unduh berkas kiriman pengguna dari Telegram ke disk.
 * Token bot hanya dipakai di sini dan tidak pernah diteruskan ke pihak ketiga.
 */
export async function downloadTelegramFile(ctx: BotContext, fileId: string, destDir: string): Promise<string> {
  const info = await ctx.api.getFile(fileId);
  if (!info.file_path) throw new Error("Telegram tidak memberikan lokasi berkas.");

  const dest = path.join(destDir, `input${path.extname(info.file_path) || ".bin"}`);
  try {
    await downloadToFile(`https://api.telegram.org/file/bot${config.botToken}/${info.file_path}`, dest, {
      maxBytes: TG_DOWNLOAD_MAX,
      timeoutMs: 60_000,
    });
  } catch (err: any) {
    if (err instanceof TooLargeError) throw new Error("Berkas terlalu besar. Bot hanya bisa mengunduh berkas sampai 20 MB.");
    // Pesan error bawaan bisa memuat URL bertoken; ganti dengan pesan netral
    throw new Error(err?.name === "TimeoutError" ? "Waktu unduh dari Telegram habis." : "Gagal mengunduh berkas dari Telegram.");
  }
  return dest;
}
