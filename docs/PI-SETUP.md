# Pi 5 einrichten (X32-Relay + VPN)

Der Pi hängt vor Ort im selben Netzwerk wie das X32 und verbindet sich per **WireGuard ausgehend** zu deinem Heimserver.
Die App spricht darüber mit dem **Relay** (`pi-relay/`), das Fader per OSC am X32 setzt und Mic-Status/Pegel zurückliefert.
Bitfocus Companion ist dafür **nicht nötig** (kann zusätzlich auf dem Pi laufen, z. B. für manuelle Buttons).

```
App-Container (Heimserver) ──WireGuard──► Pi 5 (10.8.0.2:8080, Relay) ──OSC/UDP 10023──► X32
```

## Schnellweg (empfohlen)
1. **VPN-Zugang erzeugen:** entweder in der Fritz!Box (WireGuard-Verbindung für „einzelnes Gerät" → Datei `pi.conf`) oder mit dem eigenen WireGuard-Container auf dem Server (`./scripts/vpn-peer.sh`, siehe Abschnitt 2).
2. `pi.conf` auf den Pi kopieren, Repo klonen, dann: `cd schulhauspartry_ui/pi-relay && sudo ./install.sh ~/pi.conf`.
3. Das Skript fragt nach der X32-IP und (bei Fritz!Box) der LAN-IP des Heimservers und zeigt am Ende **Pi-URL(s)** und **Token** für die App.

**Wie die Automatik arbeitet:** Beim Start des Pi (und danach alle 30 Sekunden) prüft `autonet.sh`, ob der Heimserver im selben Netz erreichbar ist.
- **Ja → Modus „LAN":** das Relay läuft direkt im Netz des Pi, **ohne VPN**.
- **Nein → Modus „VPN":** WireGuard startet **nur in einem Docker-Container**, das Relay hängt sich in dessen Netzwerk. Der Pi selbst (SSH, X32, Internet, andere Geräte im Netz) bleibt unverändert.
- Gewechselt wird erst nach zwei gleichen Messungen (ca. 1 Minute), damit es nicht hin und her springt.
- Log: `journalctl -u x32-relay-net -n 30`. Aktueller Modus: `cd pi-relay && docker compose ps`.

**In der App** trägst du **beide** Adressen ein, durch Komma getrennt (zuerst LAN, dann VPN), z. B. `http://192.168.178.177:8080, http://192.168.178.207:8080`. Die App nimmt automatisch die, die antwortet. Gib dem Pi im Router eine feste IP (DHCP-Reservierung), damit die LAN-Adresse stabil bleibt.

## Test ohne X32 (zu Hause)
Im Ordner `pi-relay/` liegt ein simuliertes Pult (`fake-x32.js`): Es zeigt jeden Fader-Befehl der App an und simuliert Mikrofone.
```bash
cd ~/schulhauspartry_ui/pi-relay
nano .env                      # X32_HOST=127.0.0.1   (statt der echten Pult-IP)
docker compose up -d --build relay-lan   # Relay neu starten (Modus LAN; im Test-Betrieb ist der Server im selben Netz)
# zweites Terminal (oder in screen/tmux): das Fake-Pult starten, Mics 5 und 7 haben "Signal"
docker run --rm --network host -v "$PWD":/app -w /app -e MIC_OPEN=5,7 node:22-alpine node fake-x32.js
```
(Im VPN-Modus läuft das Relay in einem eigenen Netzwerk, dort ist `127.0.0.1` nicht der Pi – das Fake-Pult-Testen geht daher im LAN-Modus.)
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
