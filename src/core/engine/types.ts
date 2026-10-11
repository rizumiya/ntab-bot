import { Api, Composer, Context } from "grammy";
import { InlineQueryResult, UserFromGetMe } from "grammy/types";
import { UserRow } from "../db/index";
import { Repository } from "../db/repo";
import { Tier } from "../plans";

/** Context yang tersedia di setiap handler. */
export interface BotContext extends Context {
  user: UserRow;
  db: Repository;
}

export type ChatScope = "private" | "group" | "both";

/** Siapa yang boleh menjalankan perintah. `group_admin` berlaku di grup; di chat pribadi selalu lolos. */
export type Access = "all" | "group_admin" | "owner";

export interface CommandDef {
  /** Nama tanpa garis miring. Otomatis bisa dipanggil sebagai `/nama` dan `.nama`. */
  command: string;
  aliases?: string[];
  /** Satu kalimat pendek; tampil di /help dan tombol menu Telegram. */
  description: string;
  /** Contoh pemakaian, mis. "/px <id | tag>". */
  usage?: string;
  /** Bawaan: mengikuti `meta.scope` modul. */
  scope?: ChatScope;
  /** Bawaan: "all". */
  access?: Access;
  /** Tampilkan di daftar "/" Telegram. */
  listed?: boolean;
  /** `args` = teks setelah nama perintah, sudah di-trim. */
  handler: (ctx: BotContext, args: string) => Promise<void>;
}

export interface InlineResultResponse {
  items: InlineQueryResult[];
  nextOffset?: string;
  cacheTime?: number;
}

export interface InlineDef {
  /** Mis. ".wh". Dipakai sebagai `@bot .wh <kata kunci>`. */
  prefix: string;
  aliases?: string[];
  description: string;
  handler: (ctx: BotContext, query: string, offset: string, prefix: string) => Promise<InlineResultResponse>;
}

export interface CallbackDef {
  /** Tombol memakai data `m:<ns>:<action>:<arg>` (lihat `cb()` di tools/ui). */
  action: string;
  handler: (ctx: BotContext, arg: string) => Promise<void>;
}

/** Pengaturan on/off per user. Dirender otomatis oleh modul settings. */
export interface SettingDef {
  key: string;
  label: string;
  description: string;
  defaultValue: boolean;
  minTier?: Tier;
}

/** Tombol yang disumbangkan modul ke Menu Utama. */
export interface MenuButton {
  label: string;
  action: string;
  arg?: string;
  order?: number;
  visible?: (ctx: BotContext) => boolean;
}

/** Cara modul bookmarks menampilkan item milik modul ini tanpa mengenal isinya. */
export interface BookmarkAdapter {
  category: "image" | "manga";
  /** Lengkapi URL yang kosong pada data lama. */
  resolve?: (itemId: string) => { thumbUrl?: string; postUrl?: string };
  /** Tombol aksi utama pada item bookmark. */
  openButton: { label: string; action: string };
}

export interface AppHandle {
  api: Api;
  me: UserFromGetMe;
}

export interface BotModule {
  meta: {
    /** ID unik, mis. "scraper-wallhaven". */
    id: string;
    name: string;
    emoji: string;
    /** Satu kalimat: apa gunanya bagi pengguna. */
    description: string;
    category: "search" | "manga" | "tool" | "group" | "system";
    scope: ChatScope;
    minTier: Tier;
    defaultEnabled: boolean;
    version: string;
    /** Modul sistem selalu aktif dan tidak tampil di daftar on/off. */
    system?: boolean;
  };

  /** Awalan pendek untuk data tombol (batas Telegram 64 byte). Bawaan: `meta.id`. */
  callbackNs?: string;

  commands?: CommandDef[];
  inline?: InlineDef;
  callbacks?: CallbackDef[];
  settings?: SettingDef[];
  menuButtons?: MenuButton[];
  bookmarks?: BookmarkAdapter;

  /** Baris tips tambahan (HTML) untuk halaman bantuan modul. */
  help?: string[];

  /** Dipanggil untuk setiap pesan yang bukan perintah. Jangan melakukan pekerjaan berat di sini. */
  onMessage?: (ctx: BotContext) => Promise<void>;
  /** Daftarkan handler grammY apa pun (pembayaran, anggota baru, dll). */
  setup?: (composer: Composer<BotContext>) => void;

  /** Sekali saat modul dimuat, sebelum bot terhubung (buat tabel, isi cache). */
  onLoad?: () => Promise<void> | void;
  /** Sekali setelah bot terhubung ke Telegram (jadwal berkala, notifikasi). */
  onStart?: (app: AppHandle) => Promise<void> | void;
  /** Saat bot dimatikan (hentikan timer). */
  onStop?: () => Promise<void> | void;
}
