import { BotContext, BotModule, ChatScope, Access } from "./types";
import { repo } from "../db/repo";
import { isOwner } from "../tools/text";
import { TtlCache } from "../tools/cache";
import { PLANS } from "../plans";

export interface GateResult {
  allowed: boolean;
  reason?: "maintenance" | "tier" | "disabled" | "scope" | "access";
  /** Pesan teks polos untuk pengguna. */
  message?: string;
}

const OK: GateResult = { allowed: true };

/** Jenis obrolan tempat update ini terjadi; inline query memakai `chat_type` kiriman Telegram. */
export function isPrivateChat(ctx: BotContext): boolean {
  if (ctx.inlineQuery) {
    const type = ctx.inlineQuery.chat_type;
    return type === "sender" || type === "private";
  }
  if (ctx.chat) return ctx.chat.type === "private";
  // Tombol pada pesan hasil inline: lokasi obrolan tidak diketahui, anggap publik.
  return false;
}

/** Modul tidak sedang dimatikan owner untuk semua pengguna (panel admin > Fitur global). */
export function isGloballyEnabled(mod: BotModule): boolean {
  return Boolean(mod.meta.system) || repo.isModuleEnabled("global", 0, mod.meta.id, true);
}

/**
 * Apakah modul ditampilkan di menu, bantuan, dan pengaturan user ini.
 * Fitur yang dimatikan owner disembunyikan dari semua orang kecuali owner (yang tetap melihatnya, bertanda 🛠️).
 */
export function isListedFor(mod: BotModule, ctx: BotContext): boolean {
  return isOwner(ctx.user.id) || isGloballyEnabled(mod);
}

/** Status modul bagi user ini, tanpa memperhitungkan jenis obrolan. */
export function moduleStatus(mod: BotModule, ctx: BotContext): "on" | "off" | "vip" | "maintenance" {
  if (mod.meta.system) return "on";
  if (!isGloballyEnabled(mod)) return "maintenance";
  if (mod.meta.minTier === "premium" && ctx.user.tier !== "premium") return "vip";
  return repo.isModuleEnabled("user", ctx.user.id, mod.meta.id, mod.meta.defaultEnabled) ? "on" : "off";
}

/** Izin memakai modul: status global, paket, pilihan user, lalu jenis obrolan. */
export function checkModule(mod: BotModule, ctx: BotContext, scope: ChatScope = mod.meta.scope): GateResult {
  const name = mod.meta.name;

  if (!isOwner(ctx.user.id)) {
    const status = moduleStatus(mod, ctx);
    if (status === "maintenance") {
      return { allowed: false, reason: "maintenance", message: `${name} sedang dinonaktifkan sementara oleh admin.` };
    }
    if (status === "vip") {
      return { allowed: false, reason: "tier", message: `${name} khusus Premium VIP. Ketik /upgrade untuk berlangganan.` };
    }
    if (status === "off") {
      return { allowed: false, reason: "disabled", message: `${name} sedang nonaktif di akun Anda. Aktifkan lewat /settings.` };
    }
  }

  if (scope !== "both" && !ctx.inlineQuery) {
    const isPrivate = isPrivateChat(ctx);
    if (scope === "private" && !isPrivate) {
      return { allowed: false, reason: "scope", message: "Perintah ini hanya bisa dipakai di chat pribadi dengan bot." };
    }
    if (scope === "group" && isPrivate) {
      return { allowed: false, reason: "scope", message: "Perintah ini hanya bisa dipakai di dalam grup." };
    }
  }

  return OK;
}

const adminCache = new TtlCache<string, boolean>(60_000, 1000);

/** Apakah pengirim adalah admin grup ini. Hasil di-cache 1 menit agar tidak membebani API Telegram. */
export async function isGroupAdmin(ctx: BotContext): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type === "private") return true;
  // Admin anonim mengirim pesan atas nama grup itu sendiri
  if (ctx.msg?.sender_chat?.id === ctx.chat.id) return true;

  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const cached = adminCache.get(key);
  if (cached !== undefined) return cached;

  try {
    const member = await ctx.getChatMember(ctx.from.id);
    const isAdmin = member.status === "administrator" || member.status === "creator";
    adminCache.set(key, isAdmin);
    return isAdmin;
  } catch {
    return false;
  }
}

export async function checkAccess(access: Access | undefined, ctx: BotContext): Promise<GateResult> {
  if (!access || access === "all") return OK;
  if (access === "owner") {
    return isOwner(ctx.user.id) ? OK : { allowed: false, reason: "access", message: "Perintah ini khusus pemilik bot." };
  }
  return (await isGroupAdmin(ctx))
    ? OK
    : { allowed: false, reason: "access", message: "Perintah ini khusus admin grup." };
}

/**
 * Konten dewasa hanya untuk VIP yang menyalakan pengaturan NSFW,
 * dan hanya di chat pribadi (tidak pernah di grup, termasuk lewat mode inline).
 */
export function nsfwAllowed(ctx: BotContext): boolean {
  const canUse = isOwner(ctx.user.id) || PLANS[ctx.user.tier].allowNsfw;
  return canUse && isPrivateChat(ctx) && repo.getUserSetting(ctx.user.id, "nsfw", "0") === "1";
}
