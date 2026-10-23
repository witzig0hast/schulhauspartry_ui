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
| `/prep` | Technik, Admin | **Vorbereitung**: Checkliste mit Live-Prüfungen und Testknöpfen (Fader, Player, Alarm, Backup) |
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
6. **Priorisieren** („Prio“) schiebt einen Song in die nächsten N Songs (Standard 3), markiert mit dem Code des Priorisierenden.
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

### Live-Test (Admin → Technik → Live-Test)

Spielt vor der Party **jede Funktion mit dem echten Setup** durch – Schritt für Schritt, die App löst aus, misst und fragt nur, wo ein Mensch hinhören muss:
Pegel einstellen → Verbindungen (Spotify-Suche, Player mit Gerät, Pi, X32) → Player 1 und 2 (Spotify-Status + Pegel am Pult) → Fader am Pult →
Wunsch vom Handy (QR-Code der Test-Gäste-Seite) → Annehmen in der Moderation → Beamer → Crossfade zum Wunsch → automatischer Übergang (springt kurz vor Songende) →
Mikrofone & Ducking → Not-Aus → Notfall-Playlist → Alarm aufs Handy → Backup. Fehlgeschlagene Schritte lassen sich nach dem Beheben wiederholen, jeder Schritt
kann übersprungen werden. Während des Tests hat der Testmodus die echten Verbindungen (die Live-Daten bleiben unberührt), danach wird automatisch zurückgestellt –
auch nach einem Neustart mitten im Test. Das Ergebnis steht in der Vorbereitung (`/prep`).
Unterschied zur **Generalprobe:** die simuliert viele Gäste (Last), der Live-Test prüft die echten Geräte.

### Pegel-Fenster (Technik → Pegel)

Zuerst Fader und Lautstärken einstellen: Grundpegel der Player-Fader am X32 (Stellung bei voller Lautstärke, in dB), Spotify-Lautstärke je Player,
optional die Mic-Fader, Fader-Obergrenze, Ducking-Absenkung und Crossfade-Dauer. Jede Änderung gilt sofort; „Testmusik“ spielt einen Song in voller
Grundlautstärke zum Einpegeln, „Abbrechen“ stellt die vorherigen Werte wieder her. Das Fenster öffnet sich beim ersten Aufruf der Technik-Ansicht
(wenn die Pegel seit 10 Stunden nicht bestätigt wurden), ist der erste Schritt des Live-Tests, und die Werte werden beim Start der Start-Playlist erneut gesetzt.

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
2. Client ID/Secret im Admin unter **Spotify-Apps** eintragen (oder per `.env`).
3. Player 1 und Player 2 mit je einem **Premium**-Account verbinden, jeweils ein Wiedergabegerät (Spotify Connect) wählen,
   dessen Audio in den X32 geht.

**Mehrere Spotify-Apps:** Unter *Spotify-Apps* lassen sich bis zu 8 Apps eintragen (jede mit derselben Redirect-URI im Dashboard).
Jede App hat ihr **eigenes** Anfrage-Limit. Die Gäste-Suche verteilt sich auf alle Apps mit Haken „Für die Gäste-Suche mitnutzen“
(die mit dem meisten Spielraum zuerst, bei `429` springt automatisch die nächste ein). Jeder Player wird **über eine bestimmte App** verbunden
und bleibt bei ihr – so können Player 1 und 2 verschiedene Apps nutzen (praktisch, weil eine App im Entwicklungsmodus nur wenige Konten erlaubt),
und eine App ohne Such-Haken gehört ganz dem Player. Wird eine App entfernt oder ihre Client-ID geändert, wird der zugehörige Player getrennt.
Eine bisher eingetragene einzelne App wird beim Update automatisch zur ersten App der Liste.

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

- **Sperren** (Moderation, Technik, Admin): bei jedem Wunsch „Sperren“ → *Song* oder *Interpret*. Gesperrt = Gäste sehen „nicht möglich“,
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

