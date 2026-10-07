# Schulhauspartry – Party-Steuerung

Web-App für eine Schulparty: zwei Spotify-Player (Player 1/2) laufen über ein **Behringer X32 Compact**,
Gäste wünschen Songs per QR-Code, Moderatoren geben sie frei, die Technik (FOH) steuert Fades, Crossfades,
Ducking und Not-Aus. Alles ist rollenbasiert abgesichert und läuft in Docker.

> **Stand (Phase 1):** komplette Web-Version inkl. Testmodus. Der **Pi 5 / X32** ist noch nicht angebunden –
> die X32-Steuerung läuft über einen **Simulator** (Fader, Mics, Pegel). Spotify läuft simuliert, bis du im
> Admin-Bereich echte Accounts verbindest.

## Ansichten

| URL | Wer | Zweck |
|---|---|---|
| `/` | Gäste (QR-Code) | Spotify-Suche → Song antippen → Wunsch. Status, „Jetzt läuft“, Organisatoren-Hinweis |
| `/login` | alle Rollen | Code bzw. Admin-Passwort eingeben |
| `/mod` | Moderation, Orga (nur lesen) | Wünsche annehmen/ablehnen, Gesamt-Warteschlange |
| `/tech` | Technik, Head-Admin | Player, Fader, Fades, Crossfade, Auto-Crossfade, Ducking, Mics, Not-Aus, Ende-Modus, Wunschmodus |
| `/foh` | FOH-Anzeige, Technik, Orga, Admin | reine Anzeige (nichts bedienbar): Player, Pegel, Mics, Queue, Status |
| `/admin` | nur Head-Admin | Start & Links, QR & Poster, Einstellungen, Codes, Verbindungen, Bericht/CSV |
| `/board` | alle Mitarbeitenden | **Modulares Board**: Bausteine an-/abwählen, sortieren, Größe wählen, eigene Ansichten speichern |
| `/focus` | Moderation, Technik, Admin | **Fokus-Modus**: komplett schwarz, bis ein Wunsch kommt – dann Annehmen / Ablehnen (Tasten A, D, 1–9, B, F) |
| `/ticker` | Anzeige, Technik, Orga, Admin | **Live-Wünsche**: neue Wünsche erscheinen sofort, dann „Angenommen“ / „Abgelehnt“ |
| `/analytics` | alle Mitarbeitenden | **Analytics** live: Genres, Interpreten, Jahrzehnte, Zeitverlauf, Annahme-Quote … |
| `/beamer` | öffentlich (großer Bildschirm) | „Jetzt läuft“ + QR-Code + Hinweis der Organisatoren – zeigt nichts Internes |

Auf allen Spezialansichten steht unten links ein kleiner **Ping** (nicht auf der Gäste-Seite).
Dark-Mode folgt der Systemeinstellung des Geräts und lässt sich per Knopf oben rechts umstellen.

## Rollen

| Rolle | Darf |
|---|---|
| Head-Admin (Passwort) | alles, inkl. Admin-Seite, Codes, CSV/Bericht, Testmodus |
| Technik (Code) | Tech-Ansicht, Moderation, Wunschmodus sperren, Hinweis ändern, Mics/Verbindungsampel |
| Moderation (Code) | Wünsche annehmen/ablehnen, priorisieren |
| Orga (Code) | Moderationsansicht nur lesen |
| FOH-Anzeige (Code) | nur die Static-Anzeige |

Codes sind anonym (nur eine Bezeichnung wie „Mod Lisa“), aber zurückverfolgbar: Im Admin-Bereich siehst du pro Code,
was angenommen/abgelehnt/priorisiert wurde. Codes lassen sich sperren oder löschen. Der Klartext-Code wird nur
beim Erstellen angezeigt (gespeichert wird nur ein Hash).

## Wunsch-Ablauf

1. Gast sucht (Spotify-Suche über den Server, ohne Login) und tippt einen Treffer an – keine Freitexteingabe.
2. **Limit pro Gerät** (Cookie/Token, einstellbar im Admin, Standard 2 pro 15 Min.). Kein IP-Limit.
3. **Duplikat-Check** im Backend: schon vorgeschlagen → Pop-up „wird voraussichtlich in ca. N Songs gespielt“, der Wunsch bekommt ein **+1**.
4. Moderation sieht den Wunsch live (WebSocket). **Der erste Klick gewinnt** – ein zweiter Moderator bekommt „wurde schon bearbeitet“.
5. **Annehmen** → automatisch dem Player mit weniger zugewiesenen Songs zugeordnet (oder fest P1/P2). Der Gast sieht „angenommen“ / „abgelehnt (+Grund)“ und „noch N Lieder vor dir“.
6. **Priorisieren** (★) schiebt einen Song in die nächsten N Songs (Standard 3), markiert mit dem Code des Priorisierenden.
7. Die Warteschlange liegt in der App; die Engine startet jeweils den nächsten Song just-in-time auf dem passenden Player (kein Umsortieren per UI).

