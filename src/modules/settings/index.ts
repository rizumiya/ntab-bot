import { InlineKeyboard } from "grammy";
import { BotModule, BotContext, SettingDef } from "../../core/engine/types";
import { registry } from "../../core/engine/registry";
import { moduleStatus } from "../../core/engine/gate";
import { htmlEscape, isOwner } from "../../core/tools/text";
import { cb, reply, show, toast } from "../../core/tools/ui";
import { ExclusionRules, MAX_RULES, MAX_TAGS_PER_GROUP, formatExclusions, parseExclusions } from "../../core/tools/tags";

const NS = "set";

/** Satu aturan dalam kalimat: "ber-tag gore" atau "ber-tag male DAN solo sekaligus". */
function describeRule(rule: string[]): string {
  const tags = rule.map((tag) => `<code>${htmlEscape(tag)}</code>`);
  return rule.length === 1 ? `• ber-tag ${tags[0]}` : `• ber-tag ${tags.join(" <b>dan</b> ")} sekaligus`;
}

function exclusionGuide(current: string): string {
  return (
    `🚫 <b>Sembunyikan gambar ber-tag tertentu</b>\n\n` +
    `Rumus Anda sekarang:\n${current ? `<code>${htmlEscape(current)}</code>` : "<i>belum ada</i>"}\n\n` +
    `<b>Cara menulis rumus</b>\n` +
    `• Koma memisahkan aturan (<b>atau</b>): <code>/exclude yaoi, gore</code>\n` +
    `   menyembunyikan gambar ber-tag yaoi, juga yang ber-tag gore.\n` +
    `• Kurung menggabungkan tag (<b>dan</b>): <code>/exclude (male, solo)</code>\n` +
    `   hanya menyembunyikan gambar yang punya kedua tag itu sekaligus.\n` +
    `• Boleh dicampur: <code>/exclude yaoi, (male, solo)</code>\n\n` +
    `Perintah ini mengganti seluruh rumus lama. Kosongkan dengan <code>/exclude off</code>.\n` +
    `Tulis tag seperti di situs sumbernya; tag pada tiap hasil bisa diketuk untuk disalin.`
  );
}

/** Semua pengaturan on/off yang dideklarasikan modul mana pun. */
function allSettings(): SettingDef[] {
  return registry.all().flatMap((m) => m.settings ?? []);
}

function isOn(ctx: BotContext, s: SettingDef): boolean {
  return ctx.db.getUserSetting(ctx.user.id, s.key, s.defaultValue ? "1" : "0") === "1";
}

function locked(ctx: BotContext, s: SettingDef): boolean {
  return s.minTier === "premium" && ctx.user.tier !== "premium" && !isOwner(ctx.user.id);
}

async function showSettings(ctx: BotContext): Promise<void> {
  const settings = allSettings();
  const kb = new InlineKeyboard();
  const lines = ["⚙️ <b>Pengaturan</b>", ""];

  for (const s of settings) {
    const state = locked(ctx, s) ? "🔒 khusus VIP" : isOn(ctx, s) ? "🟢 aktif" : "⚪ mati";
    lines.push(`<b>${htmlEscape(s.label)}</b>: ${state}`, `<i>${htmlEscape(s.description)}</i>`, "");
    kb.text(`${locked(ctx, s) ? "🔒" : isOn(ctx, s) ? "🟢" : "⚪"} ${s.label}`, cb(NS, "toggle", s.key)).row();
  }

  const active = registry.features().filter((m) => moduleStatus(m, ctx) === "on").length;
  const exclusions = ctx.db.getUserSetting(ctx.user.id, "excluded_tags", "");
  lines.push(
    `<b>Tag yang disembunyikan</b>: ${exclusions ? `<code>${htmlEscape(exclusions)}</code>` : "belum ada"}`,
    "<i>Atur dengan perintah /exclude, mis. /exclude yaoi, (male, solo)</i>",
    "",
    `<b>Fitur aktif</b>: ${active} dari ${registry.features().length}`,
    "<i>Matikan fitur yang tidak Anda pakai agar menu lebih ringkas.</i>"
  );

  kb.text("🚫 Sembunyikan tag", cb(NS, "exclude")).text("🧩 Atur fitur", cb(NS, "mods")).row().text("⬅️ Menu utama", cb("menu", "main"));
  await show(ctx, lines.join("\n"), { keyboard: kb });
}

async function showModules(ctx: BotContext): Promise<void> {
  const ICON = { on: "✅", off: "⚪", vip: "🔒", maintenance: "🛠️" };
  const kb = new InlineKeyboard();
  const GROUPS = [
    { title: "Cari gambar", category: "search" },
    { title: "Baca komik", category: "manga" },
    { title: "Alat", category: "tool" },
    { title: "Grup", category: "group" },
  ];
  const lines = ["🧩 <b>Fitur</b>", "✅ aktif · ⚪ mati · 🔒 khusus VIP · 🛠️ diperbaiki"];

  // Satu baris pendek per fitur (tidak melipat di layar ponsel), dikelompokkan per jenis
  for (const group of GROUPS) {
    const mods = registry.features().filter((m) => m.meta.category === group.category);
    if (mods.length === 0) continue;

    lines.push("", `<b>${group.title}</b>`);
    mods.forEach((m, i) => {
      const status = moduleStatus(m, ctx);
      lines.push(`${ICON[status]} ${m.meta.emoji} ${htmlEscape(m.meta.name)}`);
      kb.text(`${ICON[status]} ${m.meta.name}`, cb(NS, "mod", m.meta.id));
      if (i % 2 === 1) kb.row();
    });
    kb.row();
  }

  lines.push("", "Tekan tombol untuk menyalakan atau mematikan. Penjelasan tiap fitur ada di /help.");
  kb.text("⬅️ Pengaturan", cb(NS, "open")).text("❓ Bantuan", cb("menu", "help"));
  await show(ctx, lines.join("\n"), { keyboard: kb });
}

