import * as fs from "fs";
import { InlineKeyboard } from "grammy";
import { BotModule, BotContext } from "../../core/engine/types";
import { config } from "../../core/config";
import { fetchJson, withTempDir } from "../../core/tools/http";
import { Cooldown } from "../../core/tools/limit";
import { downloadTelegramFile } from "../../core/tools/media";
import { htmlEscape } from "../../core/tools/text";
import { progress, reply } from "../../core/tools/ui";

/**
 * Dua mesin, dipakai berurutan:
 * 1. trace.moe: tangkapan layar anime (judul, episode, menit adegan).
 * 2. SauceNAO: fanart dan ilustrasi (kreator, tautan Pixiv/Danbooru/dll). Hanya bila SAUCENAO_API_KEY diisi.
 */

interface Found {
  text: string;
  keyboard: InlineKeyboard;
  /** Kecocokan dalam persen. */
  score: number;
  preview?: string;
}

/** Di bawah nilai ini hasil trace.moe biasanya keliru, sehingga SauceNAO ikut dicoba. */
const ANIME_CONFIDENT = 90;
/** Di bawah nilai ini hasil SauceNAO dianggap bukan gambar yang sama. */
const ARTWORK_MIN = 60;

// Kedua layanan gratis dibatasi per server: jeda per user menjaga jatah bersama
const cooldown = new Cooldown(10_000);

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

async function searchAnime(image: Buffer): Promise<Found | null> {
  const data = await fetchJson<{ result?: any[] }>("https://api.trace.moe/search?anilistInfo&cutBorders", {
    method: "POST",
    body: new Uint8Array(image),
    headers: { "Content-Type": "image/jpeg" },
    timeoutMs: 25_000,
  });
  const top = data.result?.[0];
  if (!top) return null;

  const t = top.anilist?.title ?? {};
  const title = t.romaji || t.english || t.native || "Tidak diketahui";
  const score = top.similarity * 100;

  const keyboard = new InlineKeyboard();
  if (top.video) keyboard.url("▶️ Cuplikan adegan", top.video);
  if (top.anilist?.id) keyboard.url("ℹ️ AniList", `https://anilist.co/anime/${top.anilist.id}`);

  return {
    score,
    keyboard,
    preview: top.image,
    text:
      `🎬 <b>${htmlEscape(title)}</b>\n` +
      (t.english && t.english !== title ? `${htmlEscape(t.english)}\n` : "") +
      `\n📺 ${top.episode != null ? `Episode ${htmlEscape(top.episode)}` : "Film / OVA"} · ⏱️ ${clock(top.from)} - ${clock(top.to)}\n` +
      `🎯 Kecocokan ${score.toFixed(1)}%`,
  };
}

async function searchArtwork(image: Buffer): Promise<Found | null> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(image)], { type: "image/jpeg" }), "image.jpg");

  const data = await fetchJson<{ results?: any[] }>(
    `https://saucenao.com/search.php?output_type=2&numres=3&api_key=${encodeURIComponent(config.saucenaoKey)}`,
    { method: "POST", body: form, timeoutMs: 25_000 }
  );
  const top = (data.results ?? []).sort((a, b) => Number(b.header.similarity) - Number(a.header.similarity))[0];
  if (!top) return null;

  const d = top.data ?? {};
  const title = d.title || d.source || d.material || d.eng_name || "Tanpa judul";
  const creator = [d.member_name, d.creator, d.author_name].flat().filter(Boolean)[0];
  const score = Number(top.header.similarity);

  const keyboard = new InlineKeyboard();
  (d.ext_urls ?? []).slice(0, 3).forEach((url: string, i: number) => {
    let host = "Sumber";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {}
    keyboard.url(`🔗 ${host}`, url);
    if (i % 2 === 1) keyboard.row();
  });

  return {
    score,
    keyboard,
    preview: top.header.thumbnail,
    text:
      `🎨 <b>${htmlEscape(title)}</b>\n` +
      (creator ? `✍️ ${htmlEscape(creator)}\n` : "") +
      (d.characters ? `👤 ${htmlEscape(d.characters)}\n` : "") +
      `\n🗂️ ${htmlEscape(String(top.header.index_name ?? "").split(" - ")[0].replace(/^Index #\d+:\s*/, ""))}\n` +
      `🎯 Kecocokan ${score.toFixed(1)}%`,
  };
}