## KI über Ollama (Admin → Technik → KI)

Die App nutzt einen **eigenen Ollama-Server** mit **einem** Modell. Einrichten: Ollama-Adresse (z. B. `http://192.168.178.50:11434`), optional ein
Token (falls Ollama hinter einem geschützten Reverse-Proxy steht), „Modelle laden“, Modell wählen, „KI einschalten“, „Verbindung testen“.
Es gehen nur Songdaten (Titel, Interpret, Jahr, Genres) und der Technikzustand an die KI – keine Gästedaten, keine Passwörter oder Tokens.
Antworten kommen als JSON nach festem Schema und werden geprüft, bevor die App sie verwendet; die KI schlägt vor, übernommen wird per Knopf.

- **Energie-Kurve** (Technik → KI-Assistent → „Reihenfolge vorschlagen“): Stimmung und Energie (1–10), Empfehlung und eine neue Reihenfolge der
  Warteschlange (Steigerung, keine doppelten Interpreten, sanfte Genrewechsel, Wünsche vor Füllsongs); priorisierte Songs bleiben vorne. „Übernehmen“ ordnet um.
- **Lückenfüller** („Songs vorschlagen“): passende Songs zu den letzten Wünschen; jeder Vorschlag wird bei Spotify nachgeschlagen (nur echte Songs,
  nichts Gesperrtes oder schon Gespieltes) und per Knopf eingereiht. Optional füllt die KI eine leere Warteschlange selbst auf (höchstens alle 2 Minuten).
- **Licht-Vorschläge**: für den laufenden und die nächsten fünf Songs im Hintergrund – Farben, Tempo/BPM, Intensität, Strobo-Empfehlung, Effekte und ein
  Tipp; erscheinen im Licht-Dashboard und werden pro Song gespeichert.
- **Fehler-Assistent** („Was ist los?“ in Technik, Vorbereitung und Ton-Dashboard): wertet Verbindungen, Fehlerliste, Prüfliste und den letzten
  Live-Test aus und nennt Ursachen mit konkreten Schritten; optional mit eigener Frage.
- **Rückblick** (Bericht & Export → „Rückblick schreiben“): ein Text für die Gäste (Homepage/Instagram) und eine Auswertung fürs Team.

Alles einzeln unter Funktionen (Gruppe „KI“). Anfragen laufen nacheinander (ein lokales Modell schafft meist nur eine gleichzeitig), höchstens 12 pro Person
und Minute. Modell-Tipp: für deutsche Texte und sauberes JSON z. B. Qwen 2.5/3 oder Llama 3.1 ab 7–8 B Parametern.

## Live-Protokoll (`/logs`, Technik und Admin)

Ein Protokoll über alles, was passiert – **zweimal lesbar**:
- **Mensch:** Uhrzeit, Bereich, ein verständlicher Satz und wer es war („Angenommen: Uptown Funk → Player 1 · Mia“, „Mic 1 offen“, „Spotify-Limit erreicht – Pause 7 s“).
- **Maschine:** Zeitstempel, Level, fester Ereignisname (`request.approved`, `control.play`, `spotify.rate_limited`, `ai.energy` …) und die Rohdaten als JSON.
  Ein Klick auf einen Eintrag zeigt das komplette JSON (farbig, kopierbar); „{ } Maschine“ schaltet die ganze Liste auf die technische Zeilenansicht.

Filter: Umgebung (Live/Test/System), ab welchem Level (Alles/Info/Warnungen/Fehler), Bereiche (Wünsche, Moderation, Wiedergabe, Pult & Mics, Spotify, KI,
Verbindungen, Companion, Admin, Sicherheit, System) und Volltextsuche (auch in den Daten). Neue Einträge kommen live oben dazu, „Anhalten“ friert die Liste ein.
Export als JSONL (eine JSON-Zeile pro Eintrag, z. B. für `jq`).