const settings: BotModule = {
  meta: {
    id: "settings",
    name: "Pengaturan",
    emoji: "⚙️",
    description: "Atur konten dewasa dan fitur mana saja yang aktif di akun Anda.",
    category: "system",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
    system: true,
  },
  callbackNs: NS,

  settings: [
    {
      key: "nsfw",
      label: "Konten dewasa (NSFW)",
      description: "Tampilkan hasil berlabel dewasa. Hanya berlaku di chat pribadi, tidak pernah di grup.",
      defaultValue: false,
      minTier: "premium",
    },
    {
      key: "captions",
      label: "Keterangan gambar",
      description: "Sertakan judul, tag, dan tautan sumber pada gambar yang dikirim lewat mode inline.",
      defaultValue: true,
    },
    {
      key: "buttons",
      label: "Tombol di bawah gambar",
      description: "Sertakan tombol File HD, Bookmark, dan Sumber pada gambar yang dikirim lewat mode inline.",
      defaultValue: true,
    },
  ],

  menuButtons: [{ label: "⚙️ Pengaturan", action: "open", order: 20 }],

  help: [
    "<code>/exclude yaoi, gore</code> menyembunyikan gambar ber-tag yaoi <b>atau</b> gore.",
    "<code>/exclude (male, solo)</code> hanya menyembunyikan gambar yang ber-tag male <b>dan</b> solo sekaligus.",
    "Keduanya bisa dicampur: <code>/exclude yaoi, (male, solo)</code>. Kosongkan dengan <code>/exclude off</code>.",
  ],

  commands: [
    { command: "settings", aliases: ["setting"], description: "Pengaturan akun dan fitur", listed: true, handler: showSettings },
    {
      command: "exclude",
      description: "Sembunyikan gambar ber-tag tertentu",
      usage: "/exclude <rumus | off>",
      async handler(ctx, args) {
        const current = ctx.db.getUserSetting(ctx.user.id, "excluded_tags", "");
        if (!args) return reply(ctx, exclusionGuide(current));

        if (args.toLowerCase() === "off") {
          ctx.db.setUserSetting(ctx.user.id, "excluded_tags", "");
          return reply(ctx, "✅ Daftar pengecualian dikosongkan. Semua gambar tampil lagi.");
        }

        let rules: ExclusionRules;
        try {
          rules = parseExclusions(args);
        } catch (err) {
          return reply(ctx, `⚠️ ${htmlEscape((err as Error).message)}\n\nContoh yang benar: <code>/exclude yaoi, (male, solo)</code>`);
        }
        if (rules.length === 0) return reply(ctx, exclusionGuide(current));
        if (rules.length > MAX_RULES) return reply(ctx, `⚠️ Maksimal ${MAX_RULES} aturan.`);
        if (rules.some((rule) => rule.length > MAX_TAGS_PER_GROUP)) return reply(ctx, `⚠️ Satu kurung maksimal ${MAX_TAGS_PER_GROUP} tag.`);

        ctx.db.setUserSetting(ctx.user.id, "excluded_tags", formatExclusions(rules));
        await reply(
          ctx,
          `✅ <b>${rules.length} aturan disimpan.</b> Gambar disembunyikan bila:\n` +
            rules.map(describeRule).join("\n") +
            `\n\nBerlaku di semua pencarian Anda. Lihat atau ubah kapan saja dengan /exclude.`
        );
      },
    },
  ],

  callbacks: [
    { action: "open", handler: showSettings },
    { action: "mods", handler: showModules },
    {
      action: "exclude",
      async handler(ctx) {
        await show(ctx, exclusionGuide(ctx.db.getUserSetting(ctx.user.id, "excluded_tags", "")), {
          keyboard: new InlineKeyboard().text("⬅️ Pengaturan", cb(NS, "open")),
        });
      },
    },
    {
      action: "toggle",
      async handler(ctx, key) {
        const s = allSettings().find((x) => x.key === key);
        if (!s) return;
        if (locked(ctx, s)) return toast(ctx, "Pengaturan ini khusus Premium VIP. Ketik /upgrade.", true);

        const next = !isOn(ctx, s);
        ctx.db.setUserSetting(ctx.user.id, s.key, next ? "1" : "0");
        await toast(ctx, `${s.label}: ${next ? "aktif" : "mati"}`);
        await showSettings(ctx);
      },
    },
    {
      action: "mod",
      async handler(ctx, moduleId) {
        const mod = registry.get(moduleId);
        if (!mod || mod.meta.system) return;

        const status = moduleStatus(mod, ctx);
        if (status === "vip") return toast(ctx, `${mod.meta.name} khusus Premium VIP. Ketik /upgrade.`, true);
        if (status === "maintenance") return toast(ctx, `${mod.meta.name} sedang dinonaktifkan sementara oleh admin.`, true);

        ctx.db.setModuleEnabled("user", ctx.user.id, moduleId, status !== "on");
        await toast(ctx, `${mod.meta.name}: ${status !== "on" ? "aktif" : "mati"}`);
        await showModules(ctx);
      },
    },
  ],
};

export default settings;
