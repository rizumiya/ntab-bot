# NTAB Telegram Bot

Bot Telegram modular untuk mencari gambar anime dan wallpaper dari banyak sumber, membaca komik berbahasa Indonesia, lengkap dengan bookmark, alat media, moderasi grup, dan langganan VIP lewat Telegram Stars.

**Prinsip rancangan:** inti (`src/core`) hanya menyediakan alat; setiap fitur adalah modul di `src/modules`. Menambah fitur berarti menambah satu folder, tanpa mengubah inti.

- [Fitur](#fitur)
- [Cara memakai](#cara-memakai)
- [Menjalankan di komputer sendiri](#menjalankan-di-komputer-sendiri)
- [Konfigurasi](#konfigurasi)
- [Deploy ke VPS](#deploy-ke-vps) (panduan aman: [DEPLOY.md](DEPLOY.md))
- [Operasional](#operasional)
- [Arsitektur](#arsitektur)
- [Membuat modul](#membuat-modul)
- [Pemecahan masalah](#pemecahan-masalah)

---

## Fitur

| Modul | Perintah | Inline | Paket | Kegunaan |
|---|---|---|---|---|
| 🖼️ Wallhaven | `/wh` | `.wh` | Gratis | Wallpaper Full HD sampai 4K |
| 🌸 Konachan | `/kc` | `.kc` | Gratis | Wallpaper anime HD sampai 8K |
| 🛡️ Safebooru | `/sb` | `.sb` | Gratis | Ilustrasi anime, seluruhnya SFW |
| 🎴 Gelbooru | `/gb` | `.gb` | VIP | Galeri anime: gambar, GIF, dan video, dengan filter rating |
| 📦 Danbooru | `/db` | `.db` | VIP | Galeri anime bertag paling teliti: gambar, GIF, video |
| 🐾 e621 | `/fur` | `.fur` | VIP | Galeri seni furry, dengan filter rating |
| 📷 Realbooru | `/rp` | `.rp` | VIP | Foto cosplay dan model (seluruhnya konten dewasa) |
| 🎨 Pixiv | `/px` | `.px` | VIP | Fanart per tag, paket per ID karya, atau karya per ID kreator |
| 📚 Kiryuu | `/kr` | `.kr` | Gratis | Komik berbahasa Indonesia, baca di Telegram |
| 🎬 Media Tools | `/mp3`, `/gif`, `/ugoira` | - | Gratis | Ambil audio dari video, ubah video ke GIF, animasi Pixiv ke video |
| 🔍 Cari Sumber Gambar | `/sauce` | - | Gratis | Judul anime dan episode, atau kreator sebuah fanart |
| 👥 Moderasi Grup | `/warn`, `/mute`, `/ban`, `/setwelcome`, ... | - | Gratis | Peringatan bertingkat, bisukan, sambutan, aturan |
| 🔗 Stiker & Tautan | `/stickers`, `/linklog`, `/links` | `.st` | Gratis | Indeks paket stiker, arsip tautan grup |
| 📚 Bookmark | `/bookmarks` | `.bm`, `.bmm` | Gratis | Simpan gambar dan manga favorit |
| ⭐ Premium VIP | `/upgrade` | - | - | Beli VIP dengan Telegram Stars |
| ⚙️ Pengaturan | `/settings`, `/exclude` | - | - | NSFW, tampilan hasil, tag yang disembunyikan, fitur aktif |
| 👑 Admin | `/admin`, `/status`, `/backup`, `/vip`, `/broadcast`, `/reply` | - | Owner | Statistik, backup, kelola VIP, pengumuman, balas laporan |

**Gratis vs VIP**

| | Gratis | VIP |
|---|---|---|
| Gambar per album | 10 | 20 |
| Unduhan File HD per hari | 50 | Tanpa batas |
| Bookmark | 20 | Tanpa batas |
| Gelbooru dan Pixiv | - | Ya |
| Konten dewasa | - | Ya, hanya di chat pribadi |

Harga dan durasi VIP diatur di [`src/core/plans.ts`](src/core/plans.ts).

---

## Cara memakai

**1. Perintah.** Kirim ke bot (atau di grup). Garis miring dan titik sama saja: `/wh sunset` = `.wh sunset`.

```text
/wh sunset          album wallpaper
/kr solo leveling   cari komik, lalu tekan "Baca"
/px 99040957        semua halaman sebuah karya Pixiv
/sauce              (sambil membalas foto) cari judul anime
```

Album bisa digeser dan dibatasi dengan menambahkan parameter di belakang kata kunci:

```text
/db hatsune_miku offset:20        lewati 20 hasil pertama
/wh sunset offset:10 limit:5      5 gambar, mulai dari hasil ke-11
```

Tiap album ditutup dengan perintah lanjutan yang tinggal disalin, mis. `/wh sunset offset:10`. `offset` maksimal 200.

**2. Inline.** Di chat mana pun, ketik nama bot, awalan, lalu kata kunci. Pilih hasilnya untuk dikirim.

```text
@nama_bot .wh sunset
@nama_bot .kr solo leveling
@nama_bot .bm              galeri bookmark sendiri
@nama_bot                  tanpa awalan = list seluruh menu inline
```

**3. Tombol.** Setiap hasil membawa tombol:

| Tombol | Fungsi |
|---|---|
| 📥 File HD | Kirim berkas resolusi asli ke chat pribadi Anda |
| 💾 Bookmark | Simpan ke `/bookmarks` |
| 🔗 Sumber | Buka halaman asli |
| 📖 Baca | Buka daftar chapter. Posisi terakhir diingat: tekan **Lanjut** untuk meneruskan |
| 🖼️ / ⚡ Mode | Di daftar chapter: ganti cara baca antara **per halaman** dan **Telegraph** |
| ⚡ Telegraph | Satu chapter penuh sebagai satu halaman Instant View, tinggal gulir |

**Mode Telegraph.** Halaman dibuat sekali per chapter lalu dipakai ulang oleh semua pengguna (alamatnya disimpan di database selama 30 hari). Gambar webtoon/manhwa yang sangat panjang dipotong otomatis menjadi potongan seukuran layar, dan chapter di atas 100 gambar dibagi menjadi beberapa halaman bersambung (Telegram tidak membuat Instant View untuk halaman yang gambarnya terlalu banyak). Bila Instant View tetap tidak muncul, tekan **🔄 Buat ulang**. Server bot tidak mengunduh gambarnya: halaman Telegraph hanya memuat tautan ke server gambar Kiryuu, dan pemotongan dikerjakan CDN publik `wsrv.nl` saat halaman dibuka.

Panduan lengkap per fitur tersedia di dalam bot: **/help**.

### Kata kunci

| Sumber | Gaya | Contoh |
|---|---|---|
| Wallhaven | Kata bebas | `/wh cyberpunk city` |
| Konachan, Safebooru, Gelbooru, Danbooru, e621, Realbooru | Tag booru (garis bawah dalam satu tag; `-tag` mengecualikan) | `/kc hatsune_miku`, `.gb blue_archive -animated` |
| Pixiv | Tag, ID karya, atau ID kreator | `/px genshin`, `/px 99040957`, `/px 99040957_p2`, `/px id:10415882` |
| Kiryuu | Judul, atau satu/beberapa genre | `/kr solo leveling`, `/kr action`, `/kr mystery horror`, `/kr academy genre: action comedy` |

### Tampilan hasil

Setiap hasil menampilkan tag dari situs sumbernya. Yang bisa diatur per akun:

| Pengaturan | Cara | Akibat |
|---|---|---|
| Keterangan gambar | `/settings` | Mati = gambar dikirim tanpa judul, tag, dan tautan |
| Tombol di bawah gambar | `/settings` | Mati = gambar dikirim tanpa tombol |
| Tag yang disembunyikan | `/exclude <rumus>` | Gambar yang cocok tidak muncul lagi di pencarian Anda. `/exclude off` mengosongkan |

**Rumus `/exclude`**

| Rumus | Gambar disembunyikan bila |
|---|---|
| `/exclude yaoi, gore` | ber-tag `yaoi` **atau** `gore` (koma = atau) |
| `/exclude (male, solo)` | ber-tag `male` **dan** `solo` sekaligus (kurung = dan) |
| `/exclude yaoi, (male, solo)` | ber-tag `yaoi`, atau ber-tag `male` dan `solo` sekaligus |

Perintah ini mengganti seluruh rumus lama. `/exclude` tanpa isi menampilkan rumus yang sedang berlaku.

### Konten anak di bawah umur

Diblokir oleh bot sendiri: berlaku untuk semua pengguna (termasuk VIP dan owner) dan tidak bisa dimatikan lewat pengaturan.

| Yang diblokir | Kapan |
|---|---|
| Tag seksualisasi anak: `loli`, `shota`, `lolicon`, `shotacon`, `toddlercon`, padanan Jepangnya di Pixiv (`ロリ`, `ショタ`, `幼女`, ...) | Selalu, apa pun ratingnya. Juga ditolak sebagai kata kunci |
| Tag anak yang netral: `child`, `young`, `toddler`, `teen`, `aged_down`, ... | Hanya bila kirimannya berlabel dewasa |
| Komik Kiryuu bergenre Loli, Lolicon, Shotacon | Selalu: tidak muncul di pencarian dan tidak bisa dibaca |

Daftar tagnya ada di [`src/core/tools/tags.ts`](src/core/tools/tags.ts). Penyaringan bergantung pada tag dari situs sumber, jadi kiriman yang tidak diberi tag oleh situsnya tidak terdeteksi (Wallhaven tidak menyediakan tag di hasil pencarian).

### Perintah grup

Jadikan bot admin grup dengan izin **Blokir pengguna**. Semua perintah dipakai dengan membalas pesan anggota, dan hanya bisa dijalankan admin grup.

| Perintah | Fungsi |
|---|---|
| `/warn [alasan]` | Peringatan. Peringatan ke-3 mengeluarkan anggota |
| `/unwarn` | Hapus semua peringatan |
| `/mute [menit]` | Bisukan (bawaan 60 menit) |
| `/unmute` | Buka bisu |
| `/ban`, `/unban` | Keluarkan, atau izinkan masuk lagi |
| `/setwelcome <teks\|off>` | Pesan sambutan anggota baru. `{nama}` dan `{grup}` diganti otomatis |
| `/setrules <teks\|off>`, `/rules` | Atur dan tampilkan aturan grup (`/rules` boleh semua anggota) |
| `/linklog on\|off` | Nyalakan atau matikan arsip tautan (bawaan: mati) |
| `/links` | Unduh arsip tautan sebagai berkas |
| `/groupinfo` | ID dan jumlah anggota (semua anggota boleh) |

### Perintah owner

| Perintah | Fungsi |
|---|---|
| `/admin` | Panel: statistik, pengguna aktif, tombol backup |
| `/status` | Memori bot, beban CPU server, ukuran database |
| `/backup` | Kirim salinan database sekarang |
| `/vip <ID\|@username> [hari]` | Beri atau perpanjang VIP (bawaan 30 hari) |
| `/unvip <ID\|@username>` | Cabut VIP |
| `/broadcast <teks>` | Pengumuman ke semua pengguna, dengan pratinjau dan konfirmasi |
| `/reply <ID> <pesan>` | Balas laporan seorang pengguna. Lebih cepat: balas (reply) langsung pesan laporannya |

**Laporan pengguna.** Siapa pun bisa mengirim `/report <pesan>` (juga ada tombol **📬 Lapor ke admin** di menu). Pesan masuk ke chat owner bersama ID pelapor; balasan owner dikirim bot ke pelapor.

Di panel admin, **Fitur global** mematikan sebuah fitur bagi semua pengguna, misalnya saat situs sumbernya bermasalah.

---

## Menjalankan di komputer sendiri

Butuh **Node.js 22.13 atau lebih baru** (bot memakai `node:sqlite` bawaan). FFmpeg diperlukan untuk `/mp3`, `/gif`, dan `/ugoira`.

```bash
npm install
```

```bash
cp .env.example .env
```

Isi `BOT_TOKEN` dan `OWNER_ID` di `.env`, lalu:

```bash
npm run dev
```

| Skrip | Fungsi |
|---|---|
| `npm run dev` | Jalankan langsung dari TypeScript |
| `npm run build` | Kompilasi ke `dist/` |
| `npm start` | Jalankan hasil kompilasi |
| `npm run typecheck` | Periksa tipe tanpa kompilasi |
| `npm run smoke` | Uji offline: API Telegram tiruan, database sementara |
| `npm run smoke -- net` | Uji yang sama, ditambah situs sumber sungguhan |

> Satu token hanya boleh dipakai satu proses. Menjalankan bot lokal dengan token yang sama dengan bot di VPS akan membuat keduanya saling memutus (error 409).

---

## Konfigurasi

Semua pengaturan ada di `.env` dan dibaca di satu tempat: [`src/core/config.ts`](src/core/config.ts).

| Variabel | Bawaan | Keterangan |
|---|---|---|
| `BOT_TOKEN` | - | **Wajib.** Token dari @BotFather |
| `OWNER_ID` | - | **Wajib.** ID angka pemilik bot. Tanpa ini panel admin dan backup otomatis mati |
| `DEFAULT_INLINE_PREFIX` | `.wh` | Mesin pencari saat pengguna mengetik tanpa awalan |
| `ENABLE_IMAGE_PROXY` | `false` | Proxy gambar untuk CDN ber-proteksi hotlink |
| `PROXY_HOST` | `127.0.0.1` | Alamat dengar proxy. Biarkan lokal, taruh di belakang nginx |
| `PROXY_PORT` | `3080` | Port proxy |
| `PROXY_PUBLIC_URL` | kosong | Alamat HTTPS publik proxy. Kosong = proxy tidak dipakai |
| `ENABLE_CUSTOM_DNS` | `false` | DNS alternatif bila ISP memblokir situs sumber. Di VPS: `false` |
| `PIXIV_PHPSESSID` | kosong | Cookie sesi akun Pixiv. Tanpa ini Pixiv tetap jalan, tetapi karya berlabel dewasa nyaris tidak muncul |
| `SAUCENAO_API_KEY` | kosong | Kunci SauceNAO. Tanpa ini `/sauce` hanya mengenali tangkapan layar anime |
| `KIRYUU_URL` | `https://v7.kiryuu.to` | Alamat Kiryuu. Ubah bila domainnya berganti |
| `TELEGRAPH_TOKEN` | kosong | Token akun Telegraph untuk mode baca Telegraph. Kosong = bot membuat akun sendiri saat pertama dipakai dan menyimpan tokennya di database |
| `GELBOORU_USER_ID`, `GELBOORU_API_KEY` | kosong | API Gelbooru: lebih cepat, plus GIF dan video. Tanpa ini dipakai pembacaan HTML |
| `MAX_UPDATE_CONCURRENCY` | `8` | Update Telegram yang diproses bersamaan |
| `MAX_ALBUM_JOBS` | `2` | Album yang diunduh bersamaan |
| `MAX_FFMPEG_JOBS` | `1` | Konversi FFmpeg bersamaan |
| `MAX_PROXY_CONNECTIONS` | `8` | Koneksi proxy bersamaan |
| `DATA_DIR` | `data` | Folder database |
| `LOG_LEVEL` | `info` | `debug` mencatat setiap update |

**Tentang image proxy.** Tanpa proxy, semua fitur tetap jalan; hanya thumbnail Gelbooru (jalur HTML) di mode inline yang bisa tidak tampil. Proxy hanya melayani domain di daftar izin dan hanya URL yang ditandatangani bot, jadi tidak bisa ditumpangi pihak luar.

Proxy harus beralamat **HTTPS dengan nama domain**, bukan `http://IP:port`: Telegram hanya mau mengambil gambar inline lewat HTTPS bersertifikat sah, dan sertifikat gratis tidak diterbitkan untuk alamat IP. Pada VPS Docker, proxy perlu route khusus melalui Cloudflare Tunnel; tidak ada port host yang dibuka otomatis.

---

**Mengambil `PIXIV_PHPSESSID`.** Login ke pixiv.net di peramban, buka DevTools (F12) > Application > Cookies > `https://www.pixiv.net`, lalu salin nilai `PHPSESSID`. Cookie ini setara dengan login akun: simpan hanya di `.env`, dan ganti (logout lalu login lagi) bila pernah terbagi. Bila pencarian dewasa mendadak kosong, cookie-nya kedaluwarsa: ambil yang baru.

---

## Deploy ke VPS

Bot dijalankan sebagai stack Docker Compose di `/opt/stacks/ntab-bot`, mengikuti jaringan `edge` dan batas sumber daya stack lain. Tidak ada port host yang dibuka. Panduan pemasangan, pembaruan, pemulihan database, dan operasional: [DEPLOY.md](DEPLOY.md).

### Pemasangan pertama (Docker Compose)

Pastikan Docker Compose aktif dan jaringan `edge` tersedia:

```bash
ssh rizumiya 'docker compose ls'
ssh rizumiya 'docker network inspect edge --format "{{.Name}}"'
```

Siapkan `/opt/stacks/ntab-bot/.env` berdasarkan [`.env.example`](.env.example), lalu kunci izinnya:

```bash
chmod 600 /opt/stacks/ntab-bot/.env
```

Jalankan container dari folder stack:

```bash
cd /opt/stacks/ntab-bot && docker compose up -d --build
```

### Memperbarui

```bash
cd /opt/stacks/ntab-bot && docker compose up -d --build
```

Panduan langkah demi langkah untuk mengirim kode tracked tanpa `.env` atau database: [DEPLOY.md](DEPLOY.md).

| Perintah | Fungsi |
|---|---|
| `docker compose up -d --build` | Build dan terapkan kode terbaru |
| `docker compose ps` | Lihat keadaan container |
| `docker compose logs -f` | Lihat log langsung |

### Batas sumber daya

Diatur di [`compose.yml`](compose.yml), supaya bot tidak mengganggu layanan lain di server yang sama:

| Batas | Nilai | Akibat bila terlampaui |
|---|---|---|
| `mem_limit` | 512 MB | Container dibatasi; Docker dapat menghentikannya jika kehabisan memori |
| `cpus` | 0,8 core | Pemakaian CPU container dibatasi |

Terukur saat diam: sekitar 40 MB memori dan CPU mendekati nol. Memori naik sementara saat mengirim album atau mengonversi video.

Image Docker sudah menyertakan FFmpeg untuk `/mp3`, `/gif`, dan `/ugoira`.

---

## Operasional

| Keperluan | Perintah |
|---|---|
| Status | `cd /opt/stacks/ntab-bot && docker compose ps` |
| Log langsung | `cd /opt/stacks/ntab-bot && docker compose logs -f` |
| Restart | `cd /opt/stacks/ntab-bot && docker compose restart` |
| Hentikan | `cd /opt/stacks/ntab-bot && docker compose stop` |
| Pemakaian memori dan CPU | `/status` di chat bot atau `docker stats --no-stream ntab-bot` |

**Backup.** Database dikirim otomatis ke chat owner setiap 24 jam (jadwalnya tidak kacau oleh restart). Backup manual: `/backup`.

**Memulihkan.** Hentikan container, ganti `/opt/stacks/ntab-bot/data/bot.db` dengan berkas backup, hapus `bot.db-wal` dan `bot.db-shm` bila ada, pastikan pemiliknya UID 1000, lalu jalankan lagi.

**Perawatan otomatis.** Setiap hari bot membuang kuota lama dan cache `file_id` berumur lebih dari 180 hari. Folder sementara dibersihkan setiap selesai dipakai dan saat bot menyala.

---

## Arsitektur

```text
src/
├── main.ts                  Urutan nyala: konfigurasi, modul, bot, runner, mati dengan rapi
├── core/                    INTI: alat, tanpa fitur
│   ├── config.ts            Satu-satunya pembaca .env
│   ├── plans.ts             Batas paket gratis dan VIP
│   ├── bot.ts               Middleware dasar + router
│   ├── engine/
│   │   ├── types.ts         Kontrak BotModule
│   │   ├── registry.ts      Pemuat modul, indeks perintah/tombol/prefix
│   │   ├── router.ts        Meneruskan update ke modul setelah cek izin
│   │   └── gate.ts          Izin: paket, on/off, jenis obrolan, admin, NSFW
│   ├── db/
│   │   ├── index.ts         Koneksi SQLite, skema inti, perawatan, snapshot
│   │   └── repo.ts          User, pengaturan, kuota, bookmark, cache file_id, kv
│   ├── tools/
│   │   ├── http.ts          fetch dengan batas waktu/ukuran, unduh ke disk, folder sementara
│   │   ├── limit.ts         Semaphore, Cooldown, mapLimit
│   │   ├── cache.ts         TtlCache
│   │   ├── imageSize.ts     Ukuran gambar dari header berkas, pemotong gambar memanjang
│   │   ├── telegraph.ts     Terbitkan deretan gambar sebagai halaman Telegraph
│   │   ├── media.ts         Kirim album, unduh berkas dari Telegram
│   │   ├── ui.ts            show, reply, toast, progress, addPager, cb
│   │   └── text.ts          htmlEscape, format tanggal/ukuran, isOwner
│   ├── network/             Image proxy bertanda tangan, DNS alternatif
│   └── sdk/
│       ├── defineScraper.ts Pembangun modul pencarian (inline, album, File HD, bookmark)
│       └── mangaReader.ts   Pembaca manga: daftar chapter, halaman, lanjut baca
└── modules/                 FITUR: satu folder = satu modul
    ├── menu/ settings/ bookmarks/ premium/ admin/     modul sistem
    ├── scraper-*/                                     sumber gambar dan manga
    ├── media-tools/ reverse-search/ group-manager/ url-grabber/
    └── _templates/                                    contoh (tidak dimuat)
```

**Alur sebuah update:** Telegram → middleware user → router → cek izin (`gate`) → handler modul. Modul tidak pernah memeriksa paket, jenis obrolan, atau hak admin sendiri; cukup mendeklarasikannya.

**Pengaman beban bawaan**

| Risiko | Penanganan |
|---|---|
| Lonjakan update | Maksimal 8 update diproses bersamaan |
| Album besar memenuhi RAM | Gambar diunduh ke disk, maks 10 MB per gambar, 4 unduhan sekaligus, 2 album sekaligus |
| FFmpeg memonopoli CPU | 1 konversi sekaligus, 1 thread, prioritas rendah, batas 90 detik |
| Permintaan ke situs sumber menggantung | Semua `fetch` punya batas waktu |
| Database membengkak | Penulisan `last_seen` paling sering 1x/menit per user, data lama dibuang harian |
| Spam | Jeda per user untuk album, `/sauce`, dan `/report` |

---

## Membuat modul

Salin salah satu templat, ubah isinya, jalankan ulang bot:

- [`_templates/scraper-module`](src/modules/_templates/scraper-module/index.ts): sumber gambar baru (inline, album, File HD, bookmark otomatis)
- [`_templates/basic-module`](src/modules/_templates/basic-module/index.ts): modul umum

Modul = `src/modules/<nama>/index.ts` yang mengekspor `BotModule` sebagai `default`. Menu, halaman bantuan, daftar perintah Telegram, dan tombol on/off terbentuk otomatis dari isinya.

Pada scraper, rating mengikuti aturan situs sumber, bukan satu standar universal. Contohnya Danbooru memakai `g` (umum), `s` (sensitif), `q` (meragukan/dewasa), dan `e` (eksplisit); sesuaikan tipe serta penanda NSFW jika situs lain memakai kode berbeda.

### Isi `BotModule`

| Bagian | Fungsi |
|---|---|
| `meta` | Identitas: `id`, `name`, `emoji`, `description`, `scope`, `minTier`, `defaultEnabled`. `system: true` = selalu aktif |
| `commands` | Perintah. Tiap perintah punya `description`, `usage`, `aliases`, `scope`, `access`, `listed`, dan `handler(ctx, args)` |
| `inline` | Mode inline: `prefix`, `aliases`, `handler(ctx, query, offset, prefix)` |
| `callbacks` | Tombol: `action` + `handler(ctx, arg)`. Data tombol dibuat dengan `cb(ns, action, arg)` |
| `callbackNs` | Awalan pendek data tombol (batas Telegram 64 byte) |
| `settings` | Pengaturan on/off per user; tampil otomatis di `/settings` |
| `menuButtons` | Tombol di Menu Utama |
| `bookmarks` | Cara modul Bookmark membuka item milik modul ini |
| `help` | Baris catatan di halaman bantuan modul |
| `onMessage` | Dipanggil untuk tiap pesan non-perintah (harus ringan) |
| `setup(composer)` | Daftarkan handler grammY apa pun, mis. pembayaran |
| `onLoad`, `onStart`, `onStop` | Buat tabel, mulai dan hentikan jadwal |

`access` perintah: `"all"` (bawaan), `"group_admin"`, atau `"owner"`. `scope`: `"private"`, `"group"`, atau `"both"`.

### Alat inti

| Impor dari | Alat | Kegunaan |
|---|---|---|
| `core/tools/ui` | `reply`, `show`, `toast`, `progress`, `addPager`, `cb` | Kirim/edit pesan, notifikasi tombol, pesan "sedang diproses", tombol halaman |
| `core/tools/http` | `fetchJson`, `fetchText`, `downloadToFile`, `withTempDir` | HTTP dengan batas waktu dan ukuran; folder sementara yang pasti terhapus |
| `core/tools/media` | `sendAlbum`, `albumJobs`, `downloadTelegramFile` | Album dengan cache `file_id`; unduh berkas kiriman pengguna |
| `core/tools/limit` | `Semaphore`, `Cooldown`, `mapLimit` | Batasi pekerjaan berat dan spam |
| `core/tools/cache` | `TtlCache` | Cache memori berbatas waktu dan jumlah |
| `core/tools/tags` | `isMinorContent`, `isMinorQuery`, `exclusionFilter` | Blokir bawaan konten anak di bawah umur; rumus `/exclude` |
| `core/tools/imageSize` | `probeImageSize`, `sliceTallImage` | Ukuran gambar dari 64 KB pertama; pecah gambar memanjang jadi URL potongan |
| `core/tools/telegraph` | `publishTelegraphAlbum` | Deretan URL gambar menjadi halaman Telegraph (otomatis dipecah bila terlalu panjang) |
| `core/tools/text` | `htmlEscape`, `truncate`, `formatDate`, `formatBytes`, `isOwner` | Teks aman dan format |
| `core/engine/gate` | `nsfwAllowed`, `isGroupAdmin`, `moduleStatus` | Keputusan izin |
| `core/engine/registry` | `registry` | Daftar semua modul |
| `core/network/proxy` | `proxied(url)` | Lewatkan gambar ke image proxy (bila aktif) |
| `core/db` | `getDatabase()` | SQLite mentah untuk tabel milik modul |
| `ctx.db` | `getUserSetting`, `quotaLeft`, `useQuota`, `getFileId`, `setFileId`, `addBookmark`, `getValue`, `setValue` | Data inti |
| `ctx.user` | `id`, `first_name`, `tier`, `premium_until` | Pengguna saat ini |

### Aturan penulisan

1. Teks dari pengguna atau situs sumber **wajib** lewat `htmlEscape` sebelum masuk pesan HTML.
2. Pakai `fetchJson`/`downloadToFile`, bukan `fetch` polos (tanpa batas waktu, permintaan bisa menggantung).
3. Pekerjaan berat (unduh banyak berkas, konversi) wajib lewat `Semaphore`.
4. Baca konfigurasi dari `config`, bukan `process.env`.
5. Tabel milik modul dibuat di `onLoad` dengan `CREATE TABLE IF NOT EXISTS`.
6. Mode inline: paling banyak 50 hasil per jawaban dan caption 1024 huruf (batas Telegram). SDK memotong di 50; `npm run smoke` menolak yang melanggar.
7. Tag situs sumber diisi ke `ScraperItem.tags` (bukan ditulis ke `info`), agar tampil seragam dan `/exclude` bekerja.
8. Setelah mengubah modul: `npm run typecheck`, lalu `npm run smoke`.

---

## Pemecahan masalah

| Gejala | Penyebab dan solusi |
|---|---|
| Bot tidak merespons, log berisi `409 Conflict` | Token yang sama sedang dipakai proses lain. Hentikan salah satunya |
| `BOT_TOKEN belum diisi` | `.env` belum ada atau tidak berada di folder stack |
| Tombol **File HD** memunculkan "tekan Start dulu" | Pengguna belum pernah membuka chat pribadi dengan bot |
| Mode inline tidak muncul | Aktifkan *Inline Mode* di @BotFather (`/setinline`) |
| Bot tidak membaca pesan di grup | Perintah `/...` selalu terbaca. Untuk perintah titik (`.wh`) dan arsip tautan, matikan *Group Privacy* di @BotFather atau jadikan bot admin |
| `/mp3`, `/gif` membalas "FFmpeg belum terpasang" | Pastikan image Docker dibangun ulang dengan `docker compose up -d --build` |
| Pencarian selalu kosong saat dijalankan lokal | ISP memblokir situs sumber. Setel `ENABLE_CUSTOM_DNS=true` |
| Thumbnail Gelbooru kosong di inline | Butuh image proxy (lihat Konfigurasi) |
| `.px` atau `.gb` tidak menampilkan apa pun | Cari `inline gagal` di log. Penyebab umum: situs sumber menolak, atau hasil melanggar batas Telegram |
| Sebuah modul hilang dari menu | Modul gagal dimuat. Cari `gagal dimuat` di log; modul lain tetap jalan |
| Bot sering restart | Cek `docker compose logs`. Bila karena batas memori, turunkan `MAX_ALBUM_JOBS` |