Erfasst werden u. a.: Wünsche (neu, +1, abgewiesen mit Grund), Moderation (angenommen/abgelehnt/vorgezogen/entfernt, mit Person), jeder Technik-Knopf, Übergänge,
Lückenfüller, Not-Aus/Notfall/Ende, Mikrofone und Ducking, Verbindungen (sofort bei jedem Wechsel), Spotify-Limits und -Fehler, jede KI-Anfrage mit Dauer und Antwort,
Companion-Tasten, Einstellungen, Anmeldungen, Sperren, Backups und Benachrichtigungen. Mit „Debug-Einträge erzeugen“ zusätzlich jede einzelne Spotify-Anfrage
(Methode, Pfad, Status, Dauer, Budget) – nur im Speicher.

Datenschutz: eigene Datei `logs.db` (nicht in den Backups, Standard 14 Tage), Gäste nur als Kürzel („Gast e928f“, gleiches Handy = gleiches Kürzel), Felder wie
Token/Passwort werden immer als `***` gespeichert. Anmeldungen und IP-Adressen (Bereiche Sicherheit/Admin) sieht nur der Admin. Während der Generalprobe laufen deren
tausende Gäste-Einträge nur im Speicher mit.

## Companion / Stream Deck (Admin → Verbindungen)

Echte Tasten über Bitfocus Companion, Modul „Generic HTTP“: „Token erzeugen“, dann pro Taste `POST <Adresse>/api/companion/action/<aktion>` mit Header
`{"Authorization": "Bearer <Token>"}`. Aktionen: `crossfade` (optional `?sec=6`), `panic` (zweimal innerhalb von 4 s), `panic-clear`, `play-1/2`, `pause-1/2`,
`fade-in-1/2`, `fade-out-1/2`, `wishes-open/pause/close`, `pause-mode`, `auto-toggle`, `ducking-toggle`, `emergency`, `end`.
`GET <Adresse>/api/companion/state` liefert JSON für Tasten-Anzeigen (Titel, Countdown bis zum Übergang, Wunsch-Status, Not-Aus scharf …).
Das Token wird nur als Hash gespeichert; ein neues Token macht das alte ungültig. Testmodus: dieselben Pfade unter der Test-Adresse.

## Weitere KI-Funktionen

- **Genres nachtragen:** Liefert Spotify für einen Song keine Genres (häufig bei neueren Apps), ordnet die KI ihn aus einer festen Genre-Liste ein (im Licht-Dashboard mit „KI“ markiert).
- **Wunsch-Zusammenfassung** (Moderation → „Zusammenfassen“): Überblick über die offenen Wünsche, größte Gruppen, was man genauer ansehen sollte, womit anfangen.
- **Stimmungs-Warnung:** Alle 10 Minuten, solange Musik läuft, prüft die KI Wunsch-Tempo, Ablehnungen, zuletzt gespielte Songs und Warteschlange. Kippt die
  Stimmung (mittel/hoch), kommt eine Meldung **nur per ntfy** aufs Handy (Automatik → Alarm aufs Handy → „KI: Stimmung kippt“).

## Technik-Ansicht

Aufgebaut nach dem, was man am Pult zuerst braucht: oben eine Statusleiste (Spotify, Player, X32, Wünsche, Mics, Auto-Crossfade und Ducking zum Antippen),
darunter beide Player mit Cover, ON-AIR-Markierung, Pegel am Pult und Fader (immer sichtbar), dann Übergang mit Countdown bis zum nächsten Auto-Crossfade
und der Betrieb. **Crossfade und Not-Aus sind unten immer sichtbar**, auch beim Scrollen durch die Wünsche. Dunkel als Standard (am Pult ist es dunkel);
umschaltbar oben rechts. Das Menü „Ansichten“ ist nach Dashboards, Arbeiten, Bildschirmen für Gäste und Auswertung gruppiert.

