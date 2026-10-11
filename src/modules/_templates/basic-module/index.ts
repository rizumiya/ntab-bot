import { InlineKeyboard } from "grammy";
import { BotModule } from "../../../core/engine/types";
import { htmlEscape } from "../../../core/tools/text";
import { cb, reply, show, toast } from "../../../core/tools/ui";

/**
 * TEMPLAT MODUL UMUM
 *
 * Salin folder ini ke `src/modules/<nama>/` (jalur import menjadi "../../core/...").
 * Hapus bagian yang tidak dipakai. Daftar lengkap alat inti ada di README.
 */
const NS = "ex"; // awalan pendek untuk data tombol (batas Telegram 64 byte)

const contoh: BotModule = {
  meta: {
    id: "contoh",
    name: "Contoh",
    emoji: "🧪",
    description: "Satu kalimat: apa gunanya bagi pengguna.",
    category: "tool",
    scope: "both",
    minTier: "standard",
    defaultEnabled: true,
    version: "1.0.0",
  },
  callbackNs: NS,
  help: ["Catatan tambahan untuk halaman bantuan (opsional, HTML)."],

  // Perintah otomatis bisa dipanggil sebagai /halo dan .halo.
  // Izin (paket, jenis obrolan, admin) diperiksa inti sebelum handler dipanggil.
  commands: [
    {
      command: "halo",
      description: "Menyapa pengguna",
      usage: "/halo [nama]",
      listed: true, // tampil di tombol "/" Telegram
      // access: "group_admin" | "owner", scope: "group" | "private"
      async handler(ctx, args) {
        await reply(
          ctx,
          `👋 Halo, <b>${htmlEscape(args || ctx.user.first_name)}</b>!`,
          new InlineKeyboard().text("Tekan saya", cb(NS, "tekan", "1"))
        );
      },
    },
  ],

  // Tombol dengan data cb(NS, "tekan", arg) diarahkan ke sini
  callbacks: [
    {
      action: "tekan",
      async handler(ctx, arg) {
        await toast(ctx, `Ditekan ${arg} kali`);
        await show(ctx, `Tombol sudah ditekan <b>${htmlEscape(arg)}</b> kali.`, {
          keyboard: new InlineKeyboard().text("Lagi", cb(NS, "tekan", Number(arg) + 1)),
        });
      },
    },
  ],

  // Tombol di Menu Utama
  menuButtons: [{ label: "🧪 Contoh", action: "tekan", arg: "0", order: 60 }],

  // Buat tabel sendiri di sini: getDatabase().exec("CREATE TABLE IF NOT EXISTS ...")
  onLoad() {},
};

export default contoh;
