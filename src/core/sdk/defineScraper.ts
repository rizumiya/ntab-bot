import * as path from "path";
import { InlineKeyboard, InputFile } from "grammy";
import { InlineQueryResult } from "grammy/types";
import { BotModule, BotContext, CommandDef, CallbackDef, InlineResultResponse } from "../engine/types";
import { nsfwAllowed } from "../engine/gate";
import { PLANS } from "../plans";
import { htmlEscape } from "../tools/text";
import { exclusionFilter, isMinorContent, isMinorQuery } from "../tools/tags";
import { downloadToFile, withTempDir, TooLargeError } from "../tools/http";
import { Cooldown } from "../tools/limit";
import { albumJobs, sendAlbum, TG_UPLOAD_MAX } from "../tools/media";
import { cb, progress, reply, toast } from "../tools/ui";

export interface ScraperItem {
  id: string;
  title: string;
  /** Gambar kecil untuk grid/preview. */
  thumbnailUrl: string;
  /** Halaman sumber di web. */
  postUrl: string;
  /** Berkas resolusi penuh, jika sudah diketahui dari hasil pencarian. */
  directHdUrl?: string;
  /** Gambar ukuran sedang (JPEG, di bawah 5 MB) untuk hasil inline. Bawaan: directHdUrl atau thumbnailUrl. */
  inlineUrl?: string;
  /** Ukuran gambar `inlineUrl`. Bila diisi, Telegram menata grid tanpa menunggu gambar termuat. */
  width?: number;
  height?: number;
  isNsfw?: boolean;
  /** Baris keterangan tambahan dalam HTML. Nilai dari web sumber wajib di-`htmlEscape`. */
  info?: string;
  /** Tag mentah dari situs sumber. SDK yang menampilkannya (seragam di semua modul) dan menyaring tag yang dikecualikan pengguna. */
  tags?: string[];
  /** Bawaan "photo". "gif" dan "video" memakai `inlineUrl` sebagai berkas animasi/video (video wajib MP4). */
  media?: "photo" | "gif" | "video";
  /** Tombol pintas yang membuka pencarian inline lain, mis. karya lain dari kreator yang sama. */
  shortcuts?: Array<{ label: string; query: string }>;
}

export interface ScraperOptions {
  nsfw: boolean;
  /** `nextCursor` dari halaman sebelumnya (kosong di halaman pertama). */
  cursor?: string;
}

export interface ScraperSearchResult {
  items: ScraperItem[];
  hasNextPage: boolean;
  /**
   * Penanda posisi untuk halaman berikutnya, mis. ID terakhir.
   * Lebih andal daripada nomor halaman pada daftar yang terus bertambah (tidak ada item terulang).
   */
  nextCursor?: string;
}

export interface DefineScraperConfig {
  meta: BotModule["meta"];
  /** Mis. ".wh". Otomatis menjadi prefix inline, perintah `/wh`, dan perintah titik `.wh`. */
  prefix: string;
  search: (query: string, page: number, options: ScraperOptions) => Promise<ScraperSearchResult>;
  /** URL berkas resolusi penuh untuk tombol "File HD". */
  getHdUrl?: (postId: string) => Promise<string | null>;
  /** Judul & URL untuk disimpan sebagai bookmark. */
  getMetadata?: (postId: string) => Promise<{ title?: string; thumbUrl?: string; postUrl?: string } | null>;
  getPostUrl?: (postId: string) => string;
  getThumbnailUrl?: (postId: string) => string;

  /** "photo" = grid gambar (bawaan). "article" = daftar berjudul, mis. untuk manga. */
  display?: "photo" | "article";
  /** Ganti tombol bawaan pada tiap hasil inline. */
  itemKeyboard?: (item: ScraperItem, query: string) => InlineKeyboard;
  /** Ganti perintah bawaan (kirim album). */
  commands?: CommandDef[];
  /** Tombol tambahan di luar "dl" dan "fav". */
  callbacks?: CallbackDef[];
  bookmarks?: BotModule["bookmarks"];
  help?: string[];
}