## Abteilungs-Dashboards (Ton, Licht, Bühne, Orga)

Fertige Ansichten zum Ansehen, oben mit einer Leiste zum Wechseln zwischen den Abteilungen:
- **Ton** (`/ton`): beide Player mit Cover, ON AIR, Fortschritt, Fader-Stellung (in % und dB) und Pegel am Pult, Grundpegel und Spotify-Lautstärke,
  Countdown bis zum nächsten Übergang, Mikrofone mit Pegel und Ducking, die nächsten Songs mit Player, Startzeit und Hinweisen (langes Intro, Explicit),
  Verbindungen und letzte Fehler, Warnungen (Not-Aus, Notfall, Pause, Ducking aktiv) ganz oben.
- **Licht** (`/light`): jetzt mit Album-Cover, Genres, Jahr, Countdown bis zum Übergang, nächste Songs mit Cover, Startzeit und Genrewechsel.
- **Bühne** (`/stage`): für die Leute am Mikro – jetzt (mit Cover), Nächster, Uhr, Zeitplan, Mics.
- **Orga** (`/orga`): große Uhr, Zeitplan mit Countdown, Gäste online, offene/angenommene/gespielte Wünsche, Stand der Wünsche (Freischaltung, Pause),
  Orga-Hinweis, Übergabe-Notiz, Umfrage, Team online und Team-Chat.

**Startansicht pro Code:** Admin → Codes → „Startansicht“ (beim Anlegen oder später in der Liste). Ein Technik-Code für die Tonleute landet so
direkt im Ton-Dashboard, einer für das Licht im Licht-Dashboard. Angeboten wird nur, was die Rolle öffnen darf. Gilt auch für Passkey- und SSO-Login.

## Album-Cover

Spotify liefert zu jedem Song ein Cover. Der Server lädt es **einmal** von Spotifys Bildserver (`i.scdn.co`, nur von dort) und merkt es sich; danach kommt
es aus dem Speicher (`/cover/<track-id>`). Die Handys der Gäste sprechen dabei nie direkt mit Spotify, die strenge CSP bleibt. Geladen wird nur für Songs,
die die App schon kennt (Wunsch, Suche, laufender Song). Ohne Cover (Simulation, Fehler) erscheinen wie bisher die farbigen Initialen. Schalter: Funktionen → „Album-Cover“.

## Gespeicherte Spotify-Antworten

Was einmal bei Spotify abgefragt wurde, wird **dauerhaft** gespeichert (eigene Datei `cache.db` im Datenordner, nicht in den Backups) und nicht erneut angefragt –
auch nicht nach einem Neustart: Songs und Genres der Interpreten 30 Tage, Suchtreffer 12 Stunden, Playlists 1 Stunde, Intro-/Outro-Analysen 30 Tage, Cover dauerhaft.
Sucht die Moderation oder ein Gast etwas, das schon einmal gesucht wurde, oder wird ein schon bekannter Song gewünscht, geht keine Anfrage an Spotify.
Ist Spotify im Limit, antwortet notfalls auch ein abgelaufener Eintrag. Die eigenen Auswertungen (`/api/stats`, `/api/analytics`) werden ebenfalls gemerkt und nur
neu berechnet, wenn sich an den Wünschen etwas geändert hat (sonst höchstens alle 15 s), auch wenn viele Dashboards gleichzeitig offen sind.
Admin → Verbindungen zeigt, was gespeichert ist und wie viele Abfragen dadurch gespart wurden („Leeren“ löscht den Speicher).

## Spotify-Rate-Limits

Spotify begrenzt die Web-API pro App (gleitendes ~30-Sekunden-Fenster, bei Überschreitung `429` mit `Retry-After`). Das Limit lässt sich nicht
abschalten – die App ist deshalb so gebaut, dass sie es praktisch nie erreicht und sauber reagiert, falls doch:

