import { StatementSync } from "node:sqlite";
import { getDatabase, UserRow, BookmarkRow } from "./index";
import { isOwner } from "../tools/text";
import { TtlCache } from "../tools/cache";
import { PLANS, Tier } from "../plans";

type TgUser = { id: number; username?: string | null; first_name: string };
type BookmarkCategory = "image" | "manga";

/** Selang minimal penulisan `last_seen` per user. Di antaranya, data user dilayani dari memori. */
const USER_WRITE_INTERVAL_MS = 60_000;

/**
 * Akses data inti: user, pengaturan, status modul, kuota, bookmark, cache file_id, dan kv.
 * Data khusus sebuah modul dikelola modul itu sendiri.
 */
export class Repository {
  private db = getDatabase();
  private statements = new Map<string, StatementSync>();
  private users = new TtlCache<number, { row: UserRow; writtenAt: number; pendingUses: number }>(10 * 60_000, 5000);

  /** Statement disiapkan sekali lalu dipakai ulang. */
  private sql(text: string): StatementSync {
    let stmt = this.statements.get(text);
    if (!stmt) {
      stmt = this.db.prepare(text);
      this.statements.set(text, stmt);
    }
    return stmt;
  }

  // ==========================================
  // USER
  // ==========================================
  /**
   * Catat interaksi user. Dipanggil di setiap update, jadi penulisan ke disk
   * dibatasi paling sering sekali per menit per user.
   */
  touchUser(user: TgUser): UserRow {
    const now = Date.now();
    const username = user.username || null;
    const cached = this.users.get(user.id);

    if (cached) {
      const row = cached.row;
      const expired = row.tier === "premium" && row.premium_until !== null && row.premium_until < now;
      const unchanged = row.username === username && row.first_name === user.first_name;
      if (unchanged && !expired && now - cached.writtenAt < USER_WRITE_INTERVAL_MS) {
        cached.pendingUses++;
        return row;
      }
    }

    const existing = cached?.row ?? this.getUser(user.id);
    const owner = isOwner(user.id);
    const uses = (cached?.pendingUses ?? 0) + 1;
    let row: UserRow;

    if (existing) {
      let tier: Tier = owner ? "premium" : existing.tier;
      let premiumUntil = owner ? null : existing.premium_until;
      if (!owner && tier === "premium" && premiumUntil !== null && premiumUntil < now) {
        tier = "standard";
        premiumUntil = null;
      }
      row = {
        ...existing,
        username,
        first_name: user.first_name,
        tier,
        premium_until: premiumUntil,
        usage_count: existing.usage_count + uses,
        last_seen: now,
      };
      this.sql(
        "UPDATE users SET username = ?, first_name = ?, tier = ?, premium_until = ?, last_seen = ?, usage_count = ? WHERE id = ?"
      ).run(row.username, row.first_name, row.tier, row.premium_until, row.last_seen, row.usage_count, row.id);
    } else {
      row = {
        id: user.id,
        username,
        first_name: user.first_name,
        tier: owner ? "premium" : "standard",
        premium_until: null,
        usage_count: 1,
        created_at: now,
        last_seen: now,
      };
      this.sql(
        "INSERT INTO users (id, username, first_name, tier, premium_until, usage_count, created_at, last_seen) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)"
      ).run(row.id, row.username, row.first_name, row.tier, now, now);
    }

    this.users.set(user.id, { row, writtenAt: now, pendingUses: 0 });
    return row;
  }

