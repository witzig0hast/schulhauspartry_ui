#!/usr/bin/env bash
# Einrichtung des Pi 5 in einem Rutsch:
#   * Relay (X32) in Docker
#   * VPN (WireGuard) NUR in einem Container – das Netzwerk des Pi bleibt unveraendert
#   * Automatik: beim Start (und alle 30 s) prueft der Pi, ob der Server im selben Netz ist -> sonst VPN
#   sudo ./install.sh /pfad/zu/pi.conf        (pi.conf: von der Fritz!Box oder aus scripts/vpn-peer.sh)
# Optionen per Umgebungsvariable: X32_HOST=192.168.1.50  SERVER_LAN_IP=192.168.178.50  P1_CHANNELS=1,2  P2_CHANNELS=3,4  MIC_CHANNELS=5,6,7
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
CONF_SRC="${1:-}"
[ -f "$CONF_SRC" ] || { echo "Aufruf: sudo ./install.sh /pfad/zu/pi.conf"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-pi}"

# Sicherung: dieses Skript gehoert NUR auf den Pi neben dem X32, nie auf den Heimserver mit der App.
if [ -f "$HERE/../docker-compose.npm.yml" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qiE 'nginx|npm|app-1|wg-1|schulhauspartry'; then
  echo "ABBRUCH: Auf diesem Rechner laeuft die App (oder der Nginx Proxy Manager) in Docker."
  echo "Dieses Skript ist nur fuer den Pi am X32."
  exit 1
fi
echo "Dieses Skript richtet Docker, Firewall und einen Autostart auf diesem Geraet ein: $(hostname)"
read -r -p "Ist das der Pi, der neben dem X32 steht? (ja/nein) " A </dev/tty
[ "$A" = "ja" ] || { echo "Abgebrochen."; exit 1; }

ask() { local var="$1" prompt="$2" def="$3"; if [ -z "${!var:-}" ]; then read -r -p "$prompt [$def]: " v </dev/tty; export "$var"="${v:-$def}"; fi; }

echo "==> Pakete installieren"
apt-get update -y
apt-get install -y ufw curl openssl iputils-ping
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
usermod -aG docker "$RUN_USER" || true

# Reste einer frueheren Installation mit VPN auf dem Pi selbst entfernen (jetzt laeuft das VPN nur im Container)
systemctl disable --now wg-quick@wg0 wg-watchdog.timer >/dev/null 2>&1 || true
rm -f /etc/systemd/system/wg-watchdog.service /etc/systemd/system/wg-watchdog.timer
rm -rf /etc/systemd/system/wg-quick@wg0.service.d
ip link delete wg0 >/dev/null 2>&1 || true

echo "==> VPN-Konfiguration fuer den Container vorbereiten"
install -d -m 700 "$HERE/wg"
CONF="$HERE/wg/wg0.conf"
cp "$CONF_SRC" "$CONF"
sed -i '/^DNS[[:space:]]*=/d' "$CONF"                                   # DNS des Pi bleibt unberuehrt
ADDR="$(sed -n 's|^Address[[:space:]]*=[[:space:]]*\([0-9.]*\).*|\1|p' "$CONF" | head -1)"
ADDR="${ADDR:-10.8.0.2}"
case "$ADDR" in
  10.8.0.*) PEER_NET="10.8.0.0/24"; echo "    Konfiguration vom eigenen WireGuard-Container (Tunnel $ADDR)" ;;
  *) echo "    Fritz!Box-Konfiguration erkannt (Tunnel-Adresse $ADDR)"
     sed -i '/^Address/ { s|/24|/32|g; s|/64|/128|g }' "$CONF"
     ask SERVER_LAN_IP "LAN-IP des Heimservers (Rechner mit der App) im Heimnetz" "192.168.178.50"
     PEER_NET="$SERVER_LAN_IP/32" ;;
esac
sed -i "s|^AllowedIPs[[:space:]]*=.*|AllowedIPs = $PEER_NET|" "$CONF"   # nur das Noetige durch den Tunnel
grep -q '^PersistentKeepalive' "$CONF" || sed -i '/^\[Peer\]/a PersistentKeepalive = 25' "$CONF"
chmod 600 "$CONF"

echo "==> Relay einrichten"
ask X32_HOST "IP-Adresse des X32" "192.168.1.50"
[ -n "${SERVER_LAN_IP:-}" ] || ask SERVER_LAN_IP "LAN-IP des Heimservers (leer lassen = immer VPN)" ""
TOKEN="$(openssl rand -hex 24)"
if [ -f "$HERE/.env" ] && grep -q '^RELAY_TOKEN=' "$HERE/.env"; then TOKEN="$(sed -n 's/^RELAY_TOKEN=//p' "$HERE/.env")"; echo "    vorhandener Token wird behalten"; fi
cat > "$HERE/.env" <<ENV
X32_HOST=$X32_HOST
X32_PORT=10023
RELAY_TOKEN=$TOKEN
PORT=8080
P1_CHANNELS=${P1_CHANNELS:-1,2}
P2_CHANNELS=${P2_CHANNELS:-3,4}
MIC_CHANNELS=${MIC_CHANNELS:-5,6,7}
SERVER_LAN_IP=${SERVER_LAN_IP:-}
ENV
chmod 600 "$HERE/.env"
chown -R "$RUN_USER" "$HERE/.env" 2>/dev/null || true
chmod +x "$HERE/autonet.sh"

echo "==> Autostart: Netz-Pruefung beim Start und alle 30 Sekunden"
cat > /etc/systemd/system/x32-relay-net.service <<UNIT
[Unit]
Description=X32-Relay: LAN oder VPN automatisch waehlen
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
WorkingDirectory=$HERE
ExecStart=$HERE/autonet.sh
UNIT
cat > /etc/systemd/system/x32-relay-net.timer <<'UNIT'
[Unit]
Description=X32-Relay Netz-Pruefung
[Timer]
OnBootSec=20s
OnUnitActiveSec=30s
AccuracySec=1s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now x32-relay-net.timer

echo "==> Firewall (nur SSH; 8080 wird je nach Modus automatisch fuers Heimnetz freigegeben)"
ufw default deny incoming; ufw default allow outgoing
ufw allow in on tailscale0 2>/dev/null || true
ufw allow 22/tcp                                  # SSH (bei Bedarf auf dein LAN beschraenken)
ufw --force enable

echo "==> Erster Lauf der Automatik"
"$HERE/autonet.sh" || true; sleep 2; "$HERE/autonet.sh" || true
sleep 3
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')"
MODE="?"
( cd "$HERE" && docker compose ps --services --status running 2>/dev/null | grep -q relay-lan ) && MODE="LAN (ohne VPN)"
( cd "$HERE" && docker compose ps --services --status running 2>/dev/null | grep -q relay-vpn ) && MODE="VPN (nur im Container)"
echo "    Aktueller Modus: $MODE"
echo
echo "================ Fertig – in der App eintragen (Admin → Verbindungen → X32 / Pi 5) ================"
echo "  Anbindung : Pi 5 / X32 über HTTP-Relay"
echo "  Pi-URL(s) : http://$LAN_IP:8080, http://$ADDR:8080      (zuerst LAN, dann VPN – die App nimmt, was antwortet)"
echo "  Token     : $TOKEN"
echo "  Tipp      : dem Pi im Router eine feste IP geben (DHCP-Reservierung), sonst aendert sich die LAN-URL."
echo "======================================================================================"
