# Sicherheit & Schutz vor Überlastung

Die App schützt sich selbst (Admin → Sicherheit → „Schutz vor Überlastung"). Gegen **echte Datenfluten (DDoS)** hilft das nur begrenzt, denn die kommen schon an deiner Leitung an. Dafür gehört der Schutz vor die App: Cloudflare und eine Firewall. So gehst du vor:

## 1. Cloudflare (die wichtigste Schicht)
- **Orange Wolke** (Proxy an) für die App-Domain. Nur `wg.…` (WireGuard) bleibt grau.
- **Sicherheit → WAF → Rate-Limiting-Regeln** (kostenloser Plan erlaubt eine): `/api/guest/*` → z. B. 100 Anfragen pro 10 Sekunden pro IP → Aktion „Blockieren" für 1 Minute. Und `/api/login`, `/api/passkey/*`, `/api/sso/*` → 20 pro Minute pro IP.
- **Sicherheit → Bots → Bot Fight Mode** an.
- **Bei laufendem Angriff:** Sicherheit → Einstellungen → Sicherheitsstufe „Under Attack Mode" (prüft jeden Besucher kurz im Browser). Parallel in der App den **Angriffsmodus** einschalten. Danach wieder aus.
- **Tipp zur Party:** Gäste kommen oft über dieselbe Schul-IP. Damit die Regeln nicht deine eigenen Gäste treffen, die Cloudflare-Grenzen großzügig wählen (z. B. 300 pro 10 s für `/api/guest/*`) und die Pro-Gerät-Grenzen der App für die Feinarbeit nutzen.

## 2. Server nur über Cloudflare erreichbar machen
Sonst umgehen Angreifer Cloudflare, indem sie direkt die Server-IP ansprechen:
- Router/Firewall: Ports **80/443** nur von den [Cloudflare-IP-Bereichen](https://www.cloudflare.com/ips/) erlauben, alles andere sperren (z. B. mit `ufw` oder der Fritz!Box-Freigabe nur für bekannte Quellen).
- Alternativ **Cloudflare Tunnel** (`cloudflared`): dann braucht der Server gar keinen offenen Port 80/443.
- **Authenticated Origin Pulls** (Cloudflare → SSL/TLS → Origin-Server): Nginx Proxy Manager akzeptiert nur Anfragen mit Cloudflare-Zertifikat.
- Die echte Server-IP nicht öffentlich machen (keine DNS-Einträge ohne Proxy außer `wg.`, kein E-Mail-Versand vom selben Server).
- Die App liest die echte Besucher-Adresse nur dann aus Weiterleitungs-Headern, wenn die Verbindung von einer **privaten** Adresse (Nginx Proxy Manager) kommt. Wer den Server direkt anspricht, kann sich nicht fremde Adressen geben (und damit Grenzen umgehen).

## 3. Nginx Proxy Manager (zusätzliche Bremse)
Beim Proxy Host → Advanced → Custom Nginx Configuration (z. B. 30 Anfragen/s pro IP, Burst 60) — in der `http`-Ebene (NPM: `/data/nginx/custom/http_top.conf`) einmalig:
```
limit_req_zone $binary_remote_addr zone=party:10m rate=30r/s;
limit_conn_zone $binary_remote_addr zone=partyconn:10m;
```
und im Proxy Host:
```
limit_req zone=party burst=60 nodelay;
limit_conn partyconn 200;
client_max_body_size 1m;
```
(Hinter Cloudflare muss `real_ip` auf die Cloudflare-Adressen konfiguriert sein, sonst zählt Nginx nur Cloudflare.)

## 4. Was die App selbst macht
- Grenzen pro Absender-Adresse (Seiten, Dateien, Gäste-API, schreibende Aufrufe), pro Gäste-Gerät, für neue Geräte (Cookie wegwerfen hilft nicht) und Wünsche pro Adresse.
- Live-Verbindungen (WebSocket): ohne Geräte-Cookie oder Anmeldung abgewiesen; Obergrenzen pro Adresse, Gerät und insgesamt; Nachrichtenflut beendet die Verbindung.
- Deckel für gleichzeitige Anfragen (angemeldetes Team bleibt bedienbar) und für offene Wünsche.
- Dauerfeuer führt zu einer automatischen **Sperre** (Standard 10 Min.), Meldung aufs Handy (ntfy). Angemeldetes Team kommt trotz Sperre auf die Team-API und kann im Admin entsperren.
- Zeitlimits gegen Slowloris, begrenzte Header, JSON-Größe, Fehlerantworten ohne interne Details.
- Anmelde-Versuche (Code, Passwort, Passkey, SSO) sind zusätzlich einzeln begrenzt; Sicherheitsprotokoll im Admin.

## 5. Checkliste vor der Party
1. Cloudflare: Proxy an, Rate-Limit-Regel + Bot Fight Mode an. 2. Server nur für Cloudflare erreichbar. 3. Admin-IP-Liste und „Admin nur mit Passkey" prüfen. 4. Backups an. 5. ntfy-Alarm an. 6. Im Admin → Sicherheit den Schutz kurz anschauen (keine Sperren, Grenzen passend für die erwartete Gästezahl).
