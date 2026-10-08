#!/usr/bin/env bash
# Einrichtung des Pi 5 in einem Rutsch: WireGuard-Tunnel + X32-Relay + Firewall.
#   sudo ./install.sh /pfad/zu/pi.conf            (pi.conf kommt vom Server: scripts/vpn-peer.sh)
# Optionen per Umgebungsvariable: X32_HOST=192.168.1.50  P1_CHANNELS=1,2  P2_CHANNELS=3,4  MIC_CHANNELS=5,6,7
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
CONF_SRC="${1:-}"
[ -f "$CONF_SRC" ] || { echo "Aufruf: sudo ./install.sh /pfad/zu/pi.conf"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-pi}"

ask() { local var="$1" prompt="$2" def="$3"; if [ -z "${!var:-}" ]; then read -r -p "$prompt [$def]: " v </dev/tty; export "$var"="${v:-$def}"; fi; }

echo "==> Pakete installieren"
apt-get update -y
apt-get install -y wireguard wireguard-tools ufw curl openssl
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
usermod -aG docker "$RUN_USER" || true

echo "==> WireGuard-Konfiguration vorbereiten"
install -d -m 700 /etc/wireguard
cp "$CONF_SRC" /etc/wireguard/wg0.conf
# DNS des Pi nicht anfassen, nur das Tunnelnetz routen, Verbindung offen halten
sed -i '/^DNS[[:space:]]*=/d' /etc/wireguard/wg0.conf
sed -i 's|^AllowedIPs[[:space:]]*=.*|AllowedIPs = 10.8.0.0/24|' /etc/wireguard/wg0.conf
grep -q '^PersistentKeepalive' /etc/wireguard/wg0.conf || sed -i '/^\[Peer\]/a PersistentKeepalive = 25' /etc/wireguard/wg0.conf
chmod 600 /etc/wireguard/wg0.conf
systemctl enable --now wg-quick@wg0
# Tunnel automatisch neu aufbauen, falls er mal haengt (z. B. nach Netzwerkwechsel)
install -d /etc/systemd/system/wg-quick@wg0.service.d
cat > /etc/systemd/system/wg-quick@wg0.service.d/restart.conf <<'UNIT'
[Service]
Restart=on-failure
RestartSec=10
UNIT
cat > /etc/systemd/system/wg-watchdog.service <<'UNIT'
[Unit]
Description=WireGuard-Watchdog (Tunnel neu starten, wenn der Server nicht antwortet)
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'ping -c 2 -W 3 10.8.0.1 >/dev/null 2>&1 || systemctl restart wg-quick@wg0'
UNIT
cat > /etc/systemd/system/wg-watchdog.timer <<'UNIT'
[Unit]
Description=WireGuard-Watchdog alle 2 Minuten
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now wg-watchdog.timer

TUNNEL_IP="$(sed -n 's|^Address[[:space:]]*=[[:space:]]*\([0-9.]*\).*|\1|p' /etc/wireguard/wg0.conf | head -1)"
TUNNEL_IP="${TUNNEL_IP:-10.8.0.2}"
echo "==> Tunnel pruefen (Pi hat $TUNNEL_IP)"
for _ in $(seq 1 10); do ping -c 1 -W 2 10.8.0.1 >/dev/null 2>&1 && OK=1 && break || sleep 2; done
if [ "${OK:-0}" = 1 ]; then echo "    Tunnel steht (Server 10.8.0.1 antwortet)."; else
  echo "    WARNUNG: Server 10.8.0.1 antwortet nicht. Pruefe 'sudo wg show' (Handshake?), UDP 51820 am Router, WG_SERVERURL."; fi

echo "==> Relay einrichten"
ask X32_HOST "IP-Adresse des X32" "192.168.1.50"
TOKEN="$(openssl rand -hex 24)"
if [ -f "$HERE/.env" ] && grep -q '^RELAY_TOKEN=' "$HERE/.env"; then TOKEN="$(sed -n 's/^RELAY_TOKEN=//p' "$HERE/.env")"; echo "    vorhandener Token wird behalten"; fi
cat > "$HERE/.env" <<ENV
X32_HOST=$X32_HOST
X32_PORT=10023
RELAY_TOKEN=$TOKEN
BIND=$TUNNEL_IP
PORT=8080
P1_CHANNELS=${P1_CHANNELS:-1,2}
P2_CHANNELS=${P2_CHANNELS:-3,4}
MIC_CHANNELS=${MIC_CHANNELS:-5,6,7}
ENV
chmod 600 "$HERE/.env"
chown "$RUN_USER" "$HERE/.env" 2>/dev/null || true
( cd "$HERE" && docker compose up -d --build )

echo "==> Firewall (nur SSH aus dem LAN, Relay nur im Tunnel)"
ufw --force reset >/dev/null
ufw default deny incoming; ufw default allow outgoing
ufw allow 22/tcp                                  # SSH (bei Bedarf auf dein LAN beschraenken: ufw allow from 192.168.1.0/24 to any port 22)
ufw allow in on wg0 to any port 8080 proto tcp    # Relay nur ueber den Tunnel
ufw --force enable

sleep 3
echo "==> Selbsttest"
if curl -fsS "http://$TUNNEL_IP:8080/healthz" >/dev/null; then echo "    Relay laeuft: http://$TUNNEL_IP:8080"; else echo "    WARNUNG: Relay antwortet nicht – 'docker compose logs' im Ordner $HERE"; fi
echo
echo "================ Fertig – in der App eintragen (Admin → Verbindungen → X32 / Pi 5) ================"
echo "  Anbindung : Pi 5 / X32 über HTTP-Relay"
echo "  Pi-URL    : http://$TUNNEL_IP:8080"
echo "  Token     : $TOKEN"
echo "  Kanäle    : Player 1 = ${P1_CHANNELS:-1,2}, Player 2 = ${P2_CHANNELS:-3,4}, Mics = ${MIC_CHANNELS:-5,6,7}"
echo "======================================================================================"
