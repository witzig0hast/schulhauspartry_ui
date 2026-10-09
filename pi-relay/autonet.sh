#!/usr/bin/env bash
# Waehlt automatisch die Betriebsart des Relays (laeuft per systemd beim Start und alle 30 s):
#   Server im selben Netz erreichbar  -> "lan" (ohne VPN)
#   sonst                             -> "vpn" (WireGuard nur im Container)
# Gewechselt wird erst, wenn der neue Zustand 2x hintereinander festgestellt wurde (kein Hin-und-Her).
set -u
cd "$(dirname "$0")"
[ -f .env ] || { echo "autonet: .env fehlt"; exit 1; }
set -a; . ./.env; set +a

alive() {   # Server erreichbar? Ping, sonst TCP (auch "Verbindung abgelehnt" zeigt: der Rechner lebt)
  local ip="$1" p rc
  ping -c 2 -W 2 "$ip" >/dev/null 2>&1 && return 0
  for p in 443 80 22; do
    timeout 2 bash -c "exec 3<>/dev/tcp/$ip/$p" 2>/dev/null; rc=$?
    [ "$rc" -ne 124 ] && return 0
  done
  return 1
}

want=vpn; why="kein SERVER_LAN_IP gesetzt"
if [ -n "${SERVER_LAN_IP:-}" ]; then
  route="$(ip route get "$SERVER_LAN_IP" 2>/dev/null | head -1)"
  if [ -z "$route" ]; then why="kein Netzwerk"
  elif echo "$route" | grep -q ' via '; then why="Server liegt in einem anderen Netz"
  elif alive "$SERVER_LAN_IP"; then want=lan; why="Server im selben Netz erreichbar"
  else why="gleiches Subnetz, aber Server antwortet nicht"; fi
fi

running() { docker compose ps --services --status running 2>/dev/null | grep -qx "$1"; }
cur=none
running relay-lan && cur=lan
running relay-vpn && running wg && cur=vpn

STATE=/run/x32-relay-net
n=0; [ -f "$STATE" ] && read -r pw pn < "$STATE" && [ "$pw" = "$want" ] && n="$pn"
if [ "$cur" = "$want" ]; then rm -f "$STATE"; exit 0; fi
n=$((n + 1)); echo "$want $n" > "$STATE"
if [ "$cur" != none ] && [ "$n" -lt 2 ]; then echo "autonet: moechte auf $want wechseln ($why) – warte auf Bestaetigung"; exit 0; fi

echo "autonet: Modus $cur -> $want ($why)"
if [ "$want" = lan ]; then
  docker compose rm -sf relay-vpn wg >/dev/null 2>&1
  # Port 8080 nur fuer das aktuelle Heimnetz freigeben
  net="$(ip -4 route show scope link | awk '!/docker|br-|wg/ {print $1; exit}')"
  [ -n "$net" ] && command -v ufw >/dev/null && ufw allow from "$net" to any port 8080 proto tcp >/dev/null 2>&1
  docker compose up -d --build relay-lan
else
  docker compose rm -sf relay-lan >/dev/null 2>&1
  [ -f wg/wg0.conf ] || { echo "autonet: wg/wg0.conf fehlt"; exit 1; }
  docker compose up -d --build wg relay-vpn
fi
rm -f "$STATE"
