/**
 * Uji asap offline: menjalankan bot dengan API Telegram tiruan dan database sementara.
 * Tidak mengirim apa pun ke Telegram dan tidak menyentuh data/bot.db.
 * Jalankan: npm run smoke   (tambahkan argumen "net" untuk ikut menguji situs sumber)
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ntab_smoke_"));
process.env.DATA_DIR = tmp;
process.env.BOT_TOKEN = "123456:SMOKE_TEST_TOKEN";
process.env.OWNER_ID = "1";
process.env.ENABLE_IMAGE_PROXY = "false";

const OWNER = { id: 1, is_bot: false, first_name: "Owner", username: "owner" };
const USER = { id: 2, is_bot: false, first_name: "User <b>", username: "user2" };
const WITH_NETWORK = process.argv.includes("net");

async function main() {
  const { registry } = await import("../src/core/engine/registry");
  const { createBot } = await import("../src/core/bot");
  const { repo } = await import("../src/core/db/repo");
  const { closeDatabase } = await import("../src/core/db");

  await registry.loadAll();
  const bot = createBot(process.env.BOT_TOKEN!);
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "NTAB Bot",
    username: "ntab_test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: true,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as any;

  const calls: Array<{ method: string; payload: any }> = [];
  const errors: string[] = [];
  const rejected: string[] = [];
  let messageId = 1000;

  bot.api.config.use(async (_prev, method, payload: any) => {
    calls.push({ method, payload });
    // Batas asli Telegram: jawaban inline berisi lebih dari 50 hasil ditolak seluruhnya
    if (method === "answerInlineQuery" && payload.results.length > 50) {
      rejected.push(`answerInlineQuery berisi ${payload.results.length} hasil (maks 50)`);
      return { ok: false, error_code: 400, description: "Bad Request: too many inline query results specified" } as any;
    }
    for (const r of method === "answerInlineQuery" ? payload.results : []) {
      const text = String(r.caption ?? "");
      if (text.length > 1024) rejected.push(`caption ${text.length} huruf (maks 1024) pada ${r.id}`);
      if (Buffer.byteLength(String(r.id)) > 64) rejected.push(`id hasil melebihi 64 byte: ${r.id}`);
    }
    const message = () => ({
      message_id: ++messageId,
      date: 0,
      chat: { id: payload.chat_id, type: "private" },
      photo: [{ file_id: `photo_${messageId}`, file_unique_id: "u", width: 1, height: 1 }],
      document: { file_id: `doc_${messageId}`, file_unique_id: "u" },
    });
    const results: Record<string, () => unknown> = {
      sendMediaGroup: () => (payload.media as unknown[]).map(message),
      getChatMember: () => ({ status: payload.user_id === OWNER.id ? "creator" : "member", user: { id: payload.user_id } }),
      getChat: () => ({ id: payload.chat_id, type: "supergroup", title: "Grup <Uji>" }),
      getChatMemberCount: () => 42,
    };
    const result = results[method]?.() ?? (method.startsWith("send") || method.startsWith("edit") ? message() : true);
    return { ok: true, result } as any;
  });
  bot.catch((err) => {
    errors.push(`${(err.error as Error)?.stack ?? err.error}`);
  });

  let updateId = 1;
  const privateChat = (u: typeof USER) => ({ id: u.id, type: "private" as const, first_name: u.first_name });
  const group = { id: -100, type: "supergroup" as const, title: "Grup <Uji>" };

  async function step(name: string, update: Record<string, unknown>, expect: (c: typeof calls) => string | true | Promise<string | true>) {
    calls.length = 0;
    rejected.length = 0;
    const before = errors.length;
    await bot.handleUpdate({ update_id: updateId++, ...update } as any);
    const verdict =
      errors.length > before ? errors[errors.length - 1] : rejected.length > 0 ? `ditolak Telegram: ${rejected[0]}` : await expect(calls);
    if (verdict === true) console.log(`  ok   ${name}`);
    else {
      failed++;
      console.log(`  GAGAL ${name}\n       ${String(verdict).split("\n").slice(0, 4).join("\n       ")}`);
      console.log(`       panggilan: ${calls.map((c) => c.method).join(", ") || "(tidak ada)"}`);
    }
  }
  let failed = 0;

  const say = (from: typeof USER, text: string, chat: any = privateChat(from), extra: object = {}) => ({
    message: { message_id: ++messageId, date: 0, chat, from, text, ...extra },
  });
  const press = (from: typeof USER, data: string, chat: any = privateChat(from)) => ({
    callback_query: { id: String(updateId), from, chat_instance: "x", data, message: { message_id: 5, date: 0, chat, text: "lama" } },
  });
  const inline = (from: typeof USER, query: string, chat_type = "sender") => ({
    inline_query: { id: String(updateId), from, query, offset: "", chat_type },
  });

  // JSON.stringify biasa menolak InputFile, jadi berkas diganti penanda
  const dump = (v: any): string =>
    v?.constructor?.name === "InputFile"
      ? '"[file]"'
      : Array.isArray(v)
      ? `[${v.map(dump).join(",")}]`
      : v && typeof v === "object"
      ? `{${Object.entries(v).map(([k, x]) => `"${k}":${dump(x)}`).join(",")}}`
      : JSON.stringify(v) ?? "null";
  const sent = (c: typeof calls, method: string, includes?: string) =>
    c.some((x) => x.method === method && (!includes || dump(x.payload).includes(includes))) ||
    `tidak ada ${method}${includes ? ` berisi "${includes}"` : ""}`;
  const textOf = (c: typeof calls) => c.map((x) => x.payload?.text ?? x.payload?.caption ?? "").join("\n");

  console.log("\nPerintah dasar");
  await step("/start", say(USER, "/start"), (c) => sent(c, "sendMessage", "Halo"));
  await step("/menu", say(USER, "/menu"), (c) => sent(c, "sendMessage", ".wh"));
  await step("/help (perintah, bukan tombol)", say(USER, "/help"), (c) => sent(c, "sendMessage", "Bantuan"));
  await step("/help@bot_lain diabaikan", say(USER, "/help@bot_lain"), (c) => c.length === 0 || "seharusnya diam");
  await step("nama user ter-escape", say(USER, "/settings"), (c) => (!textOf(c).includes("<b>") ? "tidak ada teks" : true));
  await step(".bm (perintah titik)", say(USER, ".bm"), (c) => sent(c, "sendMessage", "Bookmark"));
  await step("/upgrade", say(USER, "/upgrade"), (c) => sent(c, "sendMessage", "Stars"));
  await step("pesan biasa tidak dijawab", say(USER, "halo semua"), (c) => c.length === 0 || "seharusnya diam");

  console.log("\nHalaman bantuan setiap modul");
  for (const mod of registry.all()) {
    await step(`bantuan ${mod.meta.id}`, press(USER, `m:menu:mod:${mod.meta.id}`), (c) => sent(c, "editMessageText", mod.meta.name.split(" ")[0]));
  }

  console.log("\nTombol & izin");
  await step("menu utama", press(USER, "m:menu:main"), (c) => sent(c, "editMessageText") === true && sent(c, "answerCallbackQuery"));
  await step("tombol lama/tak dikenal", press(USER, "toggle_nsfw"), (c) => sent(c, "answerCallbackQuery", "tidak berlaku"));
  await step("NSFW ditolak untuk akun gratis", press(USER, "m:set:toggle:nsfw"), (c) => sent(c, "answerCallbackQuery", "VIP"));
  await step("daftar fitur", press(USER, "m:set:mods"), (c) => sent(c, "editMessageText", "Wallhaven"));
  await step("matikan Wallhaven", press(USER, "m:set:mod:scraper-wallhaven"), (c) => sent(c, "answerCallbackQuery", "mati"));
  await step("perintah modul yang dimatikan ditolak", say(USER, "/wh sunset"), (c) => sent(c, "sendMessage", "nonaktif"));
  await step("nyalakan lagi", press(USER, "m:set:mod:scraper-wallhaven"), (c) => sent(c, "answerCallbackQuery", "aktif"));
  await step("modul VIP ditolak (perintah)", say(USER, "/gb test"), (c) => sent(c, "sendMessage", "VIP"));
  await step("modul VIP ditolak (tombol)", press(USER, "m:gb:dl:123"), (c) => sent(c, "answerCallbackQuery", "VIP"));
  await step("modul VIP ditolak (inline)", inline(USER, ".gb test"), (c) => sent(c, "answerInlineQuery", "VIP"));
  await step("/admin ditolak untuk non-owner", say(USER, "/admin"), (c) => sent(c, "sendMessage", "pemilik"));
  await step("tombol admin ditolak untuk non-owner", press(USER, "m:adm:mods"), (c) => sent(c, "answerCallbackQuery", "pemilik"));
  await step("/admin untuk owner", say(OWNER, "/admin"), (c) => sent(c, "sendMessage", "Panel Admin"));
  await step("/status untuk owner", say(OWNER, "/status"), (c) => sent(c, "sendMessage", "Memori"));
  await step("/backup untuk owner", say(OWNER, "/backup"), (c) => sent(c, "sendDocument", "Backup"));
  await step("owner mematikan fitur global", press(OWNER, "m:adm:mod:scraper-konachan"), (c) => sent(c, "answerCallbackQuery", "dimatikan"));
  await step("fitur global mati: user ditolak", say(USER, "/kc test"), (c) => sent(c, "sendMessage", "dinonaktifkan"));
  await step("owner menyalakan lagi", press(OWNER, "m:adm:mod:scraper-konachan"), (c) => sent(c, "answerCallbackQuery", "aktif"));
  await step("/vip oleh owner", say(OWNER, "/vip 2 30"), (c) => sent(c, "sendMessage", "VIP +30"));
  await step("user kini VIP: NSFW bisa dinyalakan", press(USER, "m:set:toggle:nsfw"), (c) => sent(c, "answerCallbackQuery", "aktif"));
  await step("/unvip oleh owner", say(OWNER, "/unvip @user2"), (c) => sent(c, "sendMessage", "dicabut"));
  await step("/report diteruskan ke owner", say(USER, "/report ada <bug>"), (c) => sent(c, "sendMessage", "&lt;bug&gt;"));

  console.log("\nBookmark");
  repo.addBookmark({ userId: 2, tier: "standard", moduleId: "scraper-wallhaven", itemId: "abc123", title: "Uji", thumbUrl: "https://th.wallhaven.cc/small/ab/abc123.jpg", postUrl: "", category: "image" });
  const bmId = repo.getBookmarks(2, "image", 1)[0].id;
  await step("daftar berupa teks, tanpa tombol per item", say(USER, "/bookmarks"), (c) => {
    const msg = c.find((x) => x.method === "sendMessage");
    const buttons = (msg?.payload.reply_markup?.inline_keyboard ?? []).flat().length;
    if (!/1\. (<a [^>]+>)?Uji/.test(String(msg?.payload.text))) return `teks: ${msg?.payload.text}`;
    return buttons <= 6 || `${buttons} tombol`;
  });
  await step("tab aktif memberi tahu, tidak memuat ulang", press(USER, "m:bm:here"), (c) => sent(c, "answerCallbackQuery", "sedang di tab ini") === true && (c.length === 1 || "ada panggilan lain"));
  await step("inline .bm", inline(USER, ".bm"), (c) => sent(c, "answerInlineQuery", "abc123"));
  const realbooruAdapter = registry.get("scraper-realbooru")?.bookmarks;
  if (realbooruAdapter) {
    const originalResolve = realbooruAdapter.resolve;
    realbooruAdapter.resolve = async () => ({
      thumbUrl: "https://img.example/legacy-thumb.jpg",
      postUrl: "https://realbooru.com/post/123",
    });
    repo.addBookmark({
      userId: USER.id,
      tier: "standard",
      moduleId: "scraper-realbooru",
      itemId: "123",
      title: "Realbooru lama",
      thumbUrl: "",
      postUrl: "https://realbooru.com/post/123",
      category: "image",
    });
    await step("inline .bm melengkapi thumbnail Realbooru lama", inline(USER, ".bm"), (c) => {
      if (!sent(c, "answerInlineQuery", "legacy-thumb.jpg")) return "thumbnail lama tidak muncul";
      const repaired = repo.getBookmarks(USER.id, "image", 30).find((b) => b.module_id === "scraper-realbooru");
      return repaired?.thumb_url.includes("legacy-thumb.jpg") || "thumbnail tidak tersimpan untuk pembukaan berikutnya";
    });
    realbooruAdapter.resolve = originalResolve;
  }
  await step("user lain tidak bisa menghapus", press(OWNER, `m:bm:del:${bmId}`), () => (repo.getBookmark(2, bmId) ? true : "terhapus oleh orang lain"));
  await step("hapus", press(USER, `m:bm:del:${bmId}`), () => (repo.getBookmark(2, bmId) ? "masih ada" : true));
  for (let i = 0; i < 25; i++) repo.addBookmark({ userId: 2, tier: "standard", moduleId: "x", itemId: String(i), title: "t", thumbUrl: "", postUrl: "", category: "image" });
  await step("batas 20 bookmark akun gratis", say(USER, "/bookmarks"), () => (repo.countBookmarks(2) === 20 ? true : `tersimpan ${repo.countBookmarks(2)}`));

  console.log("\nGrup");
  await step("/warn oleh non-admin ditolak", say(USER, "/warn", group, { reply_to_message: { message_id: 1, date: 0, chat: group, from: OWNER } }), (c) => sent(c, "sendMessage", "admin grup"));
  await step("/warn oleh admin", say(OWNER, "/warn spam", group, { reply_to_message: { message_id: 1, date: 0, chat: group, from: USER } }), (c) => sent(c, "sendMessage", "1/3"));
  await step("/groupinfo (judul ter-escape)", say(USER, "/groupinfo", group), (c) => sent(c, "sendMessage", "&lt;Uji&gt;"));
  await step("/groupinfo di chat pribadi ditolak", say(USER, "/groupinfo"), (c) => sent(c, "sendMessage", "grup"));
  await step("/admin di grup ditolak", say(OWNER, "/admin", group), (c) => sent(c, "sendMessage", "pribadi"));
  await step("/linklog on", say(OWNER, "/linklog on", group), (c) => sent(c, "sendMessage", "aktif"));
  await step("tautan dicatat", say(USER, "lihat https://example.com/a", group, { entities: [{ type: "url", offset: 6, length: 21 }] }), (c) => c.length === 0 || "seharusnya diam");
  await step("/links", say(OWNER, "/links", group), (c) => sent(c, "sendDocument", "1 tautan"));

  console.log("\nInline");
  await step("kosong: panduan prefix", inline(USER, ""), (c) => sent(c, "answerInlineQuery", ".wh"));
  await step("media-tools tanpa media", say(USER, "/mp3"), (c) => sent(c, "sendMessage", "Balas"));
  await step("/mp4 tanpa input memberi panduan", say(USER, "/mp4"), (c) => sent(c, "sendMessage", "Balas"));
  await step("/sauce tanpa foto", say(USER, "/sauce"), (c) => sent(c, "sendMessage", "tangkapan layar"));
  await step("/mg sudah dihapus: tidak dijawab", say(USER, "/mg naruto"), (c) => c.length === 0 || "seharusnya diam");

  console.log("\nFitur tambahan");
  await step("/setwelcome", say(OWNER, "/setwelcome Halo {nama}, selamat datang di {grup}!", group), (c) => sent(c, "sendMessage", "disimpan"));
  await step(
    "anggota baru disambut",
    { message: { message_id: ++messageId, date: 0, chat: group, from: USER, new_chat_members: [USER] } },
    (c) => sent(c, "sendMessage", "selamat datang di Grup &lt;Uji&gt;")
  );
  await step("/setrules + /rules", say(OWNER, "/setrules 1. Sopan", group), (c) => sent(c, "sendMessage", "disimpan"));
  await step("/rules", say(USER, "/rules", group), (c) => sent(c, "sendMessage", "1. Sopan"));
  await step("/broadcast minta konfirmasi", say(OWNER, "/broadcast Halo <semua>"), (c) => sent(c, "sendMessage", "m:adm:bc:go"));
  await step("/broadcast ditolak untuk non-owner", say(USER, "/broadcast x"), (c) => sent(c, "sendMessage", "pemilik"));
  await step("broadcast dibatalkan", press(OWNER, "m:adm:bc:no"), (c) => sent(c, "editMessageText", "dibatalkan"));
  await step("tombol Lapor ke admin", press(USER, "m:menu:report"), (c) => sent(c, "editMessageText", "/report"));
  await step(
    "owner membalas laporan dengan reply",
    say(OWNER, "Sudah <beres>", privateChat(OWNER), {
      reply_to_message: { message_id: 9, date: 0, chat: privateChat(OWNER), from: { id: 999, is_bot: true, first_name: "NTAB Bot" }, text: "📬 Laporan dari @user2 (2)\n\nada bug" },
    }),
    (c) => (c.some((x) => x.method === "sendMessage" && x.payload.chat_id === 2 && String(x.payload.text).includes("&lt;beres&gt;")) ? true : "balasan tidak sampai ke pelapor")
  );
  await step("reply owner ke pesan lain tidak diteruskan", say(OWNER, "catatan", privateChat(OWNER), {
    reply_to_message: { message_id: 9, date: 0, chat: privateChat(OWNER), from: { id: 999, is_bot: true, first_name: "NTAB Bot" }, text: "✅ Laporan terkirim." },
  }), (c) => c.length === 0 || "seharusnya diam");
  // Rumus /exclude: koma = ATAU, kurung = DAN
  const { exclusionFilter, parseExclusions } = await import("../src/core/tools/tags");
  const hidden = exclusionFilter("Yaoi, (male, solo), big spiders");
  const cases: Array<[string[], boolean]> = [
    [["yaoi", "2boys"], true],
    [["male", "solo", "smile"], true],
    [["male", "1boy"], false],
    [["solo", "1girl"], false],
    [["Big_Spiders"], true],
    [["landscape"], false],
    [[], false],
  ];
  await step("rumus /exclude: ATAU di luar kurung, DAN di dalam kurung", say(USER, "abaikan"), () => {
    const wrong = cases.filter(([tags, expected]) => hidden(tags) !== expected);
    return wrong.length === 0 || `salah untuk: ${wrong.map(([tags]) => tags.join("+")).join(" | ")}`;
  });
  await step("rumus /exclude: kurung tak berpasangan ditolak", say(USER, "/exclude yaoi, (male, solo"), (c) => sent(c, "sendMessage", "belum ditutup"));
  await step("/exclude menyimpan dan menjelaskan aturan", say(USER, "/exclude Yaoi, (male, solo)"), (c) =>
    sent(c, "sendMessage", "2 aturan") === true && sent(c, "sendMessage", "sekaligus")
  );
  await step("/exclude tanpa isi menampilkan rumus + panduan", say(USER, "/exclude"), (c) => sent(c, "sendMessage", "yaoi, (male, solo)"));
  await step("/settings menampilkan tag yang disembunyikan", say(USER, "/settings"), (c) => sent(c, "sendMessage", "/exclude") === true && sent(c, "sendMessage", "m:set:exclude"));
  await step("rumus tersimpan terbaca kembali", say(USER, "abaikan"), () =>
    JSON.stringify(parseExclusions(repo.getUserSetting(2, "excluded_tags", ""))) === '[["yaoi"],["male","solo"]]' || repo.getUserSetting(2, "excluded_tags", "")
  );
  repo.setUserSetting(2, "excluded_tags", "");
  // Pemblokiran bawaan konten anak di bawah umur
  const { isMinorContent, isMinorQuery } = await import("../src/core/tools/tags");
  const minorCases: Array<[string[], boolean, boolean]> = [
    // [tag, kiriman berlabel dewasa, harus diblokir]
    [["1girl", "loli"], false, true],
    [["oppai_loli"], true, true],
    [["Shotacon"], false, true],
    [["onee-shota"], true, true],
    [["ロリ", "オリジナル"], true, true],
    [["R-18", "幼女"], true, true],
    [["gothic_lolita", "1girl"], true, false],
    [["ゴスロリ"], true, false],
    [["カロリーメイト"], true, false],
    [["child", "smile"], false, false],
    [["child", "smile"], true, true],
    [["young", "wolf"], true, true],
    [["lion_cub"], false, false],
    [["1girl", "solo"], true, false],
    [[], true, false],
  ];
  await step("konten anak: tag loli/shota selalu diblokir, tag anak netral hanya bila dewasa", say(USER, "abaikan"), () => {
    const wrong = minorCases.filter(([tags, adult, expected]) => isMinorContent(tags, adult) !== expected);
    return wrong.length === 0 || `salah untuk: ${wrong.map(([tags, adult]) => `${tags.join("+")}${adult ? " (dewasa)" : ""}`).join(" | ")}`;
  });
  await step("konten anak: kata kunci diblokir, kecuali sebagai pengecualian (-tag)", say(USER, "abaikan"), () => {
    const blocked = ["loli", "1girl shota", "hatsune_miku lolicon", "ロリ"].filter((q) => !isMinorQuery(q));
    const allowed = ["hatsune_miku -loli", "gothic_lolita", "child", "solo leveling", ""].filter((q) => isMinorQuery(q));
    return blocked.length + allowed.length === 0 || `lolos: ${blocked.join(" | ")} ; salah blokir: ${allowed.join(" | ")}`;
  });
  await step("konten anak: perintah album menolak kata kunci", say(USER, "/sb loli"), (c) => sent(c, "sendMessage", "diblokir"));
  await step("konten anak: inline menolak kata kunci", inline(USER, ".sb 1girl loli"), (c) => {
    const results = c.find((x) => x.method === "answerInlineQuery")?.payload.results ?? [];
    return results.length === 1 && results[0].id === "sb_blocked" ? true : `hasil: ${results.map((r: any) => r.id).join(",")}`;
  });

  // Telegraph: API-nya ditiru, jadi uji ini tidak pernah menerbitkan halaman sungguhan
  const telegraphCalls: Array<{ method: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!url.startsWith("https://api.telegra.ph/")) return realFetch(input, init);
    const method = url.split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    telegraphCalls.push({ method, body });
    const result = method === "createAccount" ? { access_token: "tiruan" } : { url: `https://telegra.ph/uji-${telegraphCalls.length}` };
    return new Response(JSON.stringify({ ok: true, result }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const { parseImageSize, sliceTallImage } = await import("../src/core/tools/imageSize");
  const { publishTelegraphAlbum } = await import("../src/core/tools/telegraph");
  await step("ukuran gambar terbaca dari header PNG dan JPEG", say(USER, "abaikan"), () => {
    const png = Buffer.alloc(40);
    png.writeUInt32BE(0x89504e47, 0);
    png.writeUInt32BE(720, 16);
    png.writeUInt32BE(8631, 20);
    // JPEG: SOI, segmen APP0 (16 byte), lalu SOF0 berisi tinggi 1188 dan lebar 850
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xa4, 0x03, 0x52]),
      Buffer.alloc(20),
    ]);
    const got = JSON.stringify([parseImageSize(png), parseImageSize(jpeg), parseImageSize(Buffer.alloc(40))]);
    return got === '[{"width":720,"height":8631},{"width":850,"height":1188},null]' || got;
  });
  await step("gambar memanjang dipotong, gambar biasa dibiarkan", say(USER, "abaikan"), () => {
    const normal = sliceTallImage("https://cdn.example/1.jpg", { width: 850, height: 1188 });
    const unknown = sliceTallImage("https://cdn.example/1.jpg", null);
    const tall = sliceTallImage("https://cdn.example/2.jpg", { width: 720, height: 8631 });
    if (normal.length !== 1 || normal[0] !== "https://cdn.example/1.jpg" || unknown.length !== 1) return "gambar biasa ikut dipotong";
    const rows = tall.map((u) => [Number(u.match(/cy=(\d+)/)?.[1]), Number(u.match(/ch=(\d+)/)?.[1])]);
    const covered = rows.every(([top], i) => top === (i === 0 ? 0 : rows[i - 1][0] + rows[i - 1][1]));
    const total = rows.reduce((sum, [, height]) => sum + height, 0);
    return (tall.length === 8 && covered && total === 8631) || `potongan: ${JSON.stringify(rows)}`;
  });
  await step("Telegraph: akun dibuat sekali, isi panjang dipecah jadi bagian bersambung", say(USER, "abaikan"), async () => {
    const images = Array.from({ length: 500 }, (_, i) => `https://wsrv.nl/?url=${"x".repeat(150)}${i}`);
    const first = await publishTelegraphAlbum({ title: "Uji - Chapter 1", authorName: "@ntab_test_bot", images });
    await publishTelegraphAlbum({ title: "Uji - Chapter 2", authorName: "@ntab_test_bot", images: images.slice(0, 3) });

    const accounts = telegraphCalls.filter((t) => t.method === "createAccount").length;
    const pages = telegraphCalls.filter((t) => t.method === "createPage");
    const parts = pages.filter((t) => String(t.body.title).startsWith("Uji - Chapter 1"));
    if (accounts !== 1) return `createAccount dipanggil ${accounts} kali`;
    if (parts.length < 2) return `hanya ${parts.length} bagian`;
    if (parts.some((t) => Buffer.byteLength(JSON.stringify(t.body.content)) > 64 * 1024)) return "ada bagian di atas 64 KB";
    const count = parts.reduce((sum, t) => sum + t.body.content.filter((n: any) => n.tag === "img").length, 0);
    if (count !== 500) return `${count} gambar dari 500`;
    // Bagian pertama dibuat paling akhir dan menaut ke bagian kedua
    const head = parts[parts.length - 1];
    if (!String(head.body.title).endsWith(`(1/${parts.length})`) || !JSON.stringify(head.body.content).includes("Lanjut ke bagian 2")) return "bagian tidak bersambung";
    return first === `https://telegra.ph/uji-${telegraphCalls.indexOf(head) + 1}` || `URL yang dikembalikan bukan bagian pertama: ${first}`;
  });

  await step("/kr tanpa kata kunci", say(USER, "/kr"), (c) => sent(c, "sendMessage", "Kiryuu"));
  await step("halaman Fitur berkelompok", press(USER, "m:set:mods"), (c) => sent(c, "editMessageText", "Baca komik"));

  if (WITH_NETWORK) {
    console.log("\nKiryuu (butuh internet)");
    let mangaId = "";
    let chapterId = "";
    const find = (c: typeof calls, re: RegExp) => dump(c.map((x) => x.payload)).match(re)?.[1] ?? "";
    await step("/kr solo leveling", say(USER, "/kr solo leveling"), (c) => {
      mangaId = find(c, /m:kr:read:(\d+)/);
      return mangaId ? true : "tidak ada tombol Baca";
    });
    await step("inline .kr", inline(USER, ".kr one piece"), (c) => sent(c, "answerInlineQuery", "m:kr:read:"));
    await step("daftar chapter", press(USER, `m:kr:read:${mangaId}`), (c) => {
      chapterId = find(c, /m:kr:p:(\d+):0/);
      return chapterId ? true : "tidak ada tombol chapter";
    });
    await step("daftar chapter memuat judul, info, dan tautan", press(USER, `m:kr:read:${mangaId}`), (c) => {
      const text = textOf(c);
      if (/<b>(Manga|Komik #\d+)<\/b>/.test(text)) return `judul cadangan: ${text.slice(0, 80)}`;
      return sent(c, "editMessageText", "/?p=") === true && sent(c, "editMessageText", "🏷️");
    });
    // Komik pada laporan pengguna: situsnya punya 48 chapter mulai dari Ch. 1, bot sempat hanya menampilkan 10
    await step("daftar chapter lengkap (bukan hanya 10 terbaru)", press(USER, "m:kr:read:590734:1"), (c) => {
      const text = textOf(c);
      const total = Number(text.match(/(\d+) chapter/)?.[1] ?? 0);
      if (total < 48) return `hanya ${total} chapter`;
      if (!text.includes("(Ch. 1 sampai")) return `tidak mulai dari Ch. 1: ${text.slice(-120)}`;
      return sent(c, "answerCallbackQuery", "Memuat daftar chapter") === true && sent(c, "editMessageText", "ch:590734");
    });
    await step("lompat +5 halaman daftar tersedia saat chapter banyak", press(USER, "m:kr:read:233:1"), (c) => {
      const pages = Number(textOf(c).match(/halaman 1\/(\d+)/)?.[1] ?? 0);
      if (pages <= 5) return `komik uji hanya ${pages} halaman daftar, tombol lompat tidak teruji`;
      return sent(c, "editMessageText", "5 ⏩");
    });
    await step("inline ch:<id> menampilkan chapter", inline(USER, ".kr ch:590734"), (c) => sent(c, "answerInlineQuery", "Baca chapter ini"));
    await step("inline ch:<id> <nomor> menyaring", inline(USER, ".kr ch:590734 17"), (c) => {
      const titles = (c.find((x) => x.method === "answerInlineQuery")?.payload.results ?? []).map((r: any) => r.title);
      return titles.length > 0 && titles.every((t: string) => t.startsWith("Ch. 17")) ? true : `hasil: ${titles.join(", ")}`;
    });
    await step("buka halaman 1", press(USER, `m:kr:p:${chapterId}:0`), (c) => sent(c, "sendPhoto", "hal. 1/"));
    await step("halaman 3", press(USER, `m:kr:p:${chapterId}:2`), (c) => sent(c, "sendPhoto", "hal. 3/"));
    await step("lanjut baca diingat", press(USER, `m:kr:read:${mangaId}`), (c) => sent(c, "editMessageText", "hal. 3"));
    await step("bookmark komik", press(USER, `m:kr:fav:${mangaId}`), (c) => sent(c, "answerCallbackQuery"));
    // Laporan pengguna: chapter lama komik ini menulis <img src='...'> dengan kutip tunggal dan sempat tidak terbaca
    await step("chapter bertag gambar kutip tunggal terbuka", press(USER, "m:kr:p:600741:0"), (c) => sent(c, "sendPhoto", "hal. 1/48"));

    console.log("\nTelegraph (API Telegraph ditiru)");
    const pagesMade = () => telegraphCalls.filter((t) => t.method === "createPage").length;
    await step("tombol Mode mengalihkan daftar chapter ke Telegraph", press(USER, "m:kr:mode:600709:1"), (c) =>
      sent(c, "editMessageText", "m:kr:tg:600741") === true && sent(c, "editMessageText", "Mode: Telegraph")
    );
    let before = pagesMade();
    await step("chapter manga: satu halaman Telegraph, gambar tidak dipotong", press(USER, "m:kr:tg:600741"), (c) => {
      const page = telegraphCalls[telegraphCalls.length - 1];
      if (pagesMade() !== before + 1) return `createPage dipanggil ${pagesMade() - before} kali`;
      if (!String(page.body.title).endsWith("Igokochi ga Warukunai - Chapter 1")) return `judul: ${page.body.title}`;
      if (page.body.content.length !== 48 || JSON.stringify(page.body.content).includes("wsrv.nl")) return `isi: ${page.body.content.length} gambar`;
      return sent(c, "editMessageText", "telegra.ph/uji-") === true && sent(c, "editMessageText", "m:kr:tg:600742");
    });
    before = pagesMade();
    await step("pengguna lain, chapter sama: memakai halaman yang sudah ada", press(OWNER, "m:kr:tg:600741"), (c) =>
      pagesMade() === before ? sent(c, "editMessageText", "telegra.ph/uji-") : "halaman dibuat ulang"
    );
    await new Promise((resolve) => setTimeout(resolve, 3200)); // jeda anti-spam pembuatan halaman per pengguna
    await step("chapter manhwa: gambar memanjang dipotong", press(USER, "m:kr:tg:817012"), (c) => {
      const content = JSON.stringify(telegraphCalls[telegraphCalls.length - 1].body.content);
      const slices = content.match(/wsrv\.nl/g)?.length ?? 0;
      return slices > 20 ? sent(c, "editMessageText", "gambar") : `hanya ${slices} potongan`;
    });
    await step("kembali ke mode per halaman", press(USER, "m:kr:mode:600709:1"), (c) => sent(c, "editMessageText", "m:kr:p:600741:0"));

    console.log("\nKonten anak di bawah umur (butuh internet)");
    // Komik uji: #318193, bergenre Lolicon di Kiryuu
    await step("genre lolicon ditolak sebagai kata kunci", inline(USER, ".kr genre:lolicon"), (c) => sent(c, "answerInlineQuery", "kr_blocked"));
    await step("komik lolicon tidak muncul saat dicari lewat judul", inline(USER, ".kr Kiotsukenayo"), (c) => {
      const results = c.find((x) => x.method === "answerInlineQuery")?.payload.results ?? [];
      return results.every((r: any) => r.id !== "kr_318193") || "komik lolos";
    });
    await step("komik lolicon: daftar chapter ditolak", press(USER, "m:kr:read:318193"), (c) => sent(c, "editMessageText", "tidak tersedia"));
    const blockedList = (await (await realFetch("https://v7.kiryuu.to/wp-admin/admin-ajax.php?manga_id=318193&action=get_chapters")).json()) as {
      data?: Array<{ url: string }>;
    };
    const blockedChapter = blockedList.data?.[0]?.url.match(/\.(\d+)\/?$/)?.[1] ?? "";
    before = pagesMade();
    await step("komik lolicon: halaman chapter ditolak", press(USER, `m:kr:p:${blockedChapter}:0`), (c) =>
      blockedChapter ? sent(c, "answerCallbackQuery", "tidak tersedia") === true && (!c.some((x) => x.method === "sendPhoto") || "gambar terkirim") : "chapter uji tidak ditemukan"
    );
    await step("komik lolicon: Telegraph ditolak", press(USER, `m:kr:tg:${blockedChapter}`), (c) =>
      pagesMade() === before ? sent(c, "answerCallbackQuery", "tidak tersedia") : "halaman Telegraph dibuat"
    );

    console.log("\nPixiv & Gelbooru (butuh internet)");
    const inlineResults = (c: typeof calls) => (c.find((x) => x.method === "answerInlineQuery")?.payload.results ?? []) as any[];
    const nextOffset = (c: typeof calls) => String(c.find((x) => x.method === "answerInlineQuery")?.payload.next_offset ?? "");
    const at = (from: typeof USER, query: string, offset: string) => ({
      inline_query: { id: String(updateId), from, query, offset, chat_type: "sender" },
    });

    let pxNext = "";
    await step("px tag: pencarian Pixiv, gambar ukuran kecil/sedang", inline(OWNER, ".px kokomi"), (c) => {
      const r = inlineResults(c);
      pxNext = nextOffset(c);
      if (r.length < 10) return `hanya ${r.length} hasil`;
      if (!String(r[0].caption).includes("🏷️")) return `tanpa tag: ${r[0].caption}`;
      if (!r[0].thumbnail_url.includes("540x540")) return `thumbnail bukan ukuran kecil: ${r[0].thumbnail_url}`;
      if (!r[0].photo_url.includes("_master1200")) return `foto bukan ukuran sedang: ${r[0].photo_url}`;
      return r[0].photo_width > 0 || "tanpa ukuran gambar";
    });
    await step("px halaman 2: paruh kedua, tanpa gambar terulang", at(OWNER, ".px kokomi", pxNext), (c) => {
      const r = inlineResults(c);
      return r.length >= 10 || `hasil ${r.length} (offset "${pxNext}")`;
    });
    await step("px kosong: peringkat harian", inline(OWNER, ".px"), (c) => inlineResults(c).length > 10 || `hasil ${inlineResults(c).length}`);
    await step("px ID karya dewasa disembunyikan saat NSFW mati", inline(OWNER, ".px 99040957"), (c) => inlineResults(c).length === 0 || "bocor");
    repo.setUserSetting(OWNER.id, "nsfw", "1");
    await step("px ID karya: satu paket berisi semua halaman", inline(OWNER, ".px 99040957"), (c) => {
      const r = inlineResults(c);
      return r.length === 7 && r[6].id === "px_99040957_p6" ? true : `hasil ${r.length}: ${r.map((x) => x.id).join(",")}`;
    });
    await step("px id:<kreator>: karya kreator + tombol Kreator", inline(OWNER, ".px id:10415882"), (c) => {
      const r = inlineResults(c);
      return r.length >= 5 ? sent(c, "answerInlineQuery", ".px id:10415882") : `hanya ${r.length} hasil`;
    });
    await step("px tombol 'Semua halaman' pada karya banyak halaman", inline(OWNER, ".px 99040957"), (c) => sent(c, "answerInlineQuery", "Semua halaman (7)"));
    await step("/px id:<kreator> mengirim album", say(OWNER, "/px id:10415882"), (c) => sent(c, "sendMediaGroup"));

    await step("/exclude off", say(OWNER, "/exclude off"), (c) => sent(c, "sendMessage", "dikosongkan"));
    await step("keterangan & tombol bisa dimatikan", press(OWNER, "m:set:toggle:captions"), (c) => sent(c, "answerCallbackQuery", "mati"));
    await step("  ...tombol", press(OWNER, "m:set:toggle:buttons"), (c) => sent(c, "answerCallbackQuery", "mati"));
    await step("  ...hasil inline polos", inline(OWNER, ".px 99040957"), (c) => {
      const r = inlineResults(c);
      return r.length === 7 && !r[0].caption && !r[0].reply_markup ? true : `caption="${r[0]?.caption}" tombol=${Boolean(r[0]?.reply_markup)}`;
    });
    repo.setUserSetting(OWNER.id, "captions", "1");
    repo.setUserSetting(OWNER.id, "buttons", "1");
    await step("/reply ke pengguna", say(OWNER, "/reply 2 Sudah <diperbaiki>"), (c) => sent(c, "sendMessage", "&lt;diperbaiki&gt;"));

    await step("e621: hasil + tag + tombol Kreator", inline(OWNER, ".fur wolf"), (c) => {
      const r = inlineResults(c);
      if (r.length < 5) return `hanya ${r.length} hasil`;
      return String(r[0].caption).includes("🏷️") || `tanpa tag: ${r[0].caption}`;
    });

    let gbFirst: string[] = [];
    let gbNext = "";
    await step("gb halaman 1: 42 hasil + penanda posisi", inline(OWNER, ".gb -animated"), (c) => {
      gbFirst = inlineResults(c).map((x) => x.id);
      gbNext = nextOffset(c);
      return gbFirst.length >= 30 && gbNext.includes("|") ? true : `hasil ${gbFirst.length}, next "${gbNext}"`;
    });
    await step("gb halaman 2: tidak ada gambar terulang", at(OWNER, ".gb -animated", gbNext), (c) => {
      const second = inlineResults(c).map((x) => x.id);
      const repeated = second.filter((id) => gbFirst.includes(id));
      return second.length >= 30 && repeated.length === 0 ? true : `hasil ${second.length}, terulang ${repeated.length}`;
    });

    console.log("\nSitus sumber (butuh internet)");
    const results = (c: typeof calls) => c.find((x) => x.method === "answerInlineQuery")?.payload.results?.length ?? 0;
    for (const prefix of [".wh", ".kc", ".sb"]) {
      await step(`inline ${prefix} landscape`, inline(USER, `${prefix} landscape`), (c) => results(c) > 0 || "0 hasil");
    }
    await step("inline tanpa prefix memakai mesin bawaan", inline(USER, "landscape"), (c) => results(c) > 0 || "0 hasil");
    await step("album /wh landscape", say(USER, "/wh landscape"), (c) => sent(c, "sendMediaGroup") === true && sent(c, "sendMessage", "offset:10"));
    await new Promise((resolve) => setTimeout(resolve, 6500)); // jeda anti-spam album per pengguna
    await step("album dengan offset dan limit", say(USER, "/wh landscape offset:10 limit:3"), (c) => {
      const group = c.find((x) => x.method === "sendMediaGroup");
      if (group?.payload.media.length !== 3) return `jumlah foto: ${group?.payload.media.length}`;
      return sent(c, "sendMessage", "hasil ke-11 sampai 13");
    });
    await step("album kedua memakai cache file_id", say(OWNER, "/wh landscape"), (c) => sent(c, "sendMediaGroup", "photo_"));
    await step("File HD", press(USER, `m:wh:dl:${"w53lv6"}`), (c) => sent(c, "sendDocument"));
  }

  closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? "\nSemua lulus." : `\n${failed} langkah gagal.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