async function findSource(ctx: BotContext): Promise<void> {
  const photo = (ctx.message?.photo ?? ctx.message?.reply_to_message?.photo)?.at(-1);
  if (!photo) {
    await reply(
      ctx,
      `🔍 <b>Cari sumber gambar</b>\n\n` +
        `• Balas (reply) sebuah foto dengan <code>/sauce</code>, atau\n` +
        `• kirim foto dengan caption <code>/sauce</code>.\n\n` +
        `Mengenali tangkapan layar anime` +
        (config.saucenaoKey ? ", fanart, dan ilustrasi." : ".")
    );
    return;
  }

  const waitSeconds = cooldown.hit(ctx.user.id);
  if (waitSeconds > 0) {
    await reply(ctx, `⏳ Tunggu ${waitSeconds} detik sebelum mencari lagi.`);
    return;
  }

  const wait = await progress(ctx, "🔍 Mencari sumber gambar...");
  try {
    // Gambar diunggah langsung; tautan berkas Telegram (yang memuat token bot) tidak pernah dibagikan
    const image = await withTempDir(async (dir) => fs.readFileSync(await downloadTelegramFile(ctx, photo.file_id, dir)));

    const warn = (engine: string) => (err: Error) => {
      console.warn(`[reverse-search] ${engine} gagal:`, err.message);
      return null;
    };
    const anime = await searchAnime(image).catch(warn("trace.moe"));
    let best = anime;

    if ((!anime || anime.score < ANIME_CONFIDENT) && config.saucenaoKey) {
      const artwork = await searchArtwork(image).catch(warn("SauceNAO"));
      if (artwork && artwork.score >= ARTWORK_MIN && artwork.score >= (anime?.score ?? 0) - 10) best = artwork;
    }

    if (!best) return await wait.fail("❌ Sumber tidak ditemukan. Coba gambar yang lebih utuh (tanpa potongan atau teks tambahan).");

    const text = best.text + (best.score < 80 ? "\n\n⚠️ <i>Kecocokan rendah, hasil ini mungkin keliru.</i>" : "");
    await wait.done();
    if (best.preview) {
      await ctx.replyWithPhoto(best.preview, { caption: text, parse_mode: "HTML", reply_markup: best.keyboard }).catch(() => reply(ctx, text, best!.keyboard));
    } else {
      await reply(ctx, text, best.keyboard);
    }
  } catch (err) {
    console.warn("[reverse-search] gagal:", (err as Error).message);
    await wait.fail(`❌ ${htmlEscape((err as Error).message.startsWith("HTTP") ? "Layanan pencarian sedang tidak bisa dihubungi." : (err as Error).message)}`);
  }
}

const reverseSearch: BotModule = {
  meta: {
    id: "reverse-search",
    name: "Cari Sumber Gambar",
    emoji: "🔍",
    description: "Temukan judul anime, episode, atau kreator dari sebuah gambar.",
    category: "tool",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.1.0",
  },
  help: [
    "Tangkapan layar anime dikenali lewat trace.moe: judul, episode, dan menit adegan.",
    "Fanart dan ilustrasi dikenali lewat SauceNAO: kreator dan tautan sumbernya.",
    "Kedua layanan gratis dan berbatas harian; bila habis, coba lagi beberapa saat kemudian.",
  ],

  commands: [
    {
      command: "sauce",
      aliases: ["source", "find"],
      description: "Cari sumber sebuah gambar",
      usage: "balas foto dengan /sauce",
      listed: true,
      handler: findSource,
    },
  ],
};

export default reverseSearch;
