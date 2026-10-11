import { Composer, InlineKeyboard } from "grammy";
import { BotContext } from "./types";
import { registry } from "./registry";
import { checkModule, checkAccess, moduleStatus } from "./gate";
import { config } from "../config";

/**
 * Router pusat: meneruskan perintah, tombol, inline query, dan pesan biasa ke modul pemiliknya,
 * setelah lolos pemeriksaan izin. Modul tidak perlu memeriksa paket, jenis obrolan, atau hak admin sendiri.
 */
export function createRouter(): Composer<BotContext> {
  const router = new Composer<BotContext>();

  // Handler bebas milik modul (pembayaran, dsb.)
  for (const mod of registry.all()) {
    if (!mod.setup) continue;
    const scoped = new Composer<BotContext>();
    mod.setup(scoped);
    router.use(scoped);
  }

  // ---------------------------------------------------------------- PESAN
  router.on("message", async (ctx, next) => {
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    const match = text.match(/^([/.])([a-z0-9_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
    const def = match ? registry.commands.get(match[2].toLowerCase()) : undefined;

    if (match && def) {
      const mention = match[3];
      if (mention && mention.toLowerCase() !== ctx.me.username.toLowerCase()) return; // perintah untuk bot lain

      const gate = checkModule(def.module, ctx, def.scope ?? def.module.meta.scope);
      const access = gate.allowed ? await checkAccess(def.access, ctx) : gate;
      if (!access.allowed) {
        await ctx.reply(`⛔ ${access.message}`);
        return;
      }
      await def.handler(ctx, (match[4] ?? "").trim());
      return;
    }

    // Pesan biasa: teruskan ke modul pendengar yang aktif
    for (const mod of registry.all()) {
      if (!mod.onMessage || moduleStatus(mod, ctx) === "maintenance") continue;
      try {
        await mod.onMessage(ctx);
      } catch (err) {
        console.error(`[${mod.meta.id}] onMessage gagal:`, err);
      }
    }
    await next();
  });

  // ---------------------------------------------------------------- TOMBOL
  router.on("callback_query:data", async (ctx) => {
    // Jawab tepat satu kali, siapa pun yang lebih dulu (handler atau router)
    let answered = false;
    const answer = ctx.answerCallbackQuery.bind(ctx);
    ctx.answerCallbackQuery = (async (...args: Parameters<typeof answer>) => {
      if (answered) return true;
      answered = true;
      return answer(...args).catch(() => true);
    }) as typeof answer;

    try {
      const [kind, ns, action, ...rest] = ctx.callbackQuery.data.split(":");
      const def = kind === "m" ? registry.callbacks.get(`${ns}:${action}`) : undefined;

      if (!def) {
        if (kind !== "noop") {
          await ctx.answerCallbackQuery({ text: "Tombol ini sudah tidak berlaku. Ketik /menu.", show_alert: true });
        }
        return;
      }

      const gate = checkModule(def.module, ctx, "both");
      if (!gate.allowed) {
        await ctx.answerCallbackQuery({ text: `⛔ ${gate.message}`, show_alert: true });
        return;
      }
      await def.handler(ctx, rest.join(":"));
    } finally {
      await ctx.answerCallbackQuery();
    }
  });

  // ---------------------------------------------------------------- INLINE
  router.on("inline_query", async (ctx) => {
    let raw = ctx.inlineQuery.query.trim();
    // Kata kunci tanpa prefix diarahkan ke mesin pencari bawaan
    if (raw && !registry.byPrefix(raw.split(/\s+/)[0])) raw = `${config.defaultInlinePrefix} ${raw}`;
    const firstWord = raw.split(/\s+/)[0] ?? "";
    const mod = registry.byPrefix(firstWord);

    if (!mod?.inline) {
      await ctx.answerInlineQuery(prefixGuide(ctx), { cache_time: 30, is_personal: true });
      return;
    }

    const gate = checkModule(mod, ctx);
    if (!gate.allowed) {
      await ctx.answerInlineQuery(
        [
          {
            type: "article",
            id: `gate_${mod.meta.id}`,
            title: `⛔ ${mod.meta.name} tidak tersedia`,
            description: gate.message,
            input_message_content: { message_text: `⛔ ${gate.message}` },
          },
        ],
        { cache_time: 5, is_personal: true }
      );
      return;
    }

    try {
      const res = await mod.inline.handler(ctx, raw.slice(firstWord.length).trim(), ctx.inlineQuery.offset, firstWord.toLowerCase());
      await ctx.answerInlineQuery(res.items, {
        next_offset: res.nextOffset ?? "",
        cache_time: res.cacheTime ?? 10,
        is_personal: true,
      });
    } catch (err: any) {
      // Pengguna masih mengetik: query lama kedaluwarsa, tidak perlu dicatat
      if (!String(err?.description ?? "").includes("query is too old")) {
        console.warn(`[${mod.meta.id}] inline gagal:`, err?.message ?? err);
      }
    }
  });

  return router;
}

/** Daftar prefix yang bisa dipakai user ini; tampil saat ia mengetik `@bot` tanpa prefix yang dikenal. */
function prefixGuide(ctx: BotContext) {
  return registry
    .all()
    .filter((m) => m.inline && checkModule(m, ctx).allowed)
    .map((m) => ({
      type: "article" as const,
      id: `guide_${m.meta.id}`,
      title: `${m.meta.emoji} ${m.inline!.prefix}  ${m.meta.name}`,
      description: m.inline!.description,
      input_message_content: {
        message_text: `${m.meta.emoji} <b>${m.meta.name}</b>\nKetik <code>@${ctx.me.username} ${m.inline!.prefix} kata kunci</code>`,
        parse_mode: "HTML" as const,
      },
      reply_markup: new InlineKeyboard().switchInlineCurrent(`Coba ${m.inline!.prefix}`, `${m.inline!.prefix} `),
    }));
}
