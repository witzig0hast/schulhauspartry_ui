#!/usr/bin/env bash
# Auf dem HEIMSERVER ausfuehren (im App-Ordner): holt die fertige WireGuard-Konfiguration fuer den Pi
# und legt sie als pi.conf ab. Danach: scp pi.conf pi@<pi-adresse>:~/   (oder per USB-Stick)
set -euo pipefail
cd "$(dirname "$0")/.."
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
for peer in pi pc; do
  for _ in $(seq 1 20); do docker compose exec -T wg test -f "/config/peer_$peer/peer_$peer.conf" 2>/dev/null && break; sleep 2; done
  docker compose exec -T wg cat "/config/peer_$peer/peer_$peer.conf" > "$peer.conf"
  chmod 600 "$peer.conf"
done
echo "Gespeichert: pi.conf (fuer den Pi) und pc.conf (fuer deinen Rechner: in die WireGuard-App importieren)."
echo "Beide enthalten private Schluessel - nicht weitergeben, nach der Einrichtung loeschen."
grep -E '^Endpoint' pi.conf || true
echo
echo "Auf den Pi kopieren und dort installieren:"
echo "  scp pi.conf pi@<pi-adresse>:~/pi.conf"
echo "  ssh pi@<pi-adresse>   ->   cd schulhauspartry_ui/pi-relay && sudo ./install.sh ~/pi.conf"
echo
echo "Kontrolle auf dem Server: docker compose exec wg wg show   (beim Peer pi muessen 10.8.0.2/32 und 10.8.0.192/26 stehen)"
