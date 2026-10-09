# Pi 5 einrichten (X32-Relay + VPN)

Der Pi hängt vor Ort im selben Netzwerk wie das X32 und verbindet sich per **WireGuard ausgehend** zu deinem Heimserver.
Die App spricht darüber mit dem **Relay** (`pi-relay/`), das Fader per OSC am X32 setzt und Mic-Status/Pegel zurückliefert.
Bitfocus Companion ist dafür **nicht nötig** (kann zusätzlich auf dem Pi laufen, z. B. für manuelle Buttons).

```
App-Container (Heimserver) ──WireGuard──► Pi 5 (10.8.0.2:8080, Relay) ──OSC/UDP 10023──► X32
```

## Überblick: wie alles zusammenhängt
- **Eigener WireGuard-Server auf dem Heimserver** (Container `wg`, `docker-compose.vpn.yml`). Peers: `pi` (der Veranstaltungs-Pi) und `pc` (dein Rechner). Kein Tailscale/Twingate nötig; es werden keine DNS-Server verändert.
- **Auf dem Pi läuft WireGuard direkt auf dem System**, aber mit schmalen Routen: nur das Tunnelnetz `10.8.0.0/24` geht durch den Tunnel, kein DNS, keine Standardroute. SSH, X32 und Internet des Pi bleiben normal. So erreichst du den Pi mit **allem, was darauf läuft** (SSH, Bitfocus Companion, n8n …): `ssh pi@10.8.0.2`, `http://10.8.0.2:8000` usw.
- **Zu Hause aus, woanders an:** `autonet.sh` (läuft beim Start und alle 30 s) erkennt deinen Heimrouter an seiner MAC-Adresse. Zu Hause ist der Tunnel aus, bei einer Veranstaltung geht er von selbst an und wird per Ping überwacht (bei Ausfall neu gestartet). Das funktioniert auch, wenn der Veranstaltungsort zufällig dieselben Adressen wie dein Heimnetz hat.
- **Das X32 von zu Hause erreichen:** Das X32 bekommt im Tunnel die feste, virtuelle Adresse **`10.8.0.200`**. Der Pi leitet sie auf die echte (wechselnde) X32-IP um. Von deinem PC (WireGuard an) öffnest du X32-Edit/Companion mit `10.8.0.200`. Weitere Geräte: in `pi-relay/.env` `EXTRA_DEVICES=10.8.0.201=192.168.1.20,10.8.0.202=…` (Adressen aus `10.8.0.192–255`). Ändert sich die X32-IP am Veranstaltungsort: `X32_HOST` in der `.env` ändern, der Rest passt sich innerhalb 30 s an.
- **Pi → Heimnetz:** Der Pi erreicht im Tunnel den Server (`10.8.0.1`) und deinen PC (`10.8.0.3`, wenn WireGuard dort läuft).

## Schnellweg (empfohlen)
1. **Server:** In der `.env` `WG_SERVERURL=wg.deine-domain.de` setzen (DNS-Eintrag **ohne** Cloudflare-Proxy), am Router UDP 51820 auf den Server leiten, dann
   `docker compose -f docker-compose.yml -f docker-compose.npm.yml -f docker-compose.vpn.yml up -d` und `./scripts/vpn-peer.sh`. Das erzeugt `pi.conf` und `pc.conf`.
   Prüfen: `docker compose exec wg wg show` – beim Peer `pi` müssen `10.8.0.2/32` **und** `10.8.0.192/26` stehen.
   **Oberfläche:** In der `.env` zusätzlich `WGCTL_TOKEN=<openssl rand -hex 24>` setzen und `docker compose up -d --build`. Dann gibt es im Admin den Tab **VPN**: Geräte (Handy, Laptop, Kollegen …) anlegen, QR-Code scannen oder Datei laden, Status/Handshake ansehen, Geräte entfernen. Ein Hinweis für die Verwaltung: Peers nur dort verwalten, nicht von Hand in der WireGuard-Konfiguration ändern.