  getUser(id: number): UserRow | null {
    return (this.sql("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow) || null;
  }

  findUserByUsername(username: string): UserRow | null {
    const clean = username.replace(/^@/, "");
    return (this.sql("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(clean) as unknown as UserRow) || null;
  }

  getTopActiveUsers(limit = 10): UserRow[] {
    return this.sql("SELECT * FROM users ORDER BY usage_count DESC, last_seen DESC LIMIT ?").all(limit) as unknown as UserRow[];
  }

  getRecentUsers(limit = 10): UserRow[] {
    return this.sql("SELECT * FROM users ORDER BY last_seen DESC LIMIT ?").all(limit) as unknown as UserRow[];
  }

  getAllUserIds(): number[] {
    return (this.sql("SELECT id FROM users").all() as Array<{ id: number }>).map((r) => r.id);
  }

  getStats(): { users: number; premium: number; activeToday: number; imageBookmarks: number; mangaBookmarks: number } {
    const count = (query: string, ...params: Array<string | number>) =>
      ((this.sql(query).get(...params) as { c: number } | undefined)?.c ?? 0);
    return {
      users: count("SELECT COUNT(*) AS c FROM users"),
      premium: count("SELECT COUNT(*) AS c FROM users WHERE tier = 'premium'"),
      activeToday: count("SELECT COUNT(*) AS c FROM users WHERE last_seen > ?", Date.now() - 86_400_000),
      imageBookmarks: count("SELECT COUNT(*) AS c FROM bookmarks WHERE category = 'image'"),
      mangaBookmarks: count("SELECT COUNT(*) AS c FROM bookmarks WHERE category = 'manga'"),
    };
  }

  /** Tambah masa aktif VIP (menumpuk di atas sisa masa aktif). Mengembalikan data user terbaru. */
  extendPremium(id: number, days: number): UserRow | null {
    const now = Date.now();
    const existing = this.getUser(id);
    if (!existing) return null;
    const base = existing.premium_until && existing.premium_until > now ? existing.premium_until : now;
    this.sql("UPDATE users SET tier = 'premium', premium_until = ? WHERE id = ?").run(base + days * 86_400_000, id);
    this.users.delete(id);
    return this.getUser(id);
  }

  revokePremium(id: number): void {
    this.sql("UPDATE users SET tier = 'standard', premium_until = NULL WHERE id = ?").run(id);
    this.users.delete(id);
  }

  // ==========================================
  // KUOTA HARIAN
  // ==========================================
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Sisa kuota hari ini. Batas `Infinity` (VIP) selalu lolos tanpa menyentuh database. */
  quotaLeft(userId: number, key: string, dailyLimit: number): number {
    if (dailyLimit === Infinity || isOwner(userId)) return Infinity;
    const row = this.sql("SELECT used FROM quotas WHERE user_id = ? AND key = ? AND day = ?").get(userId, key, this.today()) as
      | { used: number }
      | undefined;
    return Math.max(0, dailyLimit - (row?.used ?? 0));
  }

  useQuota(userId: number, key: string, amount = 1): void {
    this.sql(
      "INSERT INTO quotas (user_id, key, used, day) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key, day) DO UPDATE SET used = used + excluded.used"
    ).run(userId, key, amount, this.today());
  }

  // ==========================================
  // PENGATURAN USER
  // ==========================================
  getUserSetting(userId: number, key: string, defaultValue = ""): string {
    const row = this.sql("SELECT value FROM user_settings WHERE user_id = ? AND key = ?").get(userId, key) as
      | { value: string }
      | undefined;
    return row ? row.value : defaultValue;
  }

  setUserSetting(userId: number, key: string, value: string): void {
    this.sql(
      "INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value"
    ).run(userId, key, value);
  }

  // ==========================================
  // STATUS MODUL (global oleh Owner, atau per user)
  // ==========================================
  isModuleEnabled(scope: "global" | "user", scopeId: number, moduleId: string, defaultVal: boolean): boolean {
    const row = this.sql("SELECT enabled FROM module_states WHERE scope = ? AND scope_id = ? AND module_id = ?").get(
      scope,
      scopeId,
      moduleId
    ) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : defaultVal;
  }

  setModuleEnabled(scope: "global" | "user", scopeId: number, moduleId: string, enabled: boolean): void {
    this.sql(
      "INSERT INTO module_states (scope, scope_id, module_id, enabled) VALUES (?, ?, ?, ?) ON CONFLICT(scope, scope_id, module_id) DO UPDATE SET enabled = excluded.enabled"
    ).run(scope, scopeId, moduleId, enabled ? 1 : 0);
  }

  // ==========================================
  // BOOKMARK
  // ==========================================
  /** Mengembalikan "saved", "exists", atau "full" (melewati batas paket). */
  addBookmark(item: {
    userId: number;
    tier: Tier;
    moduleId: string;
    itemId: string;
    title: string;
    thumbUrl: string;
    postUrl: string;
    category: BookmarkCategory;
  }): "saved" | "exists" | "full" {
    const limit = isOwner(item.userId) ? Infinity : PLANS[item.tier].maxBookmarks;
    if (limit !== Infinity && this.countBookmarks(item.userId) >= limit) {
      const dup = this.sql("SELECT 1 FROM bookmarks WHERE user_id = ? AND module_id = ? AND item_id = ?").get(
        item.userId,
        item.moduleId,
        item.itemId
      );
      return dup ? "exists" : "full";
    }

    const res = this.sql(
      "INSERT OR IGNORE INTO bookmarks (user_id, module_id, item_id, title, thumb_url, post_url, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(item.userId, item.moduleId, item.itemId, item.title, item.thumbUrl, item.postUrl, item.category, Date.now());
    return res.changes > 0 ? "saved" : "exists";
  }

  /** Hapus berdasarkan nomor baris. `userId` wajib cocok, jadi bookmark orang lain tidak bisa dihapus. */
  removeBookmark(userId: number, bookmarkId: number): boolean {
    return this.sql("DELETE FROM bookmarks WHERE id = ? AND user_id = ?").run(bookmarkId, userId).changes > 0;
  }

  getBookmark(userId: number, bookmarkId: number): BookmarkRow | null {
    return (
      (this.sql("SELECT * FROM bookmarks WHERE id = ? AND user_id = ?").get(bookmarkId, userId) as unknown as BookmarkRow) || null
    );
  }

  getBookmarks(userId: number, category: BookmarkCategory, limit: number, offset = 0): BookmarkRow[] {
    return this.sql(
      "SELECT * FROM bookmarks WHERE user_id = ? AND category = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
    ).all(userId, category, limit, offset) as unknown as BookmarkRow[];
  }

  countBookmarks(userId: number, category?: BookmarkCategory): number {
    const row = category
      ? this.sql("SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ? AND category = ?").get(userId, category)
      : this.sql("SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ?").get(userId);
    return (row as { c: number } | undefined)?.c ?? 0;
  }

  updateBookmarkUrls(id: number, thumbUrl: string, postUrl: string): void {
    this.sql("UPDATE bookmarks SET thumb_url = ?, post_url = ? WHERE id = ?").run(thumbUrl, postUrl, id);
  }

  // ==========================================
  // PEMBAYARAN
  // ==========================================
  /** Mengembalikan false jika pembayaran ini sudah pernah dicatat (update Telegram terkirim ulang). */
  recordPayment(chargeId: string, userId: number, stars: number, payload: string): boolean {
    const res = this.sql(
      "INSERT OR IGNORE INTO payments (charge_id, user_id, stars, payload, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(chargeId, userId, stars, payload, Date.now());
    return res.changes > 0;
  }

  // ==========================================
  // CACHE file_id TELEGRAM
  // ==========================================
  getFileId(cacheKey: string): string | null {
    const row = this.sql("SELECT file_id FROM file_cache WHERE cache_key = ?").get(cacheKey) as { file_id: string } | undefined;
    return row?.file_id ?? null;
  }

  setFileId(cacheKey: string, fileId: string, fileType: "document" | "photo" | "animation" = "document"): void {
    this.sql(
      "INSERT INTO file_cache (cache_key, file_id, file_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET file_id = excluded.file_id, file_type = excluded.file_type, created_at = excluded.created_at"
    ).run(cacheKey, fileId, fileType, Date.now());
  }

  // ==========================================
  // KV (catatan kecil lintas-restart, mis. waktu backup terakhir)
  // ==========================================
  getValue(key: string): string | null {
    const row = this.sql("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setValue(key: string, value: string): void {
    this.sql("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

export const repo = new Repository();
