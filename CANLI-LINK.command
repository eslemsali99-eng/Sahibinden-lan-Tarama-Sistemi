#!/bin/bash
# Bircan Akın · Canlı Link Başlatıcı — çift tıkla çalıştır
cd "$(dirname "$0")"
echo "================================================="
echo "  BİRCAN AKIN · İLAN TARAMA — CANLI LİNK"
echo "================================================="
# collector açık değilse başlat
if ! curl -s http://localhost:7777/ >/dev/null 2>&1; then
  echo "Toplayıcı başlatılıyor..."
  nohup node collector.js >/tmp/bircan-collector.log 2>&1 &
  sleep 3
fi
PASS=$(node -e "console.log(require('./output/auth.json').password)" 2>/dev/null)
echo ""
echo "  EKİP ŞİFRESİ:  $PASS"
echo ""
echo "  Aşağıda 'https://....trycloudflare.com' linki çıkacak."
echo "  O LİNKİ + ŞİFREYİ ekibe gönder. (Bu pencereyi AÇIK bırak.)"
echo "================================================="
echo ""
./cloudflared tunnel --url http://localhost:7777 --no-autoupdate
