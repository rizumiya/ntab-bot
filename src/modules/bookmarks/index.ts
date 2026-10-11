import { InlineKeyboard } from "grammy";
import { InlineQueryResult } from "grammy/types";
import { BotModule, BotContext } from "../../core/engine/types";
import { BookmarkRow } from "../../core/db";
import { registry } from "../../core/engine/registry";
import { PLANS } from "../../core/plans";
import { albumJobs, sendAlbum } from "../../core/tools/media";
import { htmlEscape, isOwner, truncate } from "../../core/tools/text";
import { addPager, cb, reply, show, toast } from "../../core/tools/ui";

const NS = "bm";
const PAGE_SIZE = 6;

type Category = "image" | "manga";
const LABEL: Record<Category, string> = { image: "🖼️ Gambar", manga: "📖 Manga" };

/** Lengkapi URL kosong pada data lama memakai adapter modul asalnya, lalu simpan. */
function withUrls(ctx: BotContext, bm: BookmarkRow): BookmarkRow {
  if (bm.thumb_url && bm.post_url) return bm;
  const fixed = registry.get(bm.module_id)?.bookmarks?.resolve?.(bm.item_id) ?? {};
  const thumb = bm.thumb_url || fixed.thumbUrl || "";
  const post = bm.post_url || fixed.postUrl || "";
  if (thumb !== bm.thumb_url || post !== bm.post_url) ctx.db.updateBookmarkUrls(bm.id, thumb, post);
  return { ...bm, thumb_url: thumb, post_url: post };
}

function sourceName(bm: BookmarkRow): string {
  const mod = registry.get(bm.module_id);
  return mod ? `${mod.meta.emoji} ${mod.meta.name}` : bm.module_id;
}

/** Tombol aksi sebuah bookmark: buka (milik modul asal), sumber, hapus. */
function itemKeyboard(bm: BookmarkRow): InlineKeyboard {
  const kb = new InlineKeyboard();
  const mod = registry.get(bm.module_id);
  if (mod?.bookmarks) kb.text(mod.bookmarks.openButton.label, cb(mod, mod.bookmarks.openButton.action, bm.item_id));
  kb.text("🗑️ Hapus", cb(NS, "del", bm.id));
  if (bm.post_url) kb.row().url("🔗 Sumber", bm.post_url);
  return kb;
}

async function showList(ctx: BotContext, category: Category, page: number): Promise<void> {
  const counts = { image: ctx.db.countBookmarks(ctx.user.id, "image"), manga: ctx.db.countBookmarks(ctx.user.id, "manga") };
  const total = counts[category];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), totalPages);
  const items = ctx.db.getBookmarks(ctx.user.id, category, PAGE_SIZE, (current - 1) * PAGE_SIZE);

  const limit = isOwner(ctx.user.id) ? Infinity : PLANS[ctx.user.tier].maxBookmarks;
  const usage = limit === Infinity ? `${counts.image + counts.manga} tersimpan` : `${counts.image + counts.manga}/${limit} tersimpan`;

  const kb = new InlineKeyboard();
  for (const cat of ["image", "manga"] as Category[]) {
    // Tab yang sedang dibuka hanya memberi tahu, tidak memuat ulang layar yang sama
    kb.text(`${cat === category ? "● " : ""}${LABEL[cat]} (${counts[cat]})`, cat === category ? cb(NS, "here") : cb(NS, "list", `${cat}:1`));
  }
  kb.row();

  const lines = [`📚 <b>Bookmark</b> · ${usage}`, ""];

  if (items.length === 0) {
    lines.push(
      category === "image"
        ? "Belum ada gambar tersimpan.\nTekan <b>💾 Bookmark</b> pada hasil pencarian untuk menyimpannya di sini."
        : "Belum ada manga tersimpan.\nCari dengan <code>/kr judul</code>, lalu tekan <b>💾 Bookmark</b>."
    );
  } else {
    // Daftar berupa teks bernomor: jumlah tombol tetap sedikit berapa pun banyaknya bookmark
    items.forEach((row, i) => {
      const bm = withUrls(ctx, row);
      const number = (current - 1) * PAGE_SIZE + i + 1;
      const title = htmlEscape(truncate(bm.title, 60));
      lines.push(`${number}. ${bm.post_url ? `<a href="${htmlEscape(bm.post_url)}">${title}</a>` : title} · ${htmlEscape(sourceName(bm))}`);
    });
    lines.push("", "Buka, unduh, atau hapus sebuah item lewat <b>Lihat sebagai galeri</b>.");

    addPager(kb, current, totalPages, (p) => cb(NS, "list", `${category}:${p}`));
    kb.switchInlineCurrent("🔎 Lihat sebagai galeri", category === "image" ? ".bm" : ".bmm");
    if (category === "image") kb.text("📸 Kirim sebagai album", cb(NS, "album", current));
    kb.row();
  }

  kb.text("⬅️ Menu utama", cb("menu", "main"));
  await show(ctx, lines.join("\n"), { keyboard: kb });
}