- **Weniger Aufrufe:** Suchergebnisse 10 Min. im Speicher, gleiche gleichzeitige Suchen werden zu **einem** Aufruf zusammengefasst, Suchtreffer füllen
  den Song-Cache (der Wunsch danach braucht keinen weiteren Aufruf), Interpreten-Genres werden gebündelt geholt und gemerkt.
- **Player-Status sparsam:** mitten im Song alle ~6 s (die Position wird zwischendurch selbst hochgerechnet), kurz vor Songende und nach Befehlen ~1 s,
  bei Pause/leer ~8 s.
- **Budget pro App** (Admin → Verbindungen, Standard 60 Anfragen/30 s) mit Vorrang: Steuerbefehle (Play/Pause/Queue) > Player-Status > Suche.
  Mit mehreren Apps hat jede ihr eigenes Budget (siehe „Mehrere Spotify-Apps“).
- **Bei `429`:** alle unkritischen Anfragen ruhen bis `Retry-After` vorbei ist, Gäste bekommen „Spotify macht kurz Pause“ (und die Suche wiederholt sich
  von selbst), Steuerbefehle warten und werden automatisch wiederholt, der Player-Status bleibt auf dem letzten Stand (kein „getrennt“).
- Anzeige der Auslastung im Admin und in der Verbindungsampel (gelb bei Pause).

## Automatik (Admin → Automatik)

- **Auto-Ordnung:** Die Warteschlange sortiert sich selbst sanft um – *Genre-Balance* (höchstens N gleiche Genre-Familien am Stück) und *Stimmungskurve*
  (zu bestimmten Uhrzeiten werden Genres bevorzugt; es wird nie etwas abgelehnt). Priorisierte Songs bleiben exakt auf ihrem Platz, Fairness-Fenster begrenzt das Vordrängeln.
- **Lückenfüller:** Ist die Warteschlange leer, während Musik läuft, reiht die App automatisch einen Song aus einer Playlist ein (keine Wiederholungen, keine gesperrten Songs).
  Hinweis: Spotify erlaubt für neuere Apps teils keinen Zugriff auf von Spotify kuratierte Playlists – eine eigene Playlist funktioniert immer.
- **Smarter Übergang:** Der Auto-Crossfade beginnt, wenn der Song ausklingt (Intro-/Outro-Zeiten aus Spotify, soweit für eure App verfügbar; sonst feste Vorlaufzeit).
- **Notfall-Playlist:** Knopf in Technik/Board stoppt alles und startet die eingestellte Playlist gemischt.
- **Alarm aufs Handy (ntfy):** meldet X32/Pi-Ausfall, Spotify-Probleme, getrennte Player, Not-Aus, leere Warteschlange, Notfall und fehlgeschlagene Backups –
  erst nach einer einstellbaren Störungsdauer, mit „wieder in Ordnung“-Meldung. Funktioniert mit ntfy.sh und eigenem ntfy-Server (Topic, optional Token).
- **Backups:** Datenbank wird regelmäßig (und vor jedem Live-Reset) in `/data/backups` gesichert, Download im Admin.
  Wiederherstellen: Backup als `party.db` ins Datenverzeichnis legen, App neu starten.
- **Zeitzone:** `TZ=Europe/Berlin` im Compose und Einstellung „Zeitzone der Party“ (für die Stimmungskurve).

## Moderation im Team

- **Später:** Wunsch zurückstellen; Reiter *Später*. Gäste sehen weiter „wartet“.
- **Tastenkürzel:** frei einstellbar pro Gerät (Knopf „Tasten“ in Moderation und Fokus-Modus): annehmen, ablehnen, später, sperren, Gründe 1–9, Vollbild.
- **Team-Chat:** Name ist Pflicht (wird pro Gerät gemerkt); in Moderation, Technik und als Board-Baustein.
- **Mehrere Geräte:** „● n online“ und „Lisa bearbeitet gerade …“ – erster Klick gewinnt weiterhin serverseitig.
- **Gleich dran:** Gäste sehen auf ihrem Handy „Dein Song ist als Nächstes dran!“ (mit Vibration).

