import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { spawn } from "child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { InputFile } from "grammy";
import { BotModule, BotContext } from "../../core/engine/types";
import { config } from "../../core/config";
import { fetchJson, downloadToFile, withTempDir } from "../../core/tools/http";
import { Semaphore } from "../../core/tools/limit";
import { downloadTelegramFile, TG_DOWNLOAD_MAX, TG_UPLOAD_MAX } from "../../core/tools/media";
import { htmlEscape } from "../../core/tools/text";
import { progress, reply } from "../../core/tools/ui";

const ffmpegJobs = new Semaphore(config.limits.ffmpegJobs);
const FFMPEG_TIMEOUT_MS = 90_000;
const UGOIRA_ZIP_MAX = 30 * 1024 * 1024;
const HLS_MAX_BYTES = 200 * 1024 * 1024;
const HLS_MAX_PLAYLIST_BYTES = 1024 * 1024;
const HLS_MAX_SEGMENTS = 500;
const HLS_TIMEOUT_MS = 120_000;
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
function runFfmpeg(args: string[], maxOutputBytes?: number): Promise<void> {
  const fullArgs = ["-hide_banner", "-loglevel", "error", "-y", "-threads", "1", ...args];
  const [bin, binArgs] = process.platform === "win32" ? ["ffmpeg", fullArgs] : ["nice", ["-n", "15", "ffmpeg", ...fullArgs]];
  const outputPath = maxOutputBytes === undefined ? undefined : args[args.length - 1];

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, binArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let outputTooLarge = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    const sizeMonitor = outputPath
      ? setInterval(() => {
          if (!fs.existsSync(outputPath)) return;
          if (fs.statSync(outputPath).size > maxOutputBytes!) {
            outputTooLarge = true;
            proc.kill("SIGKILL");
          }
        }, 100)
      : undefined;

    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-500)));
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (sizeMonitor) clearInterval(sizeMonitor);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (sizeMonitor) clearInterval(sizeMonitor);
      if (outputTooLarge) reject(new Error("Hasil MP4 melebihi batas kirim Telegram 50 MB."));
      else if (timedOut) reject(new Error("Konversi melebihi batas waktu 90 detik. Coba berkas yang lebih pendek."));
      else if (code === 0) resolve();
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

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return (
      (normalized.startsWith("2") || normalized.startsWith("3")) &&
      !normalized.startsWith("2001:db8:") &&
      !normalized.startsWith("2001:10:")
    );
  }
  return false;
}

async function validateHlsUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Tautan HLS harus menggunakan HTTPS dan tidak boleh berisi kredensial.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Tautan HLS mengarah ke alamat server privat atau tidak valid.");
  }
  return url;
}