const bookmarks: BotModule = {
  meta: {
    id: "bookmarks",
    name: "Bookmark",
    emoji: "📚",
    description: "Simpan gambar dan manga favorit, lalu buka lagi kapan saja.",
    category: "system",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
    system: true,
  },
  callbackNs: NS,
  help: [
    "Simpan dengan tombol <b>💾 Bookmark</b> pada hasil pencarian mana pun.",
    `Akun gratis menyimpan sampai ${PLANS.standard.maxBookmarks} item; VIP tanpa batas.`,
    "Galeri bookmark bisa dibuka di chat mana pun: <code>.bm</code> untuk gambar, <code>.bmm</code> untuk manga.",
  ],

  menuButtons: [{ label: "📚 Bookmark", action: "list", arg: "image:1", order: 10 }],

  commands: [
    {
      command: "bookmarks",
      aliases: ["bookmark", "bm", "fav"],
      description: "Gambar dan manga yang Anda simpan",
      usage: "/bookmarks [manga]",
      listed: true,
      handler: (ctx, args) => showList(ctx, /^(manga|mg)$/i.test(args) ? "manga" : "image", 1),
    },
  ],

  inline: {
    prefix: ".bm",
    aliases: [".fav", ".bmm"],
    description: "Galeri bookmark Anda (.bmm untuk manga)",
    async handler(ctx, _query, offset, prefix) {
      const category: Category = prefix === ".bmm" ? "manga" : "image";
      const start = parseInt(offset, 10) || 0;
      const rows = ctx.db.getBookmarks(ctx.user.id, category, 30, start).map((b) => withUrls(ctx, b));

      if (rows.length === 0 && start === 0) {
        return {
          items: [
            {
              type: "article",
              id: "bm_empty",
              title: `Bookmark ${category === "manga" ? "manga" : "gambar"} masih kosong`,
              description: "Tekan 💾 Bookmark pada hasil pencarian untuk menyimpannya.",
              input_message_content: { message_text: "Bookmark saya masih kosong." },
            },
          ],
          cacheTime: 1,
        };
      }

      const items: InlineQueryResult[] = rows
        .filter((bm) => category === "manga" || bm.thumb_url)
        .map((bm) => {
          const caption = `❤️ <b>${htmlEscape(bm.title)}</b>\n${htmlEscape(sourceName(bm))}`;
          return category === "manga"
            ? {
                type: "article" as const,
                id: `bm_${bm.id}`,
                title: bm.title,
                description: sourceName(bm),
                thumbnail_url: bm.thumb_url || undefined,
                input_message_content: { message_text: caption, parse_mode: "HTML" as const },
                reply_markup: itemKeyboard(bm),
              }
            : {
                type: "photo" as const,
                id: `bm_${bm.id}`,
                photo_url: bm.thumb_url,
                thumbnail_url: bm.thumb_url,
                title: bm.title,
                caption,
                parse_mode: "HTML" as const,
                reply_markup: itemKeyboard(bm),
              };
        });

      return { items, nextOffset: rows.length === 30 ? String(start + 30) : "", cacheTime: 1 };
    },
  },

  callbacks: [
    {
      // arg: "<image|manga>:<halaman>"
      action: "list",
      async handler(ctx, arg) {
        const [category, page] = arg.split(":");
        await showList(ctx, category === "manga" ? "manga" : "image", parseInt(page, 10) || 1);
      },
    },
    { action: "here", handler: (ctx) => toast(ctx, "Anda sedang di tab ini.") },
    {
      action: "del",
      async handler(ctx, id) {
        const removed = ctx.db.removeBookmark(ctx.user.id, parseInt(id, 10));
        await toast(ctx, removed ? "🗑️ Bookmark dihapus." : "Bookmark ini sudah tidak ada.");
        // Pesan tampilan item (foto) tidak relevan lagi setelah dihapus
        if (removed && ctx.callbackQuery?.message) await ctx.deleteMessage().catch(() => {});
      },
    },
    {
      // arg: nomor halaman daftar gambar
      action: "album",
      async handler(ctx, page) {
        const offset = ((parseInt(page, 10) || 1) - 1) * PAGE_SIZE;
        const rows = ctx.db
          .getBookmarks(ctx.user.id, "image", PAGE_SIZE, offset)
          .map((b) => withUrls(ctx, b))
          .filter((b) => b.thumb_url);
        if (rows.length === 0) return toast(ctx, "Tidak ada gambar di halaman ini.", true);

        await toast(ctx, `📸 Mengirim ${rows.length} gambar...`);
        const ran = await albumJobs.tryRun(() =>
          sendAlbum(ctx, rows.map((b) => ({ cacheKey: `${b.module_id}:photo:${b.item_id}`, url: b.thumb_url })))
        );
        if (!ran) await reply(ctx, "⏳ Server sedang memproses album lain. Coba lagi sebentar lagi.");
        else if (ran.value === 0) await reply(ctx, "❌ Gambar gagal diunduh dari situs sumber.");
      },
    },
  ],
};

export default bookmarks;