2. **PC:** `pc.conf` in die WireGuard-App importieren (nur bei Bedarf einschalten).
3. **Pi:** `pi.conf` kopieren, Repo klonen, `cd schulhauspartry_ui/pi-relay && sudo ./install.sh ~/pi.conf`. Der Installer fragt, ob der Pi gerade **zu Hause** ist (merkt sich dann deinen Heimrouter), und zeigt am Ende Pi-URL(s) und Token.
4. **App:** Pi-URLs mit Komma eintragen: `http://<LAN-IP des Pi>:8080, http://10.8.0.2:8080` (zuerst LAN, dann VPN – die App nimmt automatisch die, die antwortet).
5. Zu Hause erreichst du den Pi (DHCP, wechselnde IP) mit `ssh pi@<hostname>.local` oder `<hostname>.fritz.box`.

**Fritz!Box statt eigenem Server:** geht weiter (der Installer erkennt die Datei), ist aber eingeschränkt: Du erreichst den Pi nur über die Fritz!Box-Adresse, und das X32 nicht von zu Hause.
**Tailscale auf dem Pi/Server:** Wenn es noch läuft und DNS ändert: `sudo tailscale up --accept-dns=false --accept-routes=false` oder `sudo tailscale down` / deinstallieren.
**Log/Status:** `journalctl -u x32-relay-net -n 30`, `sudo wg show`, `cd pi-relay && docker compose ps`.

## Test ohne X32 (zu Hause)
Im Ordner `pi-relay/` liegt ein simuliertes Pult (`fake-x32.js`): Es zeigt jeden Fader-Befehl der App an und simuliert Mikrofone.
```bash
cd ~/schulhauspartry_ui/pi-relay
nano .env                      # X32_HOST=127.0.0.1   (statt der echten Pult-IP)
docker compose up -d --build   # Relay neu starten
# zweites Terminal (oder in screen/tmux): das Fake-Pult starten, Mics 5 und 7 haben "Signal"
docker run --rm --network host -v "$PWD":/app -w /app -e MIC_OPEN=5,7 node:22-alpine node fake-x32.js
```
In der App: Admin → Verbindungen → Anbindung „HTTP-Relay“, Pi-URL `http://<LAN-IP des Pi>:8080`, Token. Bewegst du in der Technik-Ansicht einen Fader, erscheint im Terminal z. B. `Fader Kanal 1 -> 0.500`. Die Mikrofone erscheinen in der App als „offen“. Zurück zum echten Pult: in der `.env` wieder die X32-IP eintragen und das Relay neu starten.

## Kanäle einstellen (im Admin, nicht am Pi)
Admin → Verbindungen → X32 / Pi 5 → **Kanalzuordnung**: Player 1/2 (1 Kanal Mono oder 2 Kanäle Stereo), bis zu 3 Mikrofon-Kanäle und deren Namen. Die App übermittelt das automatisch an den Pi (alle 30 s und bei jeder Änderung), die Kanäle in der Relay-`.env` sind nur Startwerte.

## 0. Vorbereitung am X32
1. **Feste IP** vergeben: Setup → Network (z. B. `192.168.1.50`). Pi und X32 müssen im selben Netz sein (Kabel/Switch).
2. Die Player-Audioquellen und Mics liegen auf **Eingangskanälen** (`ch/01`–`ch/32`). Standard in der App:
   Player 1 = Kanäle 1+2, Player 2 = 3+4, Mics = 5, 6, 7. Abweichungen trägst du im Admin unter *Verbindungen* **und** in der Relay-`.env` ein.
3. Die Player-Kanäle als **Stereo-Paar verlinken** (Kanal 1+2 gelinkt), dann reicht es, dass beide Fader dieselbe Position bekommen – das setzt das Relay ohnehin.

## 1. Pi-Grundsetup
Raspberry Pi OS **Lite (64-bit)** auf SD/SSD flashen (Raspberry Pi Imager: Hostname, SSH, WLAN/Kabel, Benutzer vorgeben). Dann:
```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y wireguard git curl
curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER   # danach neu einloggen
```