const albumCooldown = new Cooldown(6000);
const MAX_INLINE_RESULTS = 50;
/** Batas `offset:` pada perintah album, dan jumlah halaman situs sumber yang boleh diambil untuk mencapainya. */
const MAX_ALBUM_OFFSET = 200;
const MAX_ALBUM_PAGES = 6;
const MAX_TAGS_SHOWN = 12;

/** Baris tag yang seragam untuk semua modul. Kosong bila item tidak punya tag. */
function tagLine(tags: string[] | undefined): string {
  if (!tags?.length) return "";
  // Tiap tag dibungkus <code>: di Telegram, mengetuknya langsung menyalin tag itu saja
  const shown = tags.slice(0, MAX_TAGS_SHOWN).map((tag) => `<code>${htmlEscape(tag)}</code>`).join(", ");
  const more = tags.length > MAX_TAGS_SHOWN ? ` +${tags.length - MAX_TAGS_SHOWN}` : "";
  return `🏷️ ${shown}${more}\n`;
}

const MINOR_QUERY_NOTE = "Bot ini tidak menampilkan konten anak di bawah umur. Kata kunci itu diblokir.";

/** Pemblokiran bawaan (bukan pilihan pengguna): item bertag anak di bawah umur tidak pernah ditampilkan. */
const isBlocked = (item: ScraperItem) => isMinorContent(item.tags, Boolean(item.isNsfw));

/** Pemeriksa "apakah gambar ini disembunyikan pengguna" menurut rumus /exclude miliknya. */
function userExclusions(ctx: BotContext): (tags: string[] | undefined) => boolean {
  return exclusionFilter(ctx.db.getUserSetting(ctx.user.id, "excluded_tags", ""));
}

/**
 * Bangun modul pencarian lengkap dari satu fungsi `search`:
 * mode inline, perintah album, tombol File HD, dan tombol bookmark.
 */
