#!/usr/bin/env bash
# Laeuft per systemd beim Start und alle 30 s:
#   1. Bin ich zu Hause?  (Heimrouter erkannt per MAC-Adresse, sonst: Server im selben Netz erreichbar)
#        ja   -> VPN aus (alles laeuft direkt im LAN)
#        nein -> VPN an (WireGuard auf dem Pi, nur das Tunnelnetz wird geroutet) und per Ping ueberwacht
#   2. Virtuelle Geraete-Adressen (z. B. 10.8.0.200 = X32) auf die echten Adressen im aktuellen Netz umleiten
# Gewechselt wird erst nach zwei gleichen Messungen (kein Hin-und-Her).
set -u
cd "$(dirname "$0")"
[ -f .env ] || { echo "autonet: .env fehlt"; exit 1; }
set -a; . ./.env; set +a
STATE=/run/x32-relay-net
tunnel_up() { ip link show wg0 >/dev/null 2>&1; }

# ---------- 1. zu Hause? ----------
alive() {
  local ip="$1" p rc
  ping -c 2 -W 2 "$ip" >/dev/null 2>&1 && return 0
  for p in 443 80 22; do timeout 2 bash -c "exec 3<>/dev/tcp/$ip/$p" 2>/dev/null; rc=$?; [ "$rc" -ne 124 ] && return 0; done
  return 1
}
phys_if="$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev") print $(i+1)}' | grep -v '^wg0$' | head -1)"
gw="$(ip -4 route show default dev "${phys_if:-eth0}" 2>/dev/null | awk '{print $3; exit}')"
gw_mac=""
if [ -n "$gw" ]; then ping -c 1 -W 1 "$gw" >/dev/null 2>&1; gw_mac="$(ip neigh show "$gw" dev "$phys_if" 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="lladdr") print tolower($(i+1))}' | head -1)"; fi

want=vpn; why="kein Heim-Netz erkannt"
if [ -z "$phys_if" ] || [ -z "$gw" ]; then why="kein Netzwerk (Kabel/WLAN?)"
elif [ -n "${HOME_GW_MAC:-}" ]; then
  if [ "$gw_mac" = "$(echo "$HOME_GW_MAC" | tr A-Z a-z)" ]; then want=lan; why="Heimrouter erkannt ($gw_mac)"; else why="anderer Router ($gw_mac)"; fi
elif [ -n "${SERVER_LAN_IP:-}" ]; then
  # ohne gespeicherte Router-MAC: Server ueber die echte Netzwerkkarte anpingen (am Tunnel vorbei)
  if ping -I "$phys_if" -c 2 -W 2 "$SERVER_LAN_IP" >/dev/null 2>&1; then want=lan; why="Server im selben Netz erreichbar"; else why="Server nicht im selben Netz"; fi
fi

cur=vpn; tunnel_up || cur=lan
n=0; [ -f "$STATE" ] && read -r pw pn < "$STATE" && [ "$pw" = "$want" ] && n="$pn"
# ---------- 2. Umleitung der virtuellen Geraete (immer, idempotent) ----------
apply_nat() {
  command -v iptables >/dev/null || return 0
  sysctl -qw net.ipv4.ip_forward=1
  for t in "nat PREROUTING X32R_DNAT" "nat POSTROUTING X32R_SNAT" "filter FORWARD X32R_FWD"; do
    set -- $t
    iptables -t "$1" -N "$3" 2>/dev/null; iptables -t "$1" -F "$3"
    iptables -t "$1" -C "$2" -j "$3" 2>/dev/null || iptables -t "$1" -I "$2" 1 -j "$3"
  done
  local pairs="${VIRTUAL_X32_IP:-10.8.0.200}=${X32_HOST:-}${EXTRA_DEVICES:+,$EXTRA_DEVICES}" pair v r
  IFS=',' read -ra arr <<< "$pairs"
  for pair in "${arr[@]}"; do
    v="${pair%%=*}"; r="${pair#*=}"; [ -n "$v" ] && [ -n "$r" ] || continue
    iptables -t nat -A X32R_DNAT -i wg0 -d "$v" -j DNAT --to-destination "$r"
    iptables -t nat -A X32R_SNAT ! -o wg0 -d "$r" -j MASQUERADE
    iptables -A X32R_FWD -i wg0 -d "$r" -j ACCEPT
    iptables -A X32R_FWD -o wg0 -s "$r" -j ACCEPT
  done
}
apply_nat

# ---------- Umschalten ----------
if [ "$cur" = "$want" ]; then
  rm -f "$STATE"
  if [ "$want" = vpn ] && [ -n "${PING_TARGET:-}" ] && ! ping -c 2 -W 3 "$PING_TARGET" >/dev/null 2>&1; then
    echo "autonet: Tunnel antwortet nicht ($PING_TARGET) – starte ihn neu"; wg-quick down wg0 >/dev/null 2>&1; wg-quick up wg0
  fi
  exit 0
fi
n=$((n + 1)); echo "$want $n" > "$STATE"
if [ "$n" -lt 2 ] && [ -z "${AUTONET_FIRST:-}" ]; then echo "autonet: moechte auf $want wechseln ($why) – warte auf Bestaetigung"; exit 0; fi
echo "autonet: $cur -> $want ($why)"
if [ "$want" = lan ]; then
  wg-quick down wg0
  net="$(ip -4 route show dev "$phys_if" scope link | awk '{print $1; exit}')"
  [ -n "$net" ] && command -v ufw >/dev/null && ufw allow from "$net" to any port 8080 proto tcp >/dev/null 2>&1
else
  wg-quick up wg0
fi
rm -f "$STATE"