## Design

Admin → *Design*: Veranstaltungsname, Untertitel, Logo (PNG/JPG/WebP/SVG ohne Skripte) und Akzentfarbe – wirkt auf Gäste-Seite, Beamer, Poster, Moderation und PDF.
**Setlist als PDF:** Admin → Bericht & Export.

## Funktionen ein-/ausschalten (nur Admin)

Admin → **Funktionen**: Jede Ansicht, jede Funktion und jeder Effekt (Animationen, Konfetti, Beamer-Effekte, Töne …) hat einen eigenen Schalter. Ausgeschaltetes ist serverseitig gesperrt (404), nicht nur versteckt. Neue Ansichten: Licht (`/light`, eigene Rolle „Lichttechnik" nur lesen), Bühne (`/stage`), Zeitplan (`/schedule`), Verlauf (`/activity`), Wunsch-Charts (`/charts`), Playlist des Abends (`/wall`) und der Party-Rückblick (geheimer Link, Admin → Start).

Neue Funktionen: Wunsch-Voting, Live-Umfragen, Gast-Geräte sperren, Pausen-Modus, Stimmungs-Knopf, Übergabe-Notiz, Lautstärke-Merker pro Song, Fader-Limit, Song-Bremse, Flut-Alarm.

## Sicherheit

* **Passkeys** (Fingerabdruck/Gesicht/Geräte-PIN) für Admin und alle Codes: Schlüssel-Knopf in der Kopfzeile, Verwaltung unter Admin → Sicherheit. Bei Aussperrung: Server mit `ADMIN_RECOVERY=1` starten (Passwort-Login wieder erlaubt).
* Optional: Admin-Login nur per Passkey, Admin nur von bestimmten IP-Adressen/Netzen, Sitzungs-Timeouts, Abmelden einzelner Geräte, Passwort ändern, Sicherheitsprotokoll, Flut-Alarm per ntfy.
* Schutz vor Überlastung (Grenzen pro Adresse/Gerät, Sperre bei Dauerfeuer) und Cloudflare-Einrichtung: siehe docs/SECURITY.md.
* `__Host-`-Cookies unter HTTPS, CSRF-Prüfung (Origin + Sec-Fetch-Site), Rate-Limits pro IP, gehashte Codes/Sitzungen.

## Single Sign-On (SSO, z. B. Authentik)

Admin → Sicherheit → **Single Sign-On**. Per OpenID Connect (Authorization-Code-Flow mit PKCE, ID-Token wird auf Signatur, Aussteller, Zielgruppe, Ablauf und nonce geprüft). Auf der Login-Seite erscheint dann „Mit SSO anmelden".

1. In Authentik eine Anwendung mit **OAuth2/OpenID-Provider** anlegen: Client-Typ „Vertraulich", Redirect-URI `https://<deine-domain>/api/sso/callback` (Modus „Strikt"), Scopes `openid profile email`.
2. Client-ID, Client-Secret und die Issuer-URL (`…/application/o/<slug>/`) im Admin eintragen (`PUBLIC_URL` muss gesetzt sein). Das Secret kann auch per `SSO_CLIENT_SECRET` in der `.env` stehen.
3. Unter „Gruppen → Rollen" Authentik-Gruppen den Rollen zuordnen (Technik, Moderation, Orga, Licht, FOH). Ohne passende Gruppe gibt es keinen Zugang (oder die eingestellte Standardrolle).
4. **Admin per SSO** ist standardmäßig aus; wenn erlaubt, sind SSO-Admins nicht der Head-Admin (kein VPN, kein Passwort ändern) und unterliegen der Admin-IP-Liste.