export function defineScraper(config: DefineScraperConfig): BotModule {
  const { meta, prefix } = config;
  const ns = prefix.replace(/^\./, "").toLowerCase();
  const display = config.display ?? "photo";

  const defaultKeyboard = (item: ScraperItem, query: string) => {
    const kb = new InlineKeyboard().text("📥 File HD", cb(ns, "dl", item.id)).text("💾 Bookmark", cb(ns, "fav", item.id)).row();
    for (const shortcut of item.shortcuts ?? []) kb.switchInlineCurrent(shortcut.label, shortcut.query);
    if (item.shortcuts?.length) kb.row();
    return kb.url("🔗 Sumber", item.postUrl).switchInlineCurrent("🔄 Cari lagi", `${prefix} ${query}`.trim());
  };

  const itemKeyboard = config.itemKeyboard ?? defaultKeyboard;

  const mod: BotModule = {
    meta,
    callbackNs: ns,
    help: config.help,

    bookmarks: config.bookmarks ?? {
      category: "image",
      openButton: { label: "📥 File HD", action: "dl" },
      resolve: (itemId) => ({
        thumbUrl: config.getThumbnailUrl?.(itemId),
        postUrl: config.getPostUrl?.(itemId),
      }),
    },

    commands: config.commands ?? [
      {
        command: ns,
        description: `Kirim album gambar ${meta.name}`,
        usage: `/${ns} <kata kunci> [offset:20] [limit:5]`,
        listed: true,
        handler: (ctx, args) => sendScraperAlbum(config, args, ctx),
      },
    ],

    inline: {
      prefix,
      description: meta.description,
      async handler(ctx, query, offset): Promise<InlineResultResponse> {
        // Offset inline berbentuk "<halaman>" atau "<halaman>|<cursor>"
        const [pageText, cursor] = offset.split("|");
        const page = parseInt(pageText, 10) || 1;
        const nsfw = nsfwAllowed(ctx);

        if (isMinorQuery(query)) {
          return {
            items: [
              {
                type: "article",
                id: `${ns}_blocked`,
                title: "⛔ Kata kunci diblokir",
                description: MINOR_QUERY_NOTE,
                input_message_content: { message_text: `⛔ ${MINOR_QUERY_NOTE}` },
              },
            ],
            cacheTime: 300,
          };
        }

        let res: ScraperSearchResult;
        try {
          res = await config.search(query, page, { nsfw, cursor });
        } catch (err) {
          console.warn(`[${meta.id}] pencarian gagal:`, (err as Error).message);
          return { items: [], cacheTime: 5 };
        }

        // Preferensi tampilan pengguna (diatur di /settings dan /exclude)
        const showCaption = ctx.db.getUserSetting(ctx.user.id, "captions", "1") === "1";
        const showButtons = ctx.db.getUserSetting(ctx.user.id, "buttons", "1") === "1";
        const isExcluded = userExclusions(ctx);

        const seen = new Set<string>();
        const items: InlineQueryResult[] = [];

        for (const item of res.items) {
          // Telegram menolak seluruh jawaban bila berisi lebih dari 50 hasil
          if (items.length >= MAX_INLINE_RESULTS) break;
          if ((item.isNsfw && !nsfw) || seen.has(item.id)) continue;
          if (isBlocked(item) || isExcluded(item.tags)) continue;
          seen.add(item.id);

          const full =
            `<b>${htmlEscape(item.title)}</b>\n` +
            (item.info ? `${item.info}\n` : "") +
            tagLine(item.tags) +
            `${meta.emoji} ${htmlEscape(meta.name)} · <a href="${htmlEscape(item.postUrl)}">buka sumber</a>`;
          // Artikel (manga) selalu butuh isi; untuk media, keterangan bisa dimatikan pengguna
          const body = showCaption || display === "article" ? full : "";
          const id = `${ns}_${item.id}`.slice(0, 64);
          const keyboard = showButtons || display === "article" ? itemKeyboard(item, query) : undefined;
          const mediaUrl = item.inlineUrl || item.directHdUrl || item.thumbnailUrl;
          const size = item.width && item.height ? { width: item.width, height: item.height } : null;

          if (display !== "article" && item.media === "video") {
            items.push({
              type: "video",
              id,
              video_url: mediaUrl,
              mime_type: "video/mp4",
              thumbnail_url: item.thumbnailUrl,
              title: `🎞️ ${item.title}`,
              ...(size ? { video_width: size.width, video_height: size.height } : {}),
              caption: body,
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
            continue;
          }
          if (display !== "article" && item.media === "gif") {
            items.push({
              type: "gif",
              id,
              gif_url: mediaUrl,
              thumbnail_url: item.thumbnailUrl,
              ...(size ? { gif_width: size.width, gif_height: size.height } : {}),
              caption: body,
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
            continue;
          }

          if (display === "article") {
            items.push({
              type: "article",
              id,
              title: item.title,
              thumbnail_url: item.thumbnailUrl || undefined,
              description: (item.info ?? "").replace(/<[^>]*>/g, "").replace(/\s*\n\s*/g, " · ").slice(0, 120),
              input_message_content: {
                message_text: body,
                parse_mode: "HTML",
                link_preview_options: item.thumbnailUrl ? { url: item.thumbnailUrl, prefer_small_media: true } : { is_disabled: true },
              },
              reply_markup: keyboard,
            });
          } else {
            items.push({
              type: "photo",
              id,
              photo_url: mediaUrl,
              thumbnail_url: item.thumbnailUrl,
              ...(size ? { photo_width: size.width, photo_height: size.height } : {}),
              title: item.title,
              caption: body,
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
          }
        }

        const next = res.hasNextPage ? `${page + 1}${res.nextCursor ? `|${res.nextCursor}` : ""}` : "";
        return { items, nextOffset: next, cacheTime: 60 };
      },
    },

    callbacks: [
      {
        action: "fav",
        async handler(ctx, postId) {
          const meta0 = (await config.getMetadata?.(postId).catch(() => null)) ?? {};
          const result = ctx.db.addBookmark({
            userId: ctx.user.id,
            tier: ctx.user.tier,
            moduleId: meta.id,
            itemId: postId,
            title: meta0.title || `${meta.name} #${postId}`,
            thumbUrl: meta0.thumbUrl || config.getThumbnailUrl?.(postId) || "",
            postUrl: meta0.postUrl || config.getPostUrl?.(postId) || "",
            category: mod.bookmarks!.category,
          });

          if (result === "saved") await toast(ctx, "❤️ Tersimpan. Lihat di /bookmarks");
          else if (result === "exists") await toast(ctx, "Sudah ada di bookmark Anda.");
          else {
            await toast(
              ctx,
              `Bookmark penuh (maks ${PLANS.standard.maxBookmarks} untuk akun gratis). Hapus sebagian di /bookmarks atau /upgrade ke VIP.`,
              true
            );
          }
        },
      },
      ...(display === "photo" ? [hdDownloadCallback(config, ns)] : []),
      ...(config.callbacks ?? []),
    ],
  };

  return mod;
}

/** Tombol "File HD": kirim berkas resolusi penuh sebagai dokumen ke chat pribadi pengguna. */
function hdDownloadCallback(config: DefineScraperConfig, ns: string): CallbackDef {
  const { meta } = config;

  return {
    action: "dl",
    async handler(ctx, postId) {
      const userId = ctx.from!.id;
      const dailyLimit = PLANS[ctx.user.tier].dailyDownloads;

      if (ctx.db.quotaLeft(userId, "daily_downloads", dailyLimit) <= 0) {
        await toast(ctx, `Kuota unduhan hari ini habis (${dailyLimit}/hari). Coba lagi besok atau /upgrade ke VIP.`, true);
        return;
      }

      const caption =
        `📁 <b>${htmlEscape(meta.name)} #${htmlEscape(postId)}</b>` +
        (config.getPostUrl ? ` · <a href="${htmlEscape(config.getPostUrl(postId))}">sumber</a>` : "");
      const cacheKey = `${meta.id}:doc:${postId}`;

      // Berkas yang pernah dikirim: pakai ulang file_id, tanpa unduh
      const cached = ctx.db.getFileId(cacheKey);
      if (cached) {
        try {
          await ctx.api.sendDocument(userId, cached, { caption, parse_mode: "HTML" });
          ctx.db.useQuota(userId, "daily_downloads");
          await toast(ctx, "📥 File dikirim ke chat pribadi bot.");
          return;
        } catch (err: any) {
          if (err?.error_code === 403) return pmBlocked(ctx);
        }
      }

      let wait: Awaited<ReturnType<typeof progress>>;
      try {
        wait = await progress(ctx, "⏳ Menyiapkan file HD...", userId);
      } catch {
        return pmBlocked(ctx);
      }
      await toast(ctx, "📥 File dikirim ke chat pribadi bot.");

      try {
        const hdUrl = await config.getHdUrl?.(postId);
        if (!hdUrl) return await wait.fail("❌ File HD tidak tersedia untuk gambar ini.");

        await withTempDir(async (dir) => {
          const ext = path.extname(new URL(hdUrl).pathname).slice(0, 6) || ".jpg";
          const file = path.join(dir, `${ns}-${postId.replace(/[^\w-]/g, "_")}${ext}`);
          await downloadToFile(hdUrl, file, { maxBytes: TG_UPLOAD_MAX, timeoutMs: 60_000 });

          const sent = await ctx.api.sendDocument(userId, new InputFile(file), { caption, parse_mode: "HTML" });
          ctx.db.setFileId(cacheKey, sent.document.file_id, "document");
          ctx.db.useQuota(userId, "daily_downloads");
        });
        await wait.done();
      } catch (err) {
        console.warn(`[${meta.id}] unduh HD #${postId} gagal:`, (err as Error).message);
        await wait.fail(
          err instanceof TooLargeError
            ? "❌ File melebihi 50 MB (batas kirim Telegram). Buka halaman sumber untuk mengunduhnya."
            : "❌ Gagal mengambil file dari situs sumber. Coba lagi nanti."
        );
      }
    },
  };
}

async function pmBlocked(ctx: BotContext): Promise<void> {
  await toast(ctx, `Buka chat @${ctx.me.username} dan tekan Start dulu, lalu tekan tombol ini lagi.`, true);
}

/**
 * Cari lalu kirim hasil sebagai album foto. Dipakai perintah bawaan scraper,
 * dan bisa dipanggil dari perintah kustom modul.
 */
export async function sendScraperAlbum(config: DefineScraperConfig, rawQuery: string, ctx: BotContext): Promise<void> {
  const { meta, prefix } = config;

  // Parameter opsional di dalam kata kunci: "offset:20" melewati 20 hasil pertama, "limit:5" membatasi jumlah
  const maxPhotos = ctx.user.tier === "premium" ? 20 : 10;
  let offset = 0;
  let limit = maxPhotos;
  const query = rawQuery
    .replace(/(^|\s)(offset|limit):(\d+)(?=\s|$)/gi, (_whole, lead: string, name: string, value: string) => {
      if (name.toLowerCase() === "offset") offset = Math.min(Number(value), MAX_ALBUM_OFFSET);
      else limit = Math.min(Math.max(Number(value), 1), maxPhotos);
      return lead;
    })
    .replace(/\s+/g, " ")
    .trim();

  if (isMinorQuery(query)) {
    await reply(ctx, `⛔ ${MINOR_QUERY_NOTE}`);
    return;
  }

  const waitSeconds = albumCooldown.hit(ctx.user.id);
  if (waitSeconds > 0) {
    await reply(ctx, `⏳ Tunggu ${waitSeconds} detik sebelum meminta album lagi.`);
    return;
  }

  const ran = await albumJobs.tryRun(async () => {
    const wait = await progress(
      ctx,
      `⏳ Mencari di ${htmlEscape(meta.name)}: <code>${htmlEscape(query || "terbaru")}</code>` +
        (offset > 0 ? ` (mulai dari hasil ke-${offset + 1})` : "")
    );

    try {
      const nsfw = nsfwAllowed(ctx);
      const isExcluded = userExclusions(ctx);

      // Kumpulkan halaman demi halaman sampai cukup untuk offset + limit (dibatasi agar tidak membebani situs sumber)
      const usable: ScraperItem[] = [];
      let cursor: string | undefined;
      for (let page = 1; page <= MAX_ALBUM_PAGES && usable.length < offset + limit; page++) {
        const found = await config.search(query, page, { nsfw, cursor });
        usable.push(
          ...found.items
            .filter((item) => nsfw || !item.isNsfw)
            // Album hanya berisi foto; animasi dan video tersedia lewat mode inline
            .filter((item) => (item.media ?? "photo") === "photo")
            .filter((item) => !isBlocked(item) && !isExcluded(item.tags))
        );
        if (!found.hasNextPage) break;
        cursor = found.nextCursor;
      }
      const items = usable.slice(offset, offset + limit);

      if (items.length === 0) {
        return await wait.fail(
          offset > 0 && usable.length > 0
            ? `❌ Hanya ada ${usable.length} hasil untuk <code>${htmlEscape(query || "terbaru")}</code>, jadi <code>offset:${offset}</code> melewati semuanya.`
            : `❌ Tidak ada hasil untuk <code>${htmlEscape(query || "terbaru")}</code>. Coba kata kunci lain.`
        );
      }

      const sent = await sendAlbum(
        ctx,
        items.map((item) => ({
          cacheKey: `${meta.id}:photo:${item.id}`,
          url: item.directHdUrl || item.thumbnailUrl,
          fallbackUrl: item.inlineUrl || item.thumbnailUrl,
        }))
      );

      if (sent === 0) return await wait.fail("❌ Gambar ditemukan tetapi gagal diunduh dari situs sumber. Coba lagi nanti.");
      await wait.done();
      // Tombol "lanjut" menyalin perintah berikutnya ke kolom ketik: cukup tekan kirim
      const nextOffset = offset + items.length;
      const more = usable.length > nextOffset || nextOffset < MAX_ALBUM_OFFSET;
      const kb = new InlineKeyboard().switchInlineCurrent("🔎 Jelajahi & pilih sendiri", `${prefix} ${query}`.trim());
      await reply(
        ctx,
        `✅ ${sent} gambar dari ${meta.emoji} ${htmlEscape(meta.name)} (hasil ke-${offset + 1} sampai ${nextOffset})` +
          (more ? `\nLanjut: <code>${htmlEscape(`${prefix} ${query}`.trim())} offset:${nextOffset}</code>` : ""),
        kb
      );
    } catch (err) {
      console.warn(`[${meta.id}] album gagal:`, (err as Error).message);
      await wait.fail(`❌ ${htmlEscape(meta.name)} sedang tidak bisa dihubungi. Coba lagi nanti.`);
    }
  });

  if (!ran) await reply(ctx, "⏳ Server sedang memproses album lain. Coba lagi sebentar lagi.");
}