**Explicit-Filter** (Admin): *Aus* · *Markieren* („E“ im Dashboard) · *Blocken* (Gäste können Explicit-Songs nicht wünschen).

## Technik

- **Fades**: Fade-In/-Out pro Player mit einstellbarer Zeit + Presets, manueller Crossfade, Fader-Slider.
- **Auto-Crossfade** (an/aus): Dauer und „Start X Sekunden vor Songende“ je Player, Kurve Equal-Power oder Linear.
- **Ducking** (an/aus): Player werden bei offenem Mic um X dB abgesenkt (Attack/Release).
- **Not-Aus**: muss **zweimal** gedrückt werden (Server verlangt ein einmaliges Token, 5 s gültig). Pausiert beide Player, Fader auf 0.
- **Ende-Modus**: blendet aus, schließt die Wünsche, zeigt den Abschlusstext. Kann aufgehoben werden.
- **Wunschmodus**: offen / pausiert / geschlossen (nur Head-Admin und Technik) mit Gast-Hinweistext.
- **Verbindungsampel** (Server, X32, Pi, Spotify, Player 1/2) für Technik, Admin und FOH-Anzeige.

## Testmodus

Gleiche Ansichten wie live, aber unter einer **geheimen URL** (`/t-xxxxxxxxxxxx/…`) mit **eigenen Daten**.
Ein-/Ausschalten, URL erneuern und alle Test-Links (Gäste, Technik, Moderation, Anzeige) findest du im Admin unter *Start & Links*. Ist er aus, liefert die URL `404`.
Alle Seiten zeigen im Test ein rotes „TESTMODUS“-Banner. *Simulations-Tempo* lässt Songs im Test schneller laufen.
Echte Verbindungen (Spotify/Pi) nutzt immer nur **eine** Umgebung (Admin → Start & Links → Testmodus-Optionen), die andere bleibt simuliert.

## Nach dem Abend (nur Head-Admin)

Admin → *Bericht & Export*: Abschlussbericht (Wünsche, Quote, meistgewünschte Songs, Stoßzeiten, Entscheidungen pro Code,
Not-Aus/Fehler) und **Setlist als CSV**.

## Start (lokal)

```bash
npm ci
ADMIN_PASSWORD='ein-langes-passwort' npm start      # http://localhost:3000
npm test
```

Ohne `NODE_ENV=production` genügt das; in Produktion sind `APP_SECRET` (≥ 32 Zeichen) und `ADMIN_PASSWORD` (≥ 12 Zeichen) Pflicht.

## Deployment (Docker)

```bash
cp .env.example .env     # Werte setzen
docker compose -f docker-compose.yml -f docker-compose.npm.yml up -d
```

- **Nginx Proxy Manager**: Proxy-Host auf `app:3000`, **Websockets support AN**, SSL über NPM/Cloudflare.
  `docker-compose.npm.yml` hängt die App ins Docker-Netz des NPM (`NPM_NETWORK`).
- **Cloudflare**: `TRUST_CLOUDFLARE=true`, damit die echte Client-IP aus `CF-Connecting-IP` kommt (Login-Sperre).
- **VPN nur im Container** (keine DNS-/Host-Änderung): `docker-compose.vpn.yml` startet einen WireGuard-Sidecar (`wg`); die App
  teilt dessen Netzwerk-Namespace. Der Pi verbindet sich als Peer (`PersistentKeepalive`) und ist im Tunnel z. B. `10.8.0.2`.
  Bei diesem Override im NPM als Forward-Hostname **`wg`** (Port 3000) eintragen. Den UDP-Port 51820 **nicht** über den
  Cloudflare-Proxy leiten (nur DNS-Eintrag ohne Proxy).
- Daten (SQLite) liegen im Volume `/data`.
- Die Compose-Dateien sind per `docker compose config` geprüft; ein Image-Build war in der Entwicklungsumgebung nicht möglich (kein Docker-Daemon).

## Spotify einrichten (Admin → Verbindungen)

1. Im [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) eine App anlegen; Redirect-URI: `<PUBLIC_URL>/api/admin/spotify/callback`.
2. Client ID/Secret im Admin eintragen (oder per `.env`).
3. Player 1 und Player 2 mit je einem **Premium**-Account verbinden, jeweils ein Wiedergabegerät (Spotify Connect) wählen,
   dessen Audio in den X32 geht.

Hinweis: Die Wiedergabe wird per „Play URI“ auf dem jeweiligen Gerät gestartet (deterministisch, kein Umsortieren der Spotify-Queue nötig).
Die echte Spotify-Anbindung konnte hier mangels Zugangsdaten nicht live getestet werden; getestet ist die Logik mit dem Simulator.

## Pi 5 / X32

Das **Relay** liegt in `pi-relay/` (läuft auf dem Pi, spricht OSC mit dem X32, HTTP mit der App über den VPN-Tunnel).
Komplette Anleitung inkl. WireGuard: **[docs/PI-SETUP.md](docs/PI-SETUP.md)**.

