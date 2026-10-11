import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { spawn } from "child_process";
import { InputFile } from "grammy";
import { BotModule, BotContext } from "../../core/engine/types";
import { config } from "../../core/config";
import { fetchJson, downloadToFile, withTempDir } from "../../core/tools/http";
import { Semaphore } from "../../core/tools/limit";
import { downloadTelegramFile, TG_DOWNLOAD_MAX } from "../../core/tools/media";
import { htmlEscape } from "../../core/tools/text";
import { progress, reply } from "../../core/tools/ui";

const ffmpegJobs = new Semaphore(config.limits.ffmpegJobs);
const FFMPEG_TIMEOUT_MS = 90_000;
const UGOIRA_ZIP_MAX = 30 * 1024 * 1024;
const BUSY = "⏳ Server sedang mengonversi berkas lain. Coba lagi sebentar lagi.";

// ============================================================================
// FFMPEG
// ============================================================================
let ffmpegFound: boolean | null = null;

function hasFfmpeg(): Promise<boolean> {
  if (ffmpegFound) return Promise.resolve(true);
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve((ffmpegFound = code === 0)));
  });
}

/**
 * Jalankan ffmpeg dengan satu thread dan prioritas rendah,
 * supaya layanan lain di server yang sama tidak terganggu.
 */
function runFfmpeg(args: string[]): Promise<void> {
  const fullArgs = ["-hide_banner", "-loglevel", "error", "-y", "-threads", "1", ...args];
  const [bin, binArgs] = process.platform === "win32" ? ["ffmpeg", fullArgs] : ["nice", ["-n", "15", "ffmpeg", ...fullArgs]];

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, binArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("Konversi melebihi batas waktu 90 detik. Coba berkas yang lebih pendek."));
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-500)));
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        console.warn("[media-tools] ffmpeg:", stderr.trim());
        reject(new Error("Berkas tidak bisa dikonversi (format tidak didukung atau rusak)."));
      }
    });
  });
}

/**
 * Kerangka semua konversi: cek ffmpeg, ambil giliran, siapkan folder sementara,
 * tampilkan progres, lalu bersihkan apa pun hasilnya.
 */
async function convert(ctx: BotContext, label: string, job: (dir: string) => Promise<void>): Promise<void> {
  if (!(await hasFfmpeg())) {
    await reply(ctx, "⚠️ Fitur ini belum tersedia: FFmpeg belum terpasang di server.");
    return;
  }

  const ran = await ffmpegJobs.tryRun(async () => {
    const wait = await progress(ctx, `⏳ ${label}`);
    try {
      await withTempDir(job);
      await wait.done();
    } catch (err) {
      await wait.fail(`❌ ${htmlEscape((err as Error).message || "Terjadi kesalahan.")}`);
    }
  });
  if (!ran) await reply(ctx, BUSY);
}

type TgMedia = { file_id: string; file_size?: number };

/** Media pada pesan yang dibalas, sesuai jenis yang diterima perintah. */
function repliedMedia(ctx: BotContext, withAudio: boolean): TgMedia | null {
  const m = ctx.message?.reply_to_message;
  if (!m) return null;
  const videoDoc = m.document?.mime_type?.startsWith("video/") ? m.document : undefined;
  return m.video ?? m.video_note ?? m.animation ?? videoDoc ?? (withAudio ? m.voice ?? m.audio : undefined) ?? null;
}

function tooBig(media: TgMedia): boolean {
  return (media.file_size ?? 0) > TG_DOWNLOAD_MAX;
}

// ============================================================================
// UGOIRA (animasi Pixiv)
// ============================================================================
/** Pembaca ZIP minimal: cukup untuk arsip frame ugoira, tanpa program eksternal. */
function unzipFrames(zipPath: string, destDir: string): void {
  const zip = fs.readFileSync(zipPath);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Arsip frame rusak.");

  const total = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);

  for (let i = 0; i < total; i++) {
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error("Arsip frame rusak.");
    const method = zip.readUInt16LE(pos + 10);
    const compressedSize = zip.readUInt32LE(pos + 20);
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.toString("utf8", pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    // Hanya nama berkas polos; menolak jalur seperti "../x" (zip-slip)
    if (!/^[\w.-]+$/.test(name)) continue;

    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    fs.writeFileSync(path.join(destDir, name), method === 8 ? zlib.inflateRawSync(raw) : raw);
  }
}