SSO-Konten erscheinen unter Codes mit „SSO", können dort gesperrt oder gelöscht werden und haben eigene Namen in der Entscheidungs-Statistik. Die Rolle wird bei jeder Anmeldung aus den Gruppen neu gesetzt. Eine Abmeldung im Identity-Provider beendet bestehende Sitzungen der App nicht sofort: sie enden nach der Inaktivitäts-/Maximaldauer (Admin → Sicherheit) oder per „Abmelden" in der Sitzungsliste.

## Betriebsart: Normalbetrieb oder nur Wunschliste (mit DJ)

Admin → Start → **Betriebsart**. *Normalbetrieb*: die App spielt (Spotify-Player, Warteschlange, Crossfade, X32). *Nur Wunschliste*: Wünsche werden nur angenommen oder abgelehnt, ein DJ spielt selbst. Dann sind Player-Steuerung, Crossfade, Pult-Anbindung, Auto-Sortierung und Hardware-Alarme aus. Die neue Rolle **DJ** (Codes → Rolle „DJ") hat die Ansicht `/dj`: angenommene Wünsche als Arbeitsliste mit „Läuft jetzt" und „✓ Gespielt" („Zurück“ bei Versehen). Die Markierungen erscheinen bei den Gästen („Jetzt läuft"), im Beamer, in der Setlist und im Bericht. Der DJ darf auch Wünsche annehmen/ablehnen; Moderation und Technik dürfen mitmarkieren. Beim Wechsel in den Wunschlisten-Modus werden laufende Player angehalten.

## Bestehende Zugänge mit SSO verbinden

SSO muss kein neues Konto anlegen:
- **Selbst verbinden:** eingeloggt (Code oder Passwort) auf den Schlüssel-Knopf oben → „Mit SSO verbinden". Danach führt die SSO-Anmeldung auf genau diesen Zugang (gleiche Rolle, gleicher Verlauf, auch ohne Gruppenzuordnung). Der Head-Admin verbindet seinen Zugang genauso. Ein SSO-Konto kann nur mit einem Zugang verbunden sein.
- **Per E-Mail:** Admin → Codes → „E-Mail“ (E-Mail der Person eintragen) und in der SSO-Karte „Bestehende Zugänge automatisch per E-Mail verbinden" einschalten. Es zählt nur eine vom Anbieter bestätigte E-Mail.
- **Keine neuen Konten:** In der SSO-Karte „Neue Konten automatisch anlegen" ausschalten, dann kommen nur verbundene Zugänge per SSO hinein.
- Der Admin kann Verbindungen unter Codes lösen („SSO lösen"). Gesperrte Zugänge bleiben auch per SSO gesperrt; für den Head-Admin gelten weiter IP-Liste und „Admin nur mit Passkey".

## Abend-Start: Start-Playlist und Freischaltung der Wünsche

Admin → Automatik → **Abend-Start**.
- **Wünsche freischalten:** Mit „Wünsche sind zu, bis sie freigeschaltet werden" bleiben die Wünsche geschlossen (Gäste sehen den Hinweistext mit Uhrzeit und Countdown). Sie öffnen zur eingestellten Uhrzeit (z. B. 18:00) automatisch oder sofort per Knopf („Wünsche jetzt freischalten" in Technik und Admin → Start). Die Moderation sieht einen Hinweis.
- **Start-Playlist:** Eine Playlist (Link/ID), die zum Auftakt läuft: Technik → „Start-Playlist starten" (oder automatisch zur Startzeit). Die App hält mindestens N Songs in der Warteschlange, solange noch kein Wunsch angenommen wurde; danach übernimmt der normale Lückenfüller. Angenommene Wünsche kommen immer **vor** die automatisch eingereihten Songs (und in Annahme-Reihenfolge).
- Beides ist einzeln unter Funktionen schaltbar. Im Wunschlisten-Modus (mit DJ) gilt nur die Freischaltung.
