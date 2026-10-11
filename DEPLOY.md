# Deploy ke VPS dengan Docker Compose

NTAB Bot dijalankan sebagai satu stack di `/opt/stacks/ntab-bot`, mengikuti pola stack lain di VPS:

- `compose.yml` + `.env` dengan izin `600` + `data/`
- jaringan Docker eksternal `edge`
- `restart: unless-stopped`, batas memori 512 MB, dan CPU 0,8 core
- tidak memublikasikan port ke host atau internet

Deploy hanya membangun dan mengganti container `ntab-bot`. Jangan menjalankan `docker compose down` dari `/opt/stacks` atau mengubah jaringan, firewall, Cloudflare Tunnel, maupun stack lain.

## Persiapan pertama

Pastikan Docker Compose aktif dan jaringan `edge` tersedia:

```bash
ssh rizumiya 'docker compose ls'
ssh rizumiya 'docker network inspect edge --format "{{.Name}}"'
```

Buat folder stack tanpa mengubah folder stack lain:

```bash
ssh rizumiya 'mkdir -p /opt/stacks/ntab-bot/data && chmod 700 /opt/stacks/ntab-bot'
```

Buat `/opt/stacks/ntab-bot/.env` berdasarkan [`.env.example`](.env.example), isi `BOT_TOKEN` dan `OWNER_ID`, lalu kunci izinnya:

```bash
ssh rizumiya 'chmod 600 /opt/stacks/ntab-bot/.env'
```

`data/` adalah bind mount persisten dan container berjalan sebagai UID 1000 (user `ubuntu` pada VPS saat panduan ini ditulis). Folder data dibuat oleh user tersebut; jangan mengubah kepemilikan folder lain.

## Mengirim kode dan menjalankan

Jalankan dari root repo di Git Bash. Perintah ini hanya mengirim file yang tracked di Git; `.env`, database, backup, dan `node_modules` tidak ikut:

```bash
git archive --format=tar HEAD | ssh rizumiya 'tar -xf - -C /opt/stacks/ntab-bot'
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose up -d --build'
```

Periksa hanya stack bot:

```bash
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose ps'
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose logs --tail=50'
```

Log sehat memuat `[Bot] @... aktif`. Pantau tanpa menghentikan layanan:

```bash
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose logs -f'
```

Tekan `Ctrl+C` untuk berhenti melihat log; container tetap berjalan. Tidak ada aturan firewall atau konfigurasi Cloudflare Tunnel yang diubah. Image proxy tetap nonaktif sampai ada konfigurasi domain HTTPS dan route khusus.

## Memindahkan database lama (opsional)

Jika ingin mempertahankan pengguna, VIP, dan bookmark dari snapshot produksi, lakukan **sebelum bot pertama kali dijalankan**. Jangan menimpa database yang sedang dipakai.

Dari root repo:

```bash
scp .backup/vps-2026-10-11/data/bot.db rizumiya:/tmp/ntab-bot.db
ssh rizumiya 'install -o 1000 -g 1000 -m 600 /tmp/ntab-bot.db /opt/stacks/ntab-bot/data/bot.db && rm /tmp/ntab-bot.db'
```

Pastikan file sumber memang tersedia sebelum menjalankan `scp`. Pengaturan rahasia lama tidak disalin otomatis; masukkan nilai yang diperlukan langsung ke `.env` di VPS.

## Memperbarui dan mengembalikan versi

Setelah perubahan sudah di-commit, unggah ulang file tracked lalu bangun hanya stack bot:

```bash
git archive --format=tar HEAD | ssh rizumiya 'tar -xf - -C /opt/stacks/ntab-bot'
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose up -d --build'
```

Untuk kembali ke versi kode sebelumnya, checkout commit yang diinginkan di komputer, kirim arsip commit itu dengan perintah `git archive` yang sama, lalu jalankan `docker compose up -d --build`. Folder `data/` dan `.env` tidak ikut berubah.

## Operasional

```bash
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose ps'
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose logs -f'
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose restart'
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker stats --no-stream ntab-bot'
```

Edit `.env` langsung di VPS, lalu restart hanya container bot:

```bash
ssh rizumiya 'nano /opt/stacks/ntab-bot/.env'
ssh rizumiya 'cd /opt/stacks/ntab-bot && docker compose up -d'
```

Backup database tetap tersedia melalui perintah `/backup` di bot. Data SQLite berada di `/opt/stacks/ntab-bot/data/`.