## 2. VPN: Server-Seite (Heimserver)
In der `.env` der App: `WG_SERVERURL=wg.deine-domain.de` (DNS-Eintrag **ohne** Cloudflare-Proxy, Router: UDP 51820 → Server). Starten mit VPN-Override:
```bash
docker compose -f docker-compose.yml -f docker-compose.npm.yml -f docker-compose.vpn.yml up -d
docker compose logs wg | head -40                                  # QR/Peer-Info
docker compose exec wg cat /config/peer_pi/peer_pi.conf             # Config für den Pi
```
Im NPM zeigt der Proxy Host jetzt auf **`wg`**, Port `3000` (die App teilt sich dessen Netzwerk).

## 3. VPN: Pi-Seite
Inhalt von `peer_pi.conf` auf den Pi nach `/etc/wireguard/wg0.conf` kopieren und anpassen:
- Zeile **`DNS = …` löschen** (der Pi soll sein DNS behalten).
- `AllowedIPs = 10.8.0.0/24` (nur das Tunnelnetz, kein Full-Tunnel).
- `PersistentKeepalive = 25` im `[Peer]`-Block ergänzen (hält die Verbindung durch NAT offen).
```bash
sudo chmod 600 /etc/wireguard/wg0.conf
sudo systemctl enable --now wg-quick@wg0
ping -c 3 10.8.0.1        # Server im Tunnel
```
Der Pi hat im Tunnel die Adresse `10.8.0.2`.

## 4. Relay auf dem Pi
```bash
git clone -b claude/kind-bohr-3yd3zg https://github.com/witzig0hast/schulhauspartry_ui.git
cd schulhauspartry_ui/pi-relay
cp .env.example .env && nano .env      # X32_HOST, RELAY_TOKEN (openssl rand -hex 24), BIND=10.8.0.2, Kanäle
docker compose up -d --build
curl http://10.8.0.2:8080/healthz      # {"ok":true}
```
Das Relay lauscht **nur** auf der Tunnel-IP und verlangt den Token (`Authorization: Bearer …`).

## 5. In der App verbinden
Admin → **Verbindungen** → *X32 / Pi 5*:
- Anbindung: **Pi 5 / X32 über HTTP-Relay**
- Pi-URL: `http://10.8.0.2:8080`
- Token: derselbe wie `RELAY_TOKEN`
- Kanäle wie am X32, **Speichern**.
- Admin → **Start & Links** → Testmodus-Optionen → „Echte Verbindungen nutzt“ auf die Umgebung stellen, die den Pi steuern soll (live oder test).

In der Verbindungsampel (Technik/FOH) werden **X32** und **Pi** grün. Teste zuerst mit Musik auf **niedriger Lautstärke**:
Fader in der Technik-Ansicht bewegen → am X32 müssen sich die Fader der Player-Kanäle mitbewegen; Mic aufdrehen → Mic-Anzeige reagiert, Ducking senkt die Player.

## Fehlersuche
| Symptom | Prüfen |
|---|---|
| Pi bleibt rot | `curl http://10.8.0.2:8080/healthz` vom Server-Container (`docker compose exec app wget -qO- http://10.8.0.2:8080/healthz`); VPN: `sudo wg show` (Handshake?) |
| X32 rot, Pi grün | `X32_HOST` falsch/andere IP; Pi und X32 im selben Netz? Firewall: UDP 10023 |
| Fader bewegen sich nicht | falsche Kanalnummern; X32 „Remote“ nicht durch anderes Gerät belegt (max. wenige Remote-Clients) |
| Mics immer „stumm“ | Mic-Kanäle in Relay-`.env` und Admin gleich? Kanal am X32 nicht gemutet? |
| Meter/Ducking spinnt | Schwelle `MIC_THRESHOLD` (Standard 0.03) anpassen |

**Hinweis:** Das Relay ist gegen einen simulierten X32 getestet (OSC-Protokoll, Auth, Fader, Mic-Logik), aber noch **nicht** gegen ein echtes Pult.
Besonders die Meter-Abfrage (`/meters/1`) solltest du am echten X32 prüfen. Fällt sie aus, nutzt das Relay nur den Mute-Status der Mic-Kanäle.