async function renderUgoira(illustId: string, dir: string): Promise<string> {
  const meta = await fetchJson<{ error: boolean; body?: { originalSrc?: string; src?: string; frames?: Array<{ file: string; delay: number }> } }>(
    `https://www.pixiv.net/ajax/illust/${illustId}/ugoira_meta`,
    { headers: { Referer: `https://www.pixiv.net/artworks/${illustId}` } }
  ).catch(() => null);

  const src = meta?.body?.originalSrc || meta?.body?.src;
  const frames = (meta?.body?.frames ?? []).filter((f) => /^[\w.-]+$/.test(f.file)).slice(0, 600);
  if (!src || frames.length === 0) throw new Error(`Karya #${illustId} bukan animasi ugoira, atau tidak ditemukan.`);

  const framesDir = path.join(dir, "frames");
  fs.mkdirSync(framesDir);
  const zipPath = path.join(dir, "frames.zip");
  await downloadToFile(src, zipPath, { maxBytes: UGOIRA_ZIP_MAX, timeoutMs: 60_000 });
  unzipFrames(zipPath, framesDir);
  fs.rmSync(zipPath);

  // Daftar frame + durasi asli untuk ffmpeg (frame terakhir wajib ditulis ulang)
  const lines = frames.map((f) => `file 'frames/${f.file}'\nduration ${(f.delay / 1000).toFixed(3)}`);
  lines.push(`file 'frames/${frames[frames.length - 1].file}'`);
  const listPath = path.join(dir, "list.txt");
  fs.writeFileSync(listPath, lines.join("\n"));

  const out = path.join(dir, "ugoira.mp4");
  await runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", "scale='min(1280,iw)':-2,pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
    out,
  ]);
  return out;
}

// ============================================================================
// MODUL
// ============================================================================
const mediaTools: BotModule = {
  meta: {
    id: "media-tools",
    name: "Media Tools",
    emoji: "🎬",
    description: "Ubah video jadi MP3 atau GIF, dan animasi Pixiv (ugoira) jadi video.",
    category: "tool",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
  },
  help: [
    "Balas (reply) pesan berisi video, lalu kirim perintahnya.",
    "Ukuran berkas maksimal 20 MB (batas unduh bot Telegram).",
    "Konversi diproses satu per satu; bila server sibuk, coba lagi sebentar kemudian.",
  ],

  commands: [
    {
      command: "mp3",
      aliases: ["toaudio"],
      description: "Ambil audio dari video atau pesan suara",
      usage: "balas video dengan /mp3",
      listed: true,
      async handler(ctx) {
        const media = repliedMedia(ctx, true);
        if (!media) return reply(ctx, "ℹ️ Balas (reply) pesan berisi video, video bulat, atau pesan suara dengan <code>/mp3</code>.");
        if (tooBig(media)) return reply(ctx, "⚠️ Berkas terlalu besar. Maksimal 20 MB.");

        await convert(ctx, "Mengambil audio...", async (dir) => {
          const input = await downloadTelegramFile(ctx, media.file_id, dir);
          const out = path.join(dir, "audio.mp3");
          await runFfmpeg(["-i", input, "-vn", "-c:a", "libmp3lame", "-b:a", "160k", out]);
          await ctx.replyWithAudio(new InputFile(out, "audio.mp3"));
        });
      },
    },
    {
      command: "gif",
      aliases: ["togif"],
      description: "Ubah video jadi GIF (animasi tanpa suara)",
      usage: "balas video dengan /gif",
      listed: true,
      async handler(ctx) {
        const media = repliedMedia(ctx, false);
        if (!media) return reply(ctx, "ℹ️ Balas (reply) pesan berisi video dengan <code>/gif</code>.");
        if (tooBig(media)) return reply(ctx, "⚠️ Berkas terlalu besar. Maksimal 20 MB.");

        await convert(ctx, "Mengubah video jadi GIF...", async (dir) => {
          const input = await downloadTelegramFile(ctx, media.file_id, dir);
          const out = path.join(dir, "animation.mp4");
          // Dibatasi 30 detik pertama, 15 fps, lebar maks 480 px agar ringan diproses
          await runFfmpeg([
            "-t", "30", "-i", input,
            "-vf", "fps=15,scale='min(480,iw)':-2",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
            out,
          ]);
          await ctx.replyWithAnimation(new InputFile(out, "animation.mp4"));
        });
      },
    },
    {
      command: "ugoira",
      description: "Unduh animasi Pixiv (ugoira) sebagai video",
      usage: "/ugoira <ID karya Pixiv>",
      async handler(ctx, args) {
        const illustId = args.match(/\d{4,}/)?.[0];
        if (!illustId) return reply(ctx, "ℹ️ Tulis ID karyanya, contoh: <code>/ugoira 99040957</code>");

        const caption = `🎬 <a href="https://www.pixiv.net/artworks/${illustId}">Pixiv #${illustId}</a>`;
        const cacheKey = `media-tools:ugoira:${illustId}`;
        const cached = ctx.db.getFileId(cacheKey);
        if (cached) {
          const ok = await ctx.replyWithAnimation(cached, { caption, parse_mode: "HTML" }).then(() => true, () => false);
          if (ok) return;
        }

        await convert(ctx, `Merender animasi Pixiv #${illustId}...`, async (dir) => {
          const out = await renderUgoira(illustId, dir);
          const sent = await ctx.replyWithAnimation(new InputFile(out, `ugoira_${illustId}.mp4`), { caption, parse_mode: "HTML" });
          const fileId = sent.animation?.file_id ?? sent.document?.file_id;
          if (fileId) ctx.db.setFileId(cacheKey, fileId, "animation");
        });
      },
    },
  ],
};

export default mediaTools;
