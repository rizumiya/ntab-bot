import { InlineKeyboard } from "grammy";
import { isGloballyEnabled } from "../../core/engine/gate";
import { BotModule, BotContext } from "../../core/engine/types";
import { registry } from "../../core/engine/registry";
import { repo } from "../../core/db/repo";
import { config } from "../../core/config";
import { PLANS } from "../../core/plans";
import { htmlEscape, isOwner, formatDate } from "../../core/tools/text";
import { cb, reply, show } from "../../core/tools/ui";

const NS = "vip";
const PAYLOAD_PREFIX = "vip30:";
const plan = PLANS.premium;

function benefits(): string {
  const vipModules = registry
    .features()
    .filter((m) => m.meta.minTier === "premium" && isGloballyEnabled(m))
    .map((m) => `${m.meta.emoji} ${htmlEscape(m.meta.name)}`)
    .join(", ");

  return [
    vipModules ? `• Fitur khusus: ${vipModules}` : "",
    "• Album 20 gambar sekali kirim (gratis: 10)",
    `• Unduhan File HD tanpa batas (gratis: ${PLANS.standard.dailyDownloads}/hari)`,
    `• Bookmark tanpa batas (gratis: ${PLANS.standard.maxBookmarks})`,
    "• Pengaturan konten dewasa (hanya di chat pribadi)",
  ]
    .filter(Boolean)
    .join("\n");
}

async function showStatus(ctx: BotContext): Promise<void> {
  const kb = new InlineKeyboard();
  let status: string;

  if (isOwner(ctx.user.id)) {
    status = "Anda pemilik bot: semua fitur terbuka.";
  } else if (ctx.user.tier === "premium") {
    status = `Status: <b>VIP aktif</b> sampai ${formatDate(ctx.user.premium_until)}.\nPerpanjangan menambah ${plan.durationDays} hari di atas sisa masa aktif.`;
    kb.text(`⭐ Perpanjang ${plan.durationDays} hari (${plan.starsPrice} Stars)`, cb(NS, "buy")).row();
  } else {
    status = "Status: <b>akun gratis</b>.";
    kb.text(`⭐ Beli VIP ${plan.durationDays} hari (${plan.starsPrice} Stars)`, cb(NS, "buy")).row();
  }

  kb.text("⬅️ Menu utama", cb("menu", "main"));
  await show(
    ctx,
    `⭐ <b>Premium VIP</b>\n\n${status}\n\n<b>Yang didapat</b>\n${benefits()}\n\n` +
      `Pembayaran memakai Telegram Stars. Kendala pembayaran: /paysupport`,
    { keyboard: kb }
  );
}

const premium: BotModule = {
  meta: {
    id: "premium",
    name: "Premium VIP",
    emoji: "⭐",
    description: "Lihat status langganan dan beli VIP dengan Telegram Stars.",
    category: "system",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "2.0.0",
    system: true,
  },
  callbackNs: NS,

  menuButtons: [{ label: "⭐ VIP", action: "info", order: 30, visible: (ctx) => !isOwner(ctx.user.id) }],

  commands: [
    { command: "upgrade", aliases: ["premium"], description: "Status dan pembelian VIP", listed: true, handler: showStatus },
    {
      command: "paysupport",
      description: "Bantuan kendala pembayaran",
      async handler(ctx) {
        await reply(
          ctx,
          `💬 <b>Bantuan pembayaran</b>\n\n` +
            `Bila Stars terpotong tetapi VIP belum aktif, kirim:\n<code>/report pembayaran VIP belum aktif</code>\n\n` +
            `ID Anda (<code>${ctx.user.id}</code>) ikut terkirim otomatis, dan pemilik bot akan memeriksanya.`
        );
      },
    },
  ],

  callbacks: [
    { action: "info", handler: showStatus },
    {
      action: "buy",
      async handler(ctx) {
        const chatId = ctx.chat?.id ?? ctx.from!.id;
        await ctx.api.sendInvoice(
          chatId,
          `Premium VIP ${plan.durationDays} hari`,
          "Membuka semua fitur VIP, unduhan dan bookmark tanpa batas.",
          `${PAYLOAD_PREFIX}${ctx.user.id}`,
          "XTR",
          [{ label: `VIP ${plan.durationDays} hari`, amount: plan.starsPrice }]
        );
      },
    },
  ],

  setup(composer) {
    // Telegram menunggu jawaban ini maksimal 10 detik sebelum membatalkan pembayaran
    composer.on("pre_checkout_query", async (ctx) => {
      const q = ctx.preCheckoutQuery;
      const valid = q.invoice_payload.startsWith(PAYLOAD_PREFIX) && q.currency === "XTR" && q.total_amount === plan.starsPrice;
      await ctx.answerPreCheckoutQuery(valid, valid ? undefined : { error_message: "Tagihan ini sudah tidak berlaku. Ketik /upgrade untuk membuat yang baru." });
    });

    composer.on("message:successful_payment", async (ctx) => {
      const pay = ctx.message.successful_payment;
      // Update yang terkirim ulang tidak boleh menambah masa aktif dua kali
      const isNew = repo.recordPayment(pay.telegram_payment_charge_id, ctx.user.id, pay.total_amount, pay.invoice_payload);
      if (!isNew) return;

      const user = repo.extendPremium(ctx.user.id, plan.durationDays);
      await reply(
        ctx,
        `🎉 <b>Pembayaran diterima. Terima kasih!</b>\n\n` +
          `VIP Anda aktif sampai <b>${formatDate(user?.premium_until)}</b>.\n` +
          `Nyalakan fitur VIP di /settings, lalu mulai dari /menu.`
      );

      if (config.ownerId) {
        await ctx.api
          .sendMessage(config.ownerId, `💰 Pembayaran VIP ${pay.total_amount} Stars dari ${htmlEscape(ctx.user.first_name)} (<code>${ctx.user.id}</code>).`, {
            parse_mode: "HTML",
          })
          .catch(() => {});
      }
    });
  },
};

export default premium;
