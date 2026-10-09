#!/usr/bin/env bash
# Einrichtung des Pi (Veranstaltungstechnik-Server) in einem Rutsch:
#   * X32-Relay in Docker
#   * WireGuard-VPN zum Heimserver (nur das Tunnelnetz wird geroutet, DNS bleibt unveraendert)
#   * Automatik: zu Hause VPN aus, woanders an; virtuelle Adresse fuer das X32 (z. B. 10.8.0.200), damit du es von zu Hause erreichst
#   sudo ./install.sh /pfad/zu/pi.conf        (pi.conf aus scripts/vpn-peer.sh vom Heimserver, oder von der Fritz!Box)
# Optionen per Umgebungsvariable: X32_HOST  SERVER_LAN_IP  VIRTUAL_X32_IP  EXTRA_DEVICES  P1_CHANNELS  P2_CHANNELS  MIC_CHANNELS
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
CONF_SRC="${1:-}"
[ -f "$CONF_SRC" ] || { echo "Aufruf: sudo ./install.sh /pfad/zu/pi.conf"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-pi}"

# Sicherung: dieses Skript gehoert NUR auf den Pi, nie auf den Heimserver mit der App.
if [ -f "$HERE/../docker-compose.npm.yml" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qiE 'nginx|npm|app-1|wg-1|schulhauspartry'; then
  echo "ABBRUCH: Auf diesem Rechner laeuft die App (oder der Nginx Proxy Manager) in Docker. Dieses Skript ist nur fuer den Pi."; exit 1
fi
echo "Dieses Skript richtet Docker, WireGuard, Firewall und einen Autostart auf diesem Geraet ein: $(hostname)"
read -r -p "Ist das der Pi (Veranstaltungs-Server)? (ja/nein) " A </dev/tty
[ "$A" = "ja" ] || { echo "Abgebrochen."; exit 1; }
ask() { local var="$1" prompt="$2" def="$3"; if [ -z "${!var:-}" ]; then read -r -p "$prompt [$def]: " v </dev/tty; export "$var"="${v:-$def}"; fi; }

echo "==> Pakete installieren"
apt-get update -y
apt-get install -y wireguard wireguard-tools iptables ufw curl openssl iputils-ping
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
usermod -aG docker "$RUN_USER" || true
# Reste frueherer Versionen aufraeumen
systemctl disable --now wg-quick@wg0 wg-watchdog.timer >/dev/null 2>&1 || true
rm -f /etc/systemd/system/wg-watchdog.service /etc/systemd/system/wg-watchdog.timer; rm -rf /etc/systemd/system/wg-quick@wg0.service.d
( cd "$HERE" && docker compose --profile lan --profile vpn down --remove-orphans >/dev/null 2>&1 ) || true
ip link delete wg0 >/dev/null 2>&1 || true

echo "==> WireGuard-Konfiguration"
CONF=/etc/wireguard/wg0.conf
install -d -m 700 /etc/wireguard
cp "$CONF_SRC" "$CONF"
sed -i '/^DNS[[:space:]]*=/d' "$CONF"                                   # DNS des Pi bleibt unberuehrt (keine Namensserver-Aenderungen!)
sed -i '/^PostUp/d;/^PostDown/d' "$CONF"
ADDR="$(sed -n 's|^Address[[:space:]]*=[[:space:]]*\([0-9.]*\).*|\1|p' "$CONF" | head -1)"; ADDR="${ADDR:-10.8.0.2}"
case "$ADDR" in
  10.8.0.*) PEER_NET="10.8.0.0/24"; PING_TARGET="10.8.0.1"; echo "    Konfiguration vom eigenen WireGuard-Server (Tunnel $ADDR)" ;;
  *) echo "    Fritz!Box-Konfiguration erkannt (Tunnel-Adresse $ADDR) – eingeschraenkt: nur der Server ist erreichbar, kein X32 von zu Hause"
     sed -i '/^Address/ { s|/24|/32|g; s|/64|/128|g }' "$CONF"
     ask SERVER_LAN_IP "LAN-IP des Heimservers im Heimnetz" "192.168.178.50"
     PEER_NET="$SERVER_LAN_IP/32"; PING_TARGET="$SERVER_LAN_IP" ;;
esac
sed -i "s|^AllowedIPs[[:space:]]*=.*|AllowedIPs = $PEER_NET|" "$CONF"   # nur das Noetige durch den Tunnel: keine Standardroute, kein DNS
grep -q '^PersistentKeepalive' "$CONF" || sed -i '/^\[Peer\]/a PersistentKeepalive = 25' "$CONF"
chmod 600 "$CONF"