async function fetchHlsResponse(rawUrl: string, deadline: number): Promise<{ response: Response; url: URL }> {
  let url = rawUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const checked = await validateHlsUrl(url);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Unduhan HLS melebihi batas waktu.");

    const response = await fetch(checked, {
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      headers: { "User-Agent": "NtabBot/3.0 (Telegram bot)" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Situs HLS mengirim pengalihan yang tidak valid.");
      url = new URL(location, checked).href;
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Gagal mengunduh sumber HLS (HTTP ${response.status}).`);
    return { response, url: checked };
  }
  throw new Error("Tautan HLS terlalu banyak dialihkan.");
}

async function readHlsPlaylist(url: string, deadline: number): Promise<{ text: string; url: URL }> {
  const { response, url: finalUrl } = await fetchHlsResponse(url, deadline);
  const body = response.body;
  if (!body) throw new Error("Playlist HLS kosong.");
  const declared = Number(response.headers.get("content-length"));
  if (declared > HLS_MAX_PLAYLIST_BYTES) {
    await body.cancel();
    throw new Error("Daftar HLS terlalu besar.");
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of body) {
    const data = Buffer.from(chunk);
    received += data.length;
    if (received > HLS_MAX_PLAYLIST_BYTES) {
      await body.cancel();
      throw new Error("Daftar HLS terlalu besar.");
    }
    chunks.push(data);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), url: finalUrl };
}

async function downloadHlsResource(
  url: string,
  outputPath: string,
  budget: { bytes: number; segments: number; deadline: number },
  maxResourceBytes = HLS_MAX_BYTES
): Promise<void> {
  const { response } = await fetchHlsResponse(url, budget.deadline);
  const remaining = Math.min(HLS_MAX_BYTES - budget.bytes, maxResourceBytes);
  const declared = Number(response.headers.get("content-length"));
  if (remaining <= 0 || (declared > 0 && declared > remaining)) {
    await response.body?.cancel();
    throw new Error("Ukuran unduhan HLS melewati batas 200 MB.");
  }

  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      done(received > remaining ? new Error("Ukuran unduhan HLS melewati batas 200 MB.") : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as any), limiter, fs.createWriteStream(outputPath));
    budget.bytes += received;
    budget.segments++;
    if (budget.segments > HLS_MAX_SEGMENTS) throw new Error("Playlist HLS memiliki terlalu banyak segmen.");
  } catch (err) {
    fs.rmSync(outputPath, { force: true });
    throw err;
  }
}

async function downloadHlsPlaylist(url: string, dir: string): Promise<{ playlistPath: string; inputBytes: number }> {
  const budget = { bytes: 0, segments: 0, deadline: Date.now() + HLS_TIMEOUT_MS };
  let playlistUrl = url;
  let mediaText = "";

  for (let depth = 0; depth < 3; depth++) {
    const playlist = await readHlsPlaylist(playlistUrl, budget.deadline);
    budget.bytes += Buffer.byteLength(playlist.text);
    playlistUrl = playlist.url.href;
    const lines = playlist.text.split(/\r?\n/).map((line) => line.trim());
    if (lines[0] !== "#EXTM3U") throw new Error("Tautan tersebut bukan playlist HLS yang valid.");

    const variants: Array<{ bandwidth: number; url: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
      const uri = lines.slice(i + 1).find((line) => line && !line.startsWith("#"));
      if (uri) {
        const bandwidth = Number(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
        variants.push({ bandwidth, url: new URL(uri, playlistUrl).href });
      }
    }
    if (variants.length > 0) {
      if (lines.some((line) => line.startsWith("#EXT-X-SESSION-KEY:"))) {
        throw new Error("Playlist HLS master dengan session-key belum didukung.");
      }
      if (lines.some((line) => line.startsWith("#EXT-X-MEDIA:TYPE=AUDIO") && /URI="/.test(line))) {
        throw new Error("Playlist HLS dengan audio terpisah belum didukung.");
      }
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      playlistUrl = variants[0].url;
      continue;
    }

    mediaText = playlist.text;
    break;
  }

  const lines = mediaText.split(/\r?\n/).map((line) => line.trim());
  if (!mediaText || lines[0] !== "#EXTM3U") throw new Error("Playlist HLS tidak berisi daftar video.");
  if (!lines.includes("#EXT-X-ENDLIST")) throw new Error("Hanya playlist HLS VOD yang sudah selesai dapat diproses.");
  if (lines.some((line) => line.startsWith("#EXT-X-BYTERANGE:"))) {
    throw new Error("Playlist HLS dengan byte-range belum didukung.");
  }

  const localLines: string[] = [];
  let resourceId = 0;
  for (const line of lines) {
    if (!line) {
      localLines.push(line);
      continue;
    }

    if (line.startsWith("#EXT-X-KEY:")) {
      const method = line.match(/METHOD=([^,]+)/)?.[1];
      if (method === "NONE") {
        localLines.push(line);
        continue;
      }
      if (method !== "AES-128" || /KEYFORMAT=(?!"identity")/.test(line)) {
        throw new Error("Playlist memakai enkripsi HLS yang belum didukung.");
      }
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (!uri) throw new Error("Playlist HLS memiliki key yang tidak valid.");
      const localName = `hls_key_${resourceId++}.bin`;
      await downloadHlsResource(new URL(uri, playlistUrl).href, path.join(dir, localName), budget, 16);
      localLines.push(line.replace(/URI="[^"]+"/, `URI="${localName}"`));
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (!uri || /BYTERANGE=/.test(line)) throw new Error("Playlist memiliki init segment yang belum didukung.");
      const localName = `hls_init_${resourceId++}.bin`;
      await downloadHlsResource(new URL(uri, playlistUrl).href, path.join(dir, localName), budget);
      localLines.push(line.replace(/URI="[^"]+"/, `URI="${localName}"`));
      continue;
    }

    if (line.startsWith("#")) {
      localLines.push(line);
      continue;
    }

    const localName = `hls_segment_${String(resourceId++).padStart(4, "0")}.bin`;
    await downloadHlsResource(new URL(line, playlistUrl).href, path.join(dir, localName), budget);
    localLines.push(localName);
  }

  if (budget.segments === 0) throw new Error("Playlist HLS tidak memiliki segmen video.");
  const playlistPath = path.join(dir, "input.m3u8");
  fs.writeFileSync(playlistPath, localLines.join("\n"));
  return { playlistPath, inputBytes: budget.bytes };
}

function m3u8Link(ctx: BotContext, args: string): { url?: string; invalid?: boolean } {
  const replied = ctx.message?.reply_to_message;
  const text = [args, replied?.text, replied?.caption].filter(Boolean).join("\n");
  const links = text.match(/https:\/\/[^\s<>"']+/gi) ?? [];
  const link = links[0]?.replace(/[),.;!?]+$/, "");
  if (!link) return {};

  try {
    const url = new URL(link);
    return /\.m3u8$/i.test(url.pathname) ? { url: url.href } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

async function sendCompressedVideo(ctx: BotContext, outputPath: string, inputBytes: number): Promise<void> {
  const outputBytes = fs.statSync(outputPath).size;
  if (outputBytes >= inputBytes) {
    throw new Error("Hasil kompresi tidak lebih kecil dari sumber; hasil yang lebih besar tidak dikirim.");
  }
  if (outputBytes > TG_UPLOAD_MAX) throw new Error("Hasil masih melebihi batas kirim Telegram 50 MB.");

  const savedPercent = Math.round((1 - outputBytes / inputBytes) * 100);
  const sizeMb = (size: number) => `${(size / 1024 / 1024).toFixed(1)} MB`;
  await ctx.replyWithVideo(new InputFile(outputPath, "compressed.mp4"), {
    caption: `✅ Video terkompresi\n${sizeMb(inputBytes)} → ${sizeMb(outputBytes)} (hemat ${savedPercent}%).`,
  });
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
  ], TG_UPLOAD_MAX);
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
    "Balas (reply) pesan berisi video, lalu kirim perintahnya: /mp3, /gif, atau /mp4.",
    "/mp4 menerima balasan video atau tautan HTTPS berakhiran .m3u8. Untuk tautan, playlist dan segmennya diunduh dulu sebelum diproses.",
    "Kompresi H.264 (preset veryfast, CRF 28) mempertahankan resolusi; hasil dikirim sebagai file baru, video sumber tidak diubah.",
    "Unduhan HLS dibatasi 200 MB, 500 segmen, dan hanya playlist VOD; hasil MP4 harus lebih kecil dari sumber dan maksimal 50 MB.",
    "Ukuran berkas maksimal 20 MB (batas unduh bot Telegram).",
    "Konversi diproses satu per satu; bila server sibuk, coba lagi sebentar kemudian.",
  ],

  commands: [
    {
      command: "mp4",
      description: "Kompres video menjadi MP4 yang lebih kecil",
      usage: "balas video dengan /mp4 atau kirim /mp4 <tautan.m3u8>",
      listed: true,
      async handler(ctx, args) {
        const hls = m3u8Link(ctx, args);
        if (hls.invalid) return reply(ctx, "ℹ️ Berikan tautan HTTPS yang berakhiran <code>.m3u8</code>, atau balas sebuah video dengan <code>/mp4</code>.");
        if (hls.url) {
          const playlistUrl = hls.url;
          await convert(ctx, "Mengunduh playlist HLS lalu mengompres video...", async (dir) => {
            const { playlistPath, inputBytes } = await downloadHlsPlaylist(playlistUrl, dir);
            const out = path.join(dir, "compressed.mp4");
            await runFfmpeg([
              "-protocol_whitelist", "file,crypto,data",
              "-allowed_extensions", "ALL",
              "-i", playlistPath,
              "-map", "0:v:0",
              "-map", "0:a?",
              "-map_metadata", "0",
              "-c:v", "libx264",
              "-threads:v", "1",
              "-preset", "veryfast",
              "-crf", "28",
              "-c:a", "aac",
              "-b:a", "128k",
              "-movflags", "+faststart",
              out,
            ], TG_UPLOAD_MAX);
            await sendCompressedVideo(ctx, out, inputBytes);
          });
          return;
        }

        const media = repliedMedia(ctx, false);
        if (!media) return reply(ctx, "ℹ️ Balas (reply) pesan berisi video dengan <code>/mp4</code>.");
        if (tooBig(media)) return reply(ctx, "⚠️ Berkas terlalu besar. Maksimal 20 MB.");

        await convert(ctx, "Mengompres video menjadi MP4...", async (dir) => {
          const input = await downloadTelegramFile(ctx, media.file_id, dir);
          const out = path.join(dir, "compressed.mp4");
          const inputSize = fs.statSync(input).size;

          // Preset yang dipakai VideoToolkit: ukuran lebih kecil dengan penurunan visual
          // yang biasanya sulit terlihat. Resolusi dan frame rate sumber dipertahankan.
          await runFfmpeg([
            "-i", input,
            "-map", "0:v:0",
            "-map", "0:a?",
            "-map_metadata", "0",
            "-c:v", "libx264",
            "-threads:v", "1",
            "-preset", "veryfast",
            "-crf", "28",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            out,
          ]);

          await sendCompressedVideo(ctx, out, inputSize);
        });
      },
    },
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