```
POST {piUrl}/x32/level   {"player":1,"channels":[1,2],"fader":0.75}   → setzt X32-Fader (0..1, 0.75 = 0 dB)
GET  {piUrl}/x32/state   → {"mics":[{"open":true,"level":0.4},…],"meters":{"1":0.5,"2":0.3}}
Header: Authorization: Bearer <Token>
```

Das Relay ist gegen einen simulierten X32 getestet, noch nicht gegen ein echtes Pult.

## Sicherheit

- Passwörter mit scrypt, Codes/Sessions nur als SHA-256-Hash, Spotify-Tokens AES-256-GCM-verschlüsselt (Schlüssel aus `APP_SECRET`).
- Session-Cookie `HttpOnly`, `SameSite=Strict`, `Secure` hinter HTTPS; Origin-Prüfung bei allen schreibenden Requests und WebSockets.
- Login-Sperre nach Fehlversuchen, Rate-Limits für die Gäste-API, strikte CSP, `X-Frame-Options: DENY`, `noindex`.
- Gast-Eingaben werden serverseitig geprüft: der Song wird per ID bei Spotify nachgeschlagen, Metadaten vom Client werden nie vertraut.
- CSV-Export schützt gegen Formel-Injection. Alle UI-Texte werden per `textContent` gesetzt (keine HTML-Injection).

## Projektstruktur

```
src/            Server (Express + ws), Engine (Fades/Crossfade/Ducking), Adapter (Spotify, X32), Routen
public/         Seiten (HTML) und Assets (vanilla JS/CSS, kein Build-Schritt)
test/           Integrations- und Engine-Tests (node:test)
```

## Zurücksetzen

Admin → *Start & Links* → **Zurücksetzen**: löscht Wünsche, Warteschlange, Setlist und Zähler einer Umgebung und stoppt die Wiedergabe.
Codes und Einstellungen bleiben. *Testmodus* ohne Rückfrage-Tippen, *Live* nur nach Eingabe von `ZURÜCKSETZEN`.

## Board (modular)

Unter `/board` stellt sich jede Person ihre eigene Ansicht zusammen. *Bearbeiten* → Bausteine antippen (ein/aus), am Baustein
Reihenfolge (← →) und Größe (Klein/Breit/Voll) ändern. Vorlagen: Übersicht, Bühne, Moderation, Technik, Zahlen, Alles.
Eigene Ansichten werden pro Gerät gespeichert. Jede Rolle sieht nur Bausteine, die sie benutzen darf.

Bausteine: Jetzt läuft · Player 1/2 · Als Nächstes · Offene Wünsche · Zuletzt entschieden · Zahlen · Pegel · Mikrofone ·
Übergang (Crossfade/Auto/Ducking) · Wunschmodus · Not-Aus/Ende-Modus · Verbindungen · Uhr & Ende · Statistik live.

## QR-Code & Poster

Admin → *QR & Poster*: QR-Code zur Gäste-Seite (live oder Test), Überschrift/Untertitel anpassbar, **Drucken / als PDF speichern** (A4).

## Sperren & schon gespielte Songs

- **Sperren** (Moderation, Technik, Admin): bei jedem Wunsch „⛔ Sperren“ → *Song* oder *Interpret*. Gesperrt = Gäste sehen „nicht möglich“,
  offene Wünsche werden abgelehnt, Einträge aus der Warteschlange entfernt. Reiter *Gesperrt*: Liste, direkt per Suche sperren, *Freigeben*.
- **Schon gespielt** (Admin → Einstellungen): *Erlauben* · *Pause* (erst nach X Minuten wieder wünschbar) · *Sperren* (heute nicht mehr).
  Die Moderation kann gespielte Songs im Reiter *Gespielt* trotzdem mit **↻ Nochmal** hinten einreihen oder sperren.
- Blockierte Versuche werden gezählt und in den Analytics gezeigt.

## Analytics

`/analytics` und die Board-Bausteine *Genres live*, *Genre-Verlauf*, *Top-Interpreten*: Gewünscht vs. gespielt je Genre, Genre-Verlauf, Top-Interpreten,
Jahrzehnte, Annahme-Quote je Genre, Wünsche im Zeitverlauf, Entscheidungsgeschwindigkeit, Beliebtheit, meistunterstützte Songs, Gäste-Aktivität,
blockierte Versuche. Zeitraum wählbar (Gesamt / 15 Min / 1–6 Std), jede Grafik hat eine Tabellenansicht, alles anonym.
Genres kommen von Spotify (über den Interpreten) und werden zu Familien zusammengefasst (Pop, Hip-Hop & Rap, Electronic & Dance, …).
Liefert Spotify für eure App keine Genres, erscheinen die Wünsche unter „Unbekannt“ – alles andere funktioniert weiter.