echo "==> Relay und Erkennung 'zu Hause'"
ask X32_HOST "IP-Adresse des X32 im Netz (wird am Veranstaltungsort ggf. in der .env angepasst)" "192.168.1.50"
[ -n "${SERVER_LAN_IP:-}" ] || ask SERVER_LAN_IP "LAN-IP des Heimservers (fuer die Erkennung, leer = nur Router-Erkennung)" ""
# Heimrouter merken: ist der Pi gerade zu Hause, wird die MAC-Adresse des Routers als "Heim" gespeichert
PHYS_IF="$(ip -4 route show default | awk '{for(i=1;i<NF;i++) if($i=="dev") print $(i+1)}' | head -1)"
GW="$(ip -4 route show default | awk '{print $3; exit}')"; ping -c 1 -W 1 "$GW" >/dev/null 2>&1 || true
GW_MAC="$(ip neigh show "$GW" dev "$PHYS_IF" 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="lladdr") print tolower($(i+1))}' | head -1)"
HOME_GW_MAC=""
if [ -n "$GW_MAC" ]; then
  read -r -p "Ist der Pi gerade ZU HAUSE (Router $GW, $GW_MAC ist dein Heimrouter)? (ja/nein) " H </dev/tty
  [ "$H" = "ja" ] && HOME_GW_MAC="$GW_MAC"
fi
[ -n "$HOME_GW_MAC" ] || [ -n "${SERVER_LAN_IP:-}" ] || echo "    HINWEIS: ohne Router-MAC und ohne Server-IP gilt der Pi immer als 'unterwegs' (VPN immer an)."
TOKEN="$(openssl rand -hex 24)"
if [ -f "$HERE/.env" ] && grep -q '^RELAY_TOKEN=' "$HERE/.env"; then TOKEN="$(sed -n 's/^RELAY_TOKEN=//p' "$HERE/.env")"; echo "    vorhandener Token wird behalten"; fi
[ -f "$HERE/.env" ] && [ -z "$HOME_GW_MAC" ] && HOME_GW_MAC="$(sed -n 's/^HOME_GW_MAC=//p' "$HERE/.env")"
cat > "$HERE/.env" <<ENV
X32_HOST=$X32_HOST
X32_PORT=10023
RELAY_TOKEN=$TOKEN
PORT=8080
P1_CHANNELS=${P1_CHANNELS:-1,2}
P2_CHANNELS=${P2_CHANNELS:-3,4}
MIC_CHANNELS=${MIC_CHANNELS:-5,6,7}
SERVER_LAN_IP=${SERVER_LAN_IP:-}
HOME_GW_MAC=$HOME_GW_MAC
PING_TARGET=$PING_TARGET
# Virtuelle Adresse des X32 im Tunnel (vom Heimnetz aus erreichbar). Weitere Geraete: EXTRA_DEVICES=10.8.0.201=192.168.1.20,...
VIRTUAL_X32_IP=${VIRTUAL_X32_IP:-10.8.0.200}
EXTRA_DEVICES=${EXTRA_DEVICES:-}
ENV
chmod 600 "$HERE/.env"; chown "$RUN_USER" "$HERE/.env" 2>/dev/null || true
chmod +x "$HERE/autonet.sh"
( cd "$HERE" && docker compose up -d --build )

echo "==> Autostart (Netz-Pruefung beim Start und alle 30 s)"
cat > /etc/systemd/system/x32-relay-net.service <<UNIT
[Unit]
Description=Pi: VPN automatisch (zu Hause aus, woanders an) und X32-Umleitung
After=docker.service network-online.target
Wants=network-online.target
[Service]
Type=oneshot
WorkingDirectory=$HERE
ExecStart=$HERE/autonet.sh
UNIT
cat > /etc/systemd/system/x32-relay-net.timer <<'UNIT'
[Unit]
Description=Pi: Netz-Pruefung
[Timer]
OnBootSec=15s
OnUnitActiveSec=30s
AccuracySec=1s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now x32-relay-net.timer

echo "==> Firewall"
ufw default deny incoming; ufw default allow outgoing
ufw allow in on tailscale0 2>/dev/null || true
ufw allow in on wg0                               # alles aus dem Tunnel (Server/PC): SSH, Companion, n8n, Relay ...
ufw allow 22/tcp                                  # SSH im lokalen Netz (bei Bedarf auf dein LAN beschraenken)
ufw route allow in on wg0 >/dev/null 2>&1 || true
ufw --force enable

echo "==> Erster Lauf der Automatik"
AUTONET_FIRST=1 "$HERE/autonet.sh" || true
sleep 3
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')"
STATE="zu Hause (VPN aus)"; ip link show wg0 >/dev/null 2>&1 && STATE="unterwegs (VPN an)"
echo "    Aktueller Modus: $STATE"
echo
echo "================ Fertig – in der App eintragen (Admin → Verbindungen → X32 / Pi 5) ================"
echo "  Anbindung : Pi 5 / X32 über HTTP-Relay"
echo "  Pi-URL(s) : http://$LAN_IP:8080, http://$ADDR:8080      (zuerst LAN, dann VPN – die App nimmt, was antwortet)"
echo "  Token     : $TOKEN"
echo "  Von zu Hause aus (per VPN) erreichbar: Pi = $ADDR, X32 = ${VIRTUAL_X32_IP:-10.8.0.200}"
echo "  Tipp      : dem Pi im Router einen festen Namen/IP geben; zu Hause erreichst du ihn auch als $(hostname).local bzw. $(hostname).fritz.box"
echo "======================================================================================"
