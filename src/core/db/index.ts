import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
import { config } from "../config";
import { Tier } from "../plans";

export interface UserRow {
  id: number;
  username: string | null;
  first_name: string;
  tier: Tier;
  premium_until: number | null; // epoch ms, null = tanpa batas
  usage_count: number;
  created_at: number;
  last_seen: number;
}

export interface BookmarkRow {
  id: number;
  user_id: number;
  module_id: string;
  item_id: string;
  title: string;
  thumb_url: string;
  post_url: string;
  category: "image" | "manga";
  created_at: number;
}

let dbInstance: DatabaseSync | null = null;

export function dbFilePath(): string {
  return path.join(config.dataDir, "bot.db");
}

/**
 * Koneksi SQLite tunggal. Tabel inti dibuat di sini;
 * modul yang butuh tabel sendiri membuatnya di `onLoad` lewat `getDatabase().exec(...)`.
 */
export function getDatabase(): DatabaseSync {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(dbFilePath());

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 3000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'standard',
      premium_until INTEGER,
      usage_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS module_states (
      scope TEXT NOT NULL,
      scope_id INTEGER NOT NULL,
      module_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, scope_id, module_id)
    );

    CREATE TABLE IF NOT EXISTS quotas (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      day TEXT NOT NULL,
      PRIMARY KEY (user_id, key, day)
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      module_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT NOT NULL,
      thumb_url TEXT NOT NULL,
      post_url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'image',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payments (
      charge_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      stars INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS file_cache (
      cache_key TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      file_type TEXT NOT NULL DEFAULT 'document',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Migrasi kolom untuk database yang dibuat versi lama
  for (const sql of [
    "ALTER TABLE users ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 1;",
    "ALTER TABLE bookmarks ADD COLUMN category TEXT NOT NULL DEFAULT 'image';",
  ]) {
    try {
      db.exec(sql);
    } catch {}
  }

  // Buang bookmark ganda peninggalan versi lama, lalu kunci dengan indeks unik
  db.exec(`
    DELETE FROM bookmarks WHERE id NOT IN (
      SELECT MIN(id) FROM bookmarks GROUP BY user_id, module_id, item_id
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_unique ON bookmarks (user_id, module_id, item_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_list ON bookmarks (user_id, category, created_at);
    CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen);
  `);

  dbInstance = db;
  return db;
}

/** Perawatan ringan harian: buang data kedaluwarsa agar berkas database tidak membengkak. */
export function runDatabaseMaintenance(): void {
  const db = getDatabase();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const halfYearAgo = Date.now() - 180 * 86_400_000;

  db.prepare("DELETE FROM quotas WHERE day < ?").run(weekAgo);
  db.prepare("DELETE FROM file_cache WHERE created_at < ?").run(halfYearAgo);
  db.exec("PRAGMA optimize;");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
}

/** Salinan konsisten database ke berkas lain (aman walau bot sedang menulis). */
export function snapshotDatabase(destPath: string): void {
  fs.rmSync(destPath, { force: true });
  getDatabase().prepare("VACUUM INTO ?").run(destPath);
}

export function closeDatabase(): void {
  if (!dbInstance) return;
  try {
    dbInstance.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    dbInstance.close();
  } catch {}
  dbInstance = null;
}
