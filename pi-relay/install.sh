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

# Sicherung: dieses Skript gehoert NUR auf den Pi neben dem X32, nie auf den Heimserver mit der App.
if [ -f "$HERE/../docker-compose.npm.yml" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qiE 'nginx|npm|app-1|wg-1|schulhauspartry'; then
  echo "ABBRUCH: Auf diesem Rechner laeuft die App (oder der Nginx Proxy Manager) in Docker."
  echo "Dieses Skript ist nur fuer den Pi am X32. Es aendert Firewall und Netzwerk und wuerde den Server aussperren."
  exit 1
fi
echo "Dieses Skript aendert Netzwerk (WireGuard) und Firewall dieses Geraets: $(hostname)"
read -r -p "Ist das der Pi, der neben dem X32 steht? (ja/nein) " A </dev/tty
[ "$A" = "ja" ] || { echo "Abgebrochen."; exit 1; }

ask() { local var="$1" prompt="$2" def="$3"; if [ -z "${!var:-}" ]; then read -r -p "$prompt [$def]: " v </dev/tty; export "$var"="${v:-$def}"; fi; }

echo "==> Pakete installieren"
apt-get update -y
apt-get install -y wireguard wireguard-tools ufw curl openssl
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
usermod -aG docker "$RUN_USER" || true

echo "==> WireGuard-Konfiguration vorbereiten"
install -d -m 700 /etc/wireguard
cp "$CONF_SRC" /etc/wireguard/wg0.conf
# DNS des Pi nicht anfassen
sed -i '/^DNS[[:space:]]*=/d' /etc/wireguard/wg0.conf
ADDR="$(sed -n 's|^Address[[:space:]]*=[[:space:]]*\([0-9.]*\).*|\1|p' /etc/wireguard/wg0.conf | head -1)"
ADDR="${ADDR:-10.8.0.2}"
FRITZ=0
case "$ADDR" in 10.8.0.*) ;; *) FRITZ=1 ;; esac
if [ "$FRITZ" = 1 ]; then
  echo "    Fritz!Box-Konfiguration erkannt (Tunnel-Adresse $ADDR)"
  # Adresse nur als Einzel-Adresse (/32), sonst wird das ganze Heimnetz auf den Tunnel umgeleitet
  sed -i '/^Address/ { s|/24|/32|g; s|/64|/128|g }' /etc/wireguard/wg0.conf
  ask SERVER_IP "LAN-IP des Heimservers (der Rechner mit der App) im Heimnetz" "192.168.178.50"
  PEER_NET="$SERVER_IP/32"
  PING_TARGET="$SERVER_IP"
else
  PEER_NET="10.8.0.0/24"
  PING_TARGET="10.8.0.1"
fi
# nur das Noetige durch den Tunnel schicken, Verbindung offen halten
sed -i "s|^AllowedIPs[[:space:]]*=.*|AllowedIPs = $PEER_NET|" /etc/wireguard/wg0.conf
grep -q '^PersistentKeepalive' /etc/wireguard/wg0.conf || sed -i '/^\[Peer\]/a PersistentKeepalive = 25' /etc/wireguard/wg0.conf
chmod 600 /etc/wireguard/wg0.conf

# Liegt der Pi gerade im selben Netz wie die Tunnel-Adresse (z. B. zu Hause), wuerde der Tunnel das LAN kapern.
START_NOW=1
if [ "$FRITZ" = 1 ] && ip -4 route show scope link 2>/dev/null | grep -q "^$(echo "$ADDR" | cut -d. -f1-3)\.0/24 dev \(eth\|wlan\|en\)"; then
  START_NOW=0
  echo "    HINWEIS: Der Pi haengt gerade im Heimnetz ($(echo "$ADDR" | cut -d. -f1-3).0/24). Der Tunnel wird jetzt NICHT gestartet,"
  echo "    sonst bricht SSH ab. Bei der Party (anderes Netz): sudo systemctl enable --now wg-quick@wg0"
