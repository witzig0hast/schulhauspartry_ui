#!/usr/bin/env bash
# Auf dem HEIMSERVER ausfuehren (im App-Ordner): holt die fertige WireGuard-Konfiguration fuer den Pi
# und legt sie als pi.conf ab. Danach: scp pi.conf pi@<pi-adresse>:~/   (oder per USB-Stick)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-pi.conf}"
if ! docker compose ps --services 2>/dev/null | grep -qx wg; then
  echo "Der VPN-Container 'wg' laeuft nicht. Starte zuerst mit:"
  echo "  docker compose -f docker-compose.yml -f docker-compose.npm.yml -f docker-compose.vpn.yml up -d"
  echo "und setze in der .env:  WG_SERVERURL=wg.deine-domain.de"
  exit 1
fi
# der Container braucht beim ersten Start einen Moment, bis die Peer-Datei existiert
for _ in $(seq 1 20); do
  if docker compose exec -T wg test -f /config/peer_pi/peer_pi.conf 2>/dev/null; then break; fi
  sleep 2
done
docker compose exec -T wg cat /config/peer_pi/peer_pi.conf > "$OUT"
chmod 600 "$OUT"
echo "Gespeichert: $OUT  (enthaelt den privaten Schluessel des Pi – nicht weitergeben!)"
grep -E '^Endpoint' "$OUT" || true
echo
echo "Auf den Pi kopieren und dort installieren:"
echo "  scp $OUT pi@<pi-adresse>:~/pi.conf"
echo "  ssh pi@<pi-adresse>   ->   cd schulhauspartry_ui/pi-relay && sudo ./install.sh ~/pi.conf"
