# Mengunggah ke VPS dengan aman

Panduan ini untuk VPS yang juga menjalankan layanan lain (FaceID, nginx, MySQL, wa-bot, n8n). Tujuannya: memperbarui bot **tanpa menyentuh apa pun di luar bot**.

- [Ringkasnya](#ringkasnya)
- [Kenapa cara ini aman](#kenapa-cara-ini-aman)
- [Sebelum mengunggah](#sebelum-mengunggah)
- [Mengunggah](#mengunggah)
- [Sesudah mengunggah](#sesudah-mengunggah)
- [Kalau ada yang salah](#kalau-ada-yang-salah)
- [Mengubah pengaturan (.env)](#mengubah-pengaturan-env)
- [Yang tidak boleh dilakukan](#yang-tidak-boleh-dilakukan)
- [Pemasangan pertama di server baru](#pemasangan-pertama-di-server-baru)
- [Memindahkan data dari server lama](#memindahkan-data-dari-server-lama)

---

## Ringkasnya

Dari folder proyek, di Git Bash:

```bash
./deploy.sh user@alamat-server ~/.ssh/kunci
```

Skrip berhenti sendiri bila ada yang tidak beres, dan baris terakhirnya harus `== Selesai`. Kalau bukan itu, lihat [Kalau ada yang salah](#kalau-ada-yang-salah).

---

## Kenapa cara ini aman

Skrip `deploy.sh` hanya menyentuh dua hal: folder `/opt/ntab-bot` dan service `ntab-bot`.

| Yang dilakukan skrip | Yang TIDAK dilakukan skrip |
|---|---|
| Mengirim `src/`, `deploy/`, `package.json`, `package-lock.json`, `tsconfig.json` | Memakai Docker |
| Memasang pustaka Node **di dalam** `/opt/ntab-bot/node_modules` | Memasang paket sistem (`apt`) |
| Build dengan prioritas rendah (`nice`), supaya CPU tetap untuk layanan lain | Mengubah firewall (`ufw`) atau membuka port |
| Menyimpan build lama sebagai `dist.prev` | Mengubah atau me-reload nginx |
| Me-restart **hanya** `ntab-bot` | Menyentuh `.env`, database, atau folder layanan lain |

Pengaman bawaan skrip:

1. **Uji dulu, baru kirim.** Pemeriksaan tipe dan uji otomatis dijalankan di komputer Anda. Bila gagal, tidak ada yang terkirim.
2. **Layanan lain dicatat sebelum dan sesudah.** Bila keadaan `face-api`, `snoba-face`, `nginx`, `mysql`, `wa-bot`, atau `n8n` berubah, skrip berhenti dengan peringatan.
3. **Bot harus benar-benar hidup.** Skrip menunggu baris `[Bot] @... aktif` di log. Sekadar "service active" tidak cukup: bot pernah berstatus active padahal tersangkut saat menyala.
4. **Versi lama disimpan.** Satu perintah mengembalikannya.

Bot juga dibatasi oleh systemd ([`deploy/ntab-bot.service`](deploy/ntab-bot.service)): memori maksimal 512 MB, CPU 80% dari satu core, prioritas rendah. Kalau bot bermasalah, yang terdampak hanya bot.

---

## Sebelum mengunggah

**1. Jangan ada bot lokal yang menyala.** Token yang sama tidak boleh dipakai dua proses; keduanya akan saling memutus (error 409). Hentikan `npm run dev` bila sedang jalan.

**2. Lihat keadaan server** (tidak mengubah apa pun):

```bash
./deploy.sh user@alamat-server ~/.ssh/kunci status
```

Semua layanan harus `active`. Bila ada yang sudah bermasalah sebelum Anda mulai, selesaikan itu dulu; jangan menumpuk perubahan di atas server yang sedang sakit.

**3. (Opsional) Uji lengkap dengan situs sumber sungguhan:**

```bash
npm run smoke -- net
```

Dari jaringan Indonesia, langkah Gelbooru dan e621 akan gagal dengan `fetch failed` karena kedua situs diblokir ISP. Itu wajar; di VPS keduanya terjangkau.

---

## Mengunggah

```bash
./deploy.sh user@alamat-server ~/.ssh/kunci
```

Keluaran yang sehat:

```text
== Layanan lain sebelum mulai
   face-api=active snoba-face=active nginx=active mysql=active wa-bot=active n8n=active
== Periksa tipe dan jalankan uji sebelum mengirim
Semua lulus.
== Kirim kode (tanpa node_modules, dist, data, dan .env)
== Build di server (prioritas rendah; versi lama disimpan sebagai dist.prev)
== Restart bot
   bot aktif setelah 2 detik
== Pemeriksaan akhir
   service : active, restart otomatis: 0x
   memori  : 34 MB (batas 512 MB)
   error 10 menit terakhir: 0 baris
   layanan lain tidak berubah.
== Selesai
```

Bot berhenti melayani sekitar 2 detik saat restart. Pesan yang masuk selama itu tidak hilang; Telegram menyimpannya dan bot memprosesnya begitu hidup lagi.

---

## Sesudah mengunggah

1. Kirim `/start` ke bot, lalu coba satu fitur yang baru Anda ubah.
2. Sebagai owner, kirim `/status` untuk melihat memori dan beban server.
3. Bila ragu, pantau log selama beberapa menit:

```bash
ssh -i ~/.ssh/kunci user@alamat-server "sudo journalctl -u ntab-bot -f"
```

Tekan `Ctrl+C` untuk berhenti memantau (bot tetap jalan).

---

## Kalau ada yang salah

### Kembalikan versi sebelumnya

```bash
./deploy.sh user@alamat-server ~/.ssh/kunci rollback
```

Ini menukar build dengan `dist.prev`, me-restart bot, dan menjalankan pemeriksaan yang sama. Hanya satu versi ke belakang yang disimpan. Build yang gagal dipindah ke `dist.gagal` supaya bisa diperiksa.

### Gejala dan penanganan

| Gejala | Arti | Tindakan |
|---|---|---|
| Berhenti di "Periksa tipe" atau uji | Ada kesalahan di kode | Perbaiki dulu. Belum ada yang terkirim ke server |
| `BOT TIDAK MENCAPAI "aktif"` | Bot tersangkut atau crash saat menyala | Baca log yang ditampilkan skrip, lalu `rollback` |
| Log: `409 Conflict` | Token dipakai proses lain | Hentikan bot lokal |
| Log: `BOT_TOKEN belum diisi` | `.env` di server hilang atau kosong | Lihat [Mengubah pengaturan](#mengubah-pengaturan-env) |
| Log berhenti di `modul dimuat` | Bot tidak bisa menghubungi Telegram | Cek `curl -4 https://api.telegram.org` dari VPS |
| `KEADAAN LAYANAN LAIN BERUBAH` | Sebuah layanan tetangga mati/berubah saat deploy | Skrip tidak menyentuhnya. Periksa: `systemctl status <nama>` |
| `restart otomatis` lebih dari 0 | Bot crash lalu dinyalakan ulang systemd | Lihat log; bila memori, turunkan `MAX_ALBUM_JOBS` |
| Gambar inline kosong, nginx 502 | Bot (proxy gambar) tidak mendengarkan | Pastikan log memuat `[Proxy] Aktif` |

### Menghentikan bot sepenuhnya

Bila bot dicurigai mengganggu server, hentikan dulu, selidiki belakangan:

```bash
ssh -i ~/.ssh/kunci user@alamat-server "sudo systemctl stop ntab-bot"
```

Menyalakannya lagi: ganti `stop` dengan `start`.

---

## Mengubah pengaturan (.env)

`.env` tidak pernah dikirim oleh `deploy.sh`; ia hanya ada di server, bisa dibaca user `ntab` saja.

```bash
ssh -i ~/.ssh/kunci user@alamat-server
```

```bash
sudo -u ntab nano /opt/ntab-bot/.env
```

```bash
sudo systemctl restart ntab-bot && sleep 3 && sudo journalctl -u ntab-bot -n 5 --no-pager
```

Baris terakhir log harus memuat `aktif`.

> **Jangan menyalin `.env` dari Windows dengan salin-tempel berkas.** Akhir baris Windows (`\r`) ikut terbawa dan bisa merusak nilai. Sunting langsung di server seperti di atas.

Mengubah `deploy/ntab-bot.service` (batas memori, CPU): skrip deploy akan memberi tahu bahwa berkas itu berbeda dari yang terpasang, berikut perintah untuk memasangnya. Skrip tidak memasangnya sendiri.

---

## Yang tidak boleh dilakukan

Hal-hal berikut berada di luar bot dan bisa mengganggu layanan lain. Lakukan hanya dengan sengaja dan satu per satu, bukan sebagai bagian dari deploy.

| Jangan | Kenapa |
|---|---|
| Memakai Docker | Docker menulis ulang aturan firewall dan melewati `ufw`; FaceID pernah terputus karena perubahan firewall |
| `sudo ufw ...` atau membuka port | Bot tidak butuh port masuk. Proxy gambarnya hanya mendengarkan di `127.0.0.1` |
| `sudo apt install/upgrade` saat deploy | Paket sistem dipakai bersama; `needrestart` bisa me-restart layanan lain |
| `sudo systemctl reload nginx` tanpa `sudo nginx -t` dulu | Konfigurasi yang salah membuat **semua** situs gagal saat nginx berikutnya restart |
| Menyunting berkas di `/opt` selain `ntab-bot` | Itu milik layanan lain (`snoba-face`, `wa-bot`, `n8n`, `9router`) |
| `sudo chown -R` atau `chmod -R` di luar `/opt/ntab-bot` | Mudah merusak izin layanan lain |
| Menghapus `/opt/ntab-bot/data` | Itu database bot (pengguna, bookmark, VIP) |

Bila suatu saat memang perlu mengubah nginx untuk bot ini (berkasnya `/etc/nginx/sites-available/ntab`):

```bash
sudo cp /etc/nginx/sites-available/ntab /tmp/ntab.cadangan
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Bila `nginx -t` gagal, kembalikan cadangannya **sebelum** melakukan apa pun lagi:

```bash
sudo cp /tmp/ntab.cadangan /etc/nginx/sites-available/ntab && sudo nginx -t
```

---

## Pemasangan pertama di server baru

Hanya perlu sekali. Butuh Node.js 22.13 atau lebih baru.

```bash
sudo useradd --system --home /opt/ntab-bot --shell /usr/sbin/nologin ntab
```

```bash
sudo mkdir -p /opt/ntab-bot/data && sudo chown -R ntab:ntab /opt/ntab-bot && sudo chmod 750 /opt/ntab-bot
```

Buat `.env` (isi mengikuti [`.env.example`](.env.example)), lalu kunci izinnya:

```bash
sudo -u ntab nano /opt/ntab-bot/.env
```

```bash
sudo chmod 600 /opt/ntab-bot/.env
```

Dari komputer Anda, kirim kode. Restart di akhir akan gagal karena service belum terpasang; itu wajar untuk kali pertama:

```bash
./deploy.sh user@alamat-server ~/.ssh/kunci
```

Pasang service, lalu jalankan `deploy.sh` sekali lagi untuk pemeriksaan lengkap:

```bash
sudo cp /opt/ntab-bot/deploy/ntab-bot.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now ntab-bot
```

Di server yang layanannya berbeda, sebutkan sendiri layanan yang ingin dijaga:

```bash
NEIGHBORS="nginx mysql" ./deploy.sh user@alamat-server ~/.ssh/kunci
```

Image proxy (subdomain + nginx) bersifat opsional; contoh konfigurasinya ada di [`deploy/nginx-ntab.conf`](deploy/nginx-ntab.conf) dan penjelasannya di README bagian Konfigurasi.

---

## Memindahkan data dari server lama

Bot sudah dihapus seluruhnya dari VPS lama pada 11 Okt 2026. Salinan terakhirnya ada di komputer ini:

| Berkas | Isi |
|---|---|
| `.backup/vps-2026-10-11/data/bot.db` | Database produksi terakhir (pengguna, bookmark, VIP, cache `file_id`) |
| `.backup/vps-2026-10-11/.env` | Pengaturan produksi terakhir, termasuk token dan kunci |

Setelah [pemasangan pertama](#pemasangan-pertama-di-server-baru) selesai dan **sebelum** bot dinyalakan pertama kali, kirim databasenya:

```bash
scp -i ~/.ssh/kunci .backup/vps-2026-10-11/data/bot.db user@alamat-server:/tmp/bot.db
```

```bash
sudo install -o ntab -g ntab -m 644 /tmp/bot.db /opt/ntab-bot/data/bot.db && rm /tmp/bot.db
```

Isi `.env` di server baru mengikuti salinan lama, dengan tiga penyesuaian:

| Kunci | Yang perlu diubah |
|---|---|
| `PROXY_PUBLIC_URL` | Alamat lama (`ntab.snobadev.com`) sudah tidak ada. Isi subdomain baru, atau kosongkan |
| `ENABLE_IMAGE_PROXY` | `false` bila server baru tidak punya subdomain HTTPS untuk proxy (akibatnya: lihat README bagian Konfigurasi) |
| `ENABLE_CUSTOM_DNS` | Tetap `false` di server |

Cache `file_id` di database tetap berlaku karena token botnya sama. Bookmark Gelbooru dan Pixiv lama menyimpan alamat gambar lewat proxy lama; pratinjaunya kosong sampai item itu di-bookmark ulang.