fi
if [ "$START_NOW" = 1 ]; then systemctl enable --now wg-quick@wg0; fi
# Tunnel automatisch neu aufbauen, falls er mal haengt (z. B. nach Netzwerkwechsel)
install -d /etc/systemd/system/wg-quick@wg0.service.d
cat > /etc/systemd/system/wg-quick@wg0.service.d/restart.conf <<'UNIT'
[Service]
Restart=on-failure
RestartSec=10
UNIT
cat > /etc/systemd/system/wg-watchdog.service <<UNIT
[Unit]
Description=WireGuard-Watchdog (Tunnel neu starten, wenn der Server nicht antwortet)
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'ip link show wg0 >/dev/null 2>&1 || exit 0; ping -c 2 -W 3 $PING_TARGET >/dev/null 2>&1 || systemctl restart wg-quick@wg0'
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
if [ "$START_NOW" = 1 ]; then systemctl enable --now wg-watchdog.timer; fi

TUNNEL_IP="$ADDR"
if [ "$START_NOW" = 1 ]; then
  echo "==> Tunnel pruefen (Pi hat $TUNNEL_IP)"
  for _ in $(seq 1 10); do ping -c 1 -W 2 "$PING_TARGET" >/dev/null 2>&1 && OK=1 && break || sleep 2; done
  if [ "${OK:-0}" = 1 ]; then echo "    Tunnel steht ($PING_TARGET antwortet)."; else
    echo "    WARNUNG: $PING_TARGET antwortet nicht. Pruefe 'sudo wg show' (Handshake?)."; fi
fi

echo "==> Relay einrichten"
ask X32_HOST "IP-Adresse des X32" "192.168.1.50"
TOKEN="$(openssl rand -hex 24)"
if [ -f "$HERE/.env" ] && grep -q '^RELAY_TOKEN=' "$HERE/.env"; then TOKEN="$(sed -n 's/^RELAY_TOKEN=//p' "$HERE/.env")"; echo "    vorhandener Token wird behalten"; fi
BIND_ADDR="$TUNNEL_IP"; [ "$START_NOW" = 0 ] && BIND_ADDR="0.0.0.0"   # nur zum Test im LAN, bei der Party Tunnel-IP
cat > "$HERE/.env" <<ENV
X32_HOST=$X32_HOST
X32_PORT=10023
RELAY_TOKEN=$TOKEN
BIND=$BIND_ADDR
PORT=8080
P1_CHANNELS=${P1_CHANNELS:-1,2}
P2_CHANNELS=${P2_CHANNELS:-3,4}
MIC_CHANNELS=${MIC_CHANNELS:-5,6,7}
ENV
chmod 600 "$HERE/.env"
chown "$RUN_USER" "$HERE/.env" 2>/dev/null || true
( cd "$HERE" && docker compose up -d --build )

echo "==> Firewall (nur SSH aus dem LAN, Relay nur im Tunnel)"
ufw default deny incoming; ufw default allow outgoing
ufw allow in on tailscale0 2>/dev/null || true
ufw allow 22/tcp                                  # SSH (bei Bedarf auf dein LAN beschraenken: ufw allow from 192.168.1.0/24 to any port 22)
ufw allow in on wg0 to any port 8080 proto tcp    # Relay nur ueber den Tunnel
[ "$START_NOW" = 0 ] && ufw allow from "$(echo "$ADDR" | cut -d. -f1-3).0/24" to any port 8080 proto tcp   # nur LAN-Test zu Hause
ufw --force enable

sleep 3
echo "==> Selbsttest"
if curl -fsS "http://127.0.0.1:8080/healthz" >/dev/null; then echo "    Relay laeuft: http://$TUNNEL_IP:8080"; else echo "    WARNUNG: Relay antwortet nicht – 'docker compose logs' im Ordner $HERE"; fi
echo
echo "================ Fertig – in der App eintragen (Admin → Verbindungen → X32 / Pi 5) ================"
echo "  Anbindung : Pi 5 / X32 über HTTP-Relay"
if [ "$START_NOW" = 1 ]; then echo "  Pi-URL    : http://$TUNNEL_IP:8080"; else echo "  Pi-URL    : http://<LAN-IP dieses Pi>:8080   (LAN-Test zu Hause; bei der Party: http://$TUNNEL_IP:8080)"; fi
echo "  Token     : $TOKEN"
echo "  Kanäle    : Player 1 = ${P1_CHANNELS:-1,2}, Player 2 = ${P2_CHANNELS:-3,4}, Mics = ${MIC_CHANNELS:-5,6,7}"
echo "======================================================================================"
