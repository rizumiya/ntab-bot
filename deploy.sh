#!/usr/bin/env bash
# Kirim kode ke VPS, build di sana, restart bot, lalu pastikan semuanya sehat.
# Panduan lengkap: DEPLOY.md
#
#   ./deploy.sh user@host [kunci-ssh]             kirim versi terbaru
#   ./deploy.sh user@host [kunci-ssh] rollback    kembalikan versi sebelum deploy terakhir
#   ./deploy.sh user@host [kunci-ssh] status      lihat keadaan tanpa mengubah apa pun
#
# Yang disentuh HANYA /opt/ntab-bot dan service ntab-bot.
# Tidak memakai Docker, tidak memasang paket sistem, tidak mengubah firewall, nginx, atau layanan lain.
set -euo pipefail

TARGET="${1:?Pemakaian: ./deploy.sh user@host [kunci-ssh] [rollback|status]}"
KEY="${2:-}"
ACTION="${3:-deploy}"
# Argumen kedua boleh langsung berupa aksi bila kunci SSH bawaan dipakai
if [ "$KEY" = "rollback" ] || [ "$KEY" = "status" ]; then ACTION="$KEY"; KEY=""; fi

APP_DIR="/opt/ntab-bot"
SERVICE="ntab-bot"
# Layanan lain di server yang sama. Skrip tidak menyentuhnya; ia hanya memastikan keadaannya tidak berubah.
NEIGHBORS="${NEIGHBORS:-face-api snoba-face nginx mysql wa-bot n8n}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 ${KEY:+-i "$KEY"} "$TARGET")

as_bot() { "${SSH[@]}" "sudo -u ntab env HOME=$APP_DIR sh -c 'cd $APP_DIR && $1'"; }
neighbors() { "${SSH[@]}" "for s in $NEIGHBORS; do printf '%s=%s ' \$s \$(systemctl is-active \$s 2>/dev/null || true); done"; }

# Tunggu sampai log bot memuat baris "aktif" sejak restart terakhir. Gagal = tampilkan log lalu keluar.
wait_until_active() {
  "${SSH[@]}" "
    since=\$(systemctl show $SERVICE -p ActiveEnterTimestamp --value)
    for i in \$(seq 1 20); do
      if sudo journalctl -u $SERVICE --since \"\$since\" --no-pager -o cat | grep -q '\\[Bot\\] @.* aktif'; then
        echo \"   bot aktif setelah \${i} detik\"; exit 0
      fi
      sleep 1
    done
    echo '   BOT TIDAK MENCAPAI \"aktif\" DALAM 20 DETIK. Log terakhir:'
    sudo journalctl -u $SERVICE --since \"\$since\" --no-pager -o cat | tail -15
    exit 1
  "
}

show_status() {
  "${SSH[@]}" "
    echo \"   service : \$(systemctl is-active $SERVICE), restart otomatis: \$(systemctl show $SERVICE -p NRestarts --value)x\"
    echo \"   memori  : \$(( \$(systemctl show $SERVICE -p MemoryCurrent --value) / 1048576 )) MB (batas \$(( \$(systemctl show $SERVICE -p MemoryMax --value) / 1048576 )) MB)\"
    echo \"   error 10 menit terakhir: \$(sudo journalctl -u $SERVICE --since '-10min' --no-pager -o cat | grep -ci 'gagal\\|error' || true) baris\"
  "
  echo "   tetangga: $(neighbors)"
}

if [ "$ACTION" = "status" ]; then
  echo "== Keadaan saat ini"
  show_status
  exit 0
fi

echo "== Layanan lain sebelum mulai"
BEFORE="$(neighbors)"
echo "   $BEFORE"

if [ "$ACTION" = "rollback" ]; then
  echo "== Mengembalikan versi sebelumnya"
  as_bot "test -d dist.prev || { echo \"Tidak ada versi sebelumnya (dist.prev).\"; exit 1; }; rm -rf dist.gagal && mv dist dist.gagal && cp -r dist.prev dist"
else
  echo "== Periksa tipe dan jalankan uji sebelum mengirim"
  npm run -s typecheck
  npm run -s smoke | tail -1

  echo "== Kirim kode (tanpa node_modules, dist, data, dan .env)"
  tar czf - package.json package-lock.json tsconfig.json src deploy \
    | "${SSH[@]}" "sudo -u ntab sh -c 'cd $APP_DIR && rm -rf src deploy && tar xzf - --no-same-owner'"

  echo "== Build di server (prioritas rendah; versi lama disimpan sebagai dist.prev)"
  as_bot "nice -n 15 npm ci --no-audit --no-fund --silent && rm -rf dist.new && nice -n 15 npx tsc --outDir dist.new && rm -rf dist.prev && { [ -d dist ] && mv dist dist.prev || true; } && mv dist.new dist && npm prune --omit=dev --no-audit --no-fund --silent"

  if ! "${SSH[@]}" "sudo cmp -s $APP_DIR/deploy/$SERVICE.service /etc/systemd/system/$SERVICE.service"; then
    echo "   CATATAN: deploy/$SERVICE.service berbeda dari yang terpasang. Bila perubahan itu disengaja, pasang dengan:"
    echo "   sudo cp $APP_DIR/deploy/$SERVICE.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl restart $SERVICE"
  fi
fi

echo "== Restart bot"
"${SSH[@]}" "sudo systemctl restart $SERVICE"
if ! wait_until_active; then
  echo
  echo "!! Bot gagal menyala. Versi sebelumnya masih tersimpan; kembalikan dengan:"
  echo "   ./deploy.sh $TARGET ${KEY:+$KEY }rollback"
  exit 1
fi

echo "== Pemeriksaan akhir"
show_status
AFTER="$(neighbors)"
if [ "$BEFORE" != "$AFTER" ]; then
  echo
  echo "!! KEADAAN LAYANAN LAIN BERUBAH. Sebelum: $BEFORE"
  echo "!!                               Sesudah: $AFTER"
  echo "!! Skrip ini tidak menyentuh layanan tersebut; periksa segera (systemctl status <nama>)."
  exit 1
fi
echo "   layanan lain tidak berubah."
echo "== Selesai"
