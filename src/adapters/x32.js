import { settings, piToken } from '../settings.js';

// Amplitude (0..1, 1 = 0 dB) -> X32-Fader-Float (0..1, 0.75 = 0 dB)
export function ampToFader(amp) {
  const db = amp <= 0.00003 ? -90 : 20 * Math.log10(amp);
  let f;
  if (db < -60) f = (db + 90) / 480;
  else if (db < -30) f = (db + 70) / 160;
  else if (db < -10) f = (db + 50) / 80;
  else f = (db + 30) / 40;
  return Math.max(0, Math.min(1, f));
}

const SEND_GAP_MS = 125;
// Wie schnell die Motorfader fahren duerfen (ganzer Weg pro Sekunde): sanft schont den Motor, schnell folgt kurzen Blenden genauer
export const FADER_SPEEDS = { sanft: 0.6, normal: 1.2, schnell: 3 };
const faderSpeed = () => FADER_SPEEDS[settings().x32.faderSpeed] || FADER_SPEEDS.normal;

// Umkehrung: X32-Fader-Float -> Amplitude (fuer Fades, die am Fader gleichmaessig laufen)
export function faderToAmp(f) {
  f = Math.max(0, Math.min(1, Number(f) || 0));
  if (f <= 0) return 0;
  const db = f < 0.0625 ? f * 480 - 90 : f < 0.25 ? f * 160 - 70 : f < 0.5 ? f * 80 - 50 : f * 40 - 30;
  return Math.pow(10, db / 20);
}

// Simulierter X32: haelt Fader-Zustaende und simuliert Mics und Pegel.
export class MockX32 {
  constructor() {
    this.kind = 'mock';
    this.levels = { 1: 1, 2: 1 };
    this.mics = [0, 1, 2].map((i) => ({ id: i + 1, name: settings().x32.micNames?.[i] || `Mic ${i + 1}`, open: false, level: 0 }));
  }
  async setPlayerLevel(player, amp) { this.levels[player] = amp; }
  async setChannelFader(ch, fader) { (this.faders ||= {})[ch] = fader; }
  simulateMic(i, open) { if (this.mics[i]) this.mics[i].open = !!open; }
  // Einrichtung im simulierten Modus: erfundene Kanalnamen, Pegel auf den zugeordneten Kanaelen
  async channels() {
    const c = settings().x32.channels, names = { [c.p1[0]]: 'Laptop1 L', [c.p1[1]]: 'Laptop1 R', [c.p2[0]]: 'Laptop2 L', [c.p2[1]]: 'Laptop2 R' };
    c.mics.forEach((ch, i) => { names[ch] = `Funk ${i + 1}`; });
    const on = this.playing || {};
    const lvl = (ch) => (c.p1.includes(ch) ? (on[1] ? this.levels[1] * 0.5 : 0) : c.p2.includes(ch) ? (on[2] ? this.levels[2] * 0.4 : 0) : c.mics.includes(ch) ? (this.mics[c.mics.indexOf(ch)]?.open ? 0.5 : 0.01) : 0);
    return { ok: true, simulated: true, channels: Array.from({ length: 32 }, (_, i) => ({ channel: i + 1, name: names[i + 1] || '', level: lvl(i + 1), on: true, fader: (this.faders || {})[i + 1] ?? null, manual: false })) };
  }
  async selectChannel() {}
  async setMute(player, muted) { (this.mutes ||= {})[player] = !!muted; }
  async readState(playing) {
    this.playing = playing;
    this.mics.forEach((m, i) => { m.name = settings().x32.micNames?.[i] || `Mic ${i + 1}`; });
    for (const m of this.mics) m.level = m.open ? 0.35 + Math.random() * 0.4 : Math.random() * 0.02;
    const meter = (p) => (playing[p] ? Math.min(1, this.levels[p] * (0.55 + Math.random() * 0.35)) : 0);
    return { mics: this.mics.map((m) => ({ ...m })), meters: { 1: meter(1), 2: meter(2) } };
  }
  health() { return { ok: true, detail: 'X32 (simuliert)' }; }
}

// Spricht mit dem Relay auf dem Pi 5 (Companion/OSC) ueber HTTP:
//   POST {piUrl}/x32/level  {player, channels:[..], fader}  -> Fader setzen
//   GET  {piUrl}/x32/state  -> {mics:[{open,level}], meters:{1,2}}
export class HttpX32 {
  constructor() {
    this.kind = 'http'; this.ok = false; this.error = 'noch nicht verbunden'; this.lastOk = 0;
  }
  _headers() {
    const t = piToken();
    return { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
  }
  // Pi-URL darf mehrere Adressen enthalten (LAN und VPN, durch Komma getrennt): es wird die genommen, die gerade antwortet
  _urls() { return String(settings().x32.piUrl || '').split(/[\s,;]+/).map((u) => u.trim().replace(/\/$/, '')).filter((u) => /^https?:\/\//.test(u)); }
  async _fetch(path, init = {}) {
    const urls = this._urls();
    if (!urls.length) throw new Error('Pi-URL fehlt');
    this.idx = (this.idx || 0) % urls.length;
    let last;
    for (let k = 0; k < urls.length; k++) {
      const i = (this.idx + k) % urls.length;
      try { const res = await fetch(urls[i] + path, { signal: AbortSignal.timeout(1500), ...init }); this.idx = i; return res; } catch (e) { last = e; }
    }
    const why = last?.name === 'TimeoutError' ? 'keine Antwort' : (last?.cause?.code || last?.message || 'Fehler');
    throw new Error(`Pi nicht erreichbar (${urls.join(', ')}: ${why})`);
  }
  // Fader schonen: pro Player hoechstens ein Befehl unterwegs (Reihenfolge bleibt erhalten, nichts ueberholt sich im VPN),
  // hoechstens 8 Befehle pro Sekunde, gleiche Werte nicht doppelt. Das Relay faehrt die Werte dann sanft an.
  // instant = Not-Aus: sofort und ohne Gleiten.
  setPlayerLevel(player, amp, { instant = false } = {}) {
    const q = ((this.q ||= {})[player] ||= { want: null, sent: null, last: 0, run: null, instant: false });
    q.want = Math.round(ampToFader(amp) * 1023) / 1023;
    if (instant) q.instant = true;
    if (!q.run) q.run = this._drain(player, q).finally(() => { q.run = null; });
    return q.run;
  }
  async _drain(player, q) {
    while (q.want !== q.sent || q.instant) {
      const instant = q.instant;
      const wait = q.last + SEND_GAP_MS - Date.now();
      if (wait > 0 && !instant) await new Promise((r) => setTimeout(r, wait));
      const fader = q.want, ch = settings().x32.channels[`p${player}`];
      q.instant = false;
      try {
        const res = await this._fetch('/x32/level', {
          method: 'POST', headers: this._headers(),
          body: JSON.stringify({ player, channels: ch, fader, speed: faderSpeed(), ...(instant ? { instant: true } : {}) }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        q.sent = fader; q.last = Date.now();
        this.ok = true; this.error = null; this.lastOk = Date.now();
      } catch (e) { q.last = Date.now(); this.ok = false; this.error = e.message; throw e; }
    }
  }
  // Einzelner Kanal (Mic-Fader aus dem Pegel-Fenster); das Relay kennt das schon ueber /x32/level ohne Player-Angabe
  async setChannelFader(ch, fader) {
    const res = await this._fetch('/x32/level', { method: 'POST', headers: this._headers(), body: JSON.stringify({ channels: [ch], fader: Math.max(0, Math.min(1, fader)), speed: faderSpeed() }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
  // Kanaele eines Players stumm schalten / wieder freigeben (X32: /ch/NN/mix/on)
  async setMute(player, muted) {
    const res = await this._fetch('/x32/mute', { method: 'POST', headers: this._headers(), body: JSON.stringify({ channels: settings().x32.channels[`p${player}`], muted: !!muted }) });
    if (res.status === 404) throw new Error('Das Relay auf dem Pi ist zu alt für Stummschalten – auf dem Pi aktualisieren.');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
  // Fuer die Einrichtung: Namen/Pegel aller Kanaele vom Pult, Kanal am Pult anwaehlen
  async channels() {
    const res = await this._fetch('/x32/channels', { headers: this._headers(), signal: AbortSignal.timeout(4000) });
    if (res.status === 404) throw new Error('Das Relay auf dem Pi ist zu alt für die Einrichtung – auf dem Pi aktualisieren (git pull, docker compose up -d --build).');
    if (!res.ok) throw new Error(`Relay antwortet mit ${res.status}`);
    return res.json();
  }
  async selectChannel(channel) {
    const res = await this._fetch('/x32/select', { method: 'POST', headers: this._headers(), body: JSON.stringify({ channel }) });
    if (!res.ok) throw new Error(`Relay antwortet mit ${res.status}`);
  }
  // Kanalzuordnung kommt aus dem Admin und wird dem Relay mitgeteilt (Relay-.env ist nur der Startwert)
  // Ebenso die X32-Adresse: leer = das Relay nimmt wieder die aus seiner .env
  async _pushConfig(force = false) {
    const x = settings().x32, c = x.channels;
    const body = { p1: c.p1, p2: c.p2, mics: c.mics, host: x.host || '', port: x.port || 10023 };
    const key = JSON.stringify(body);
    if (!force && key === this.sentKey && Date.now() - this.sentAt < 30000) return;
    const res = await this._fetch('/x32/config', { method: 'POST', headers: this._headers(), body: key });
    if (res.ok) { this.sentKey = key; this.sentAt = Date.now(); }
    else if (res.status === 400) throw new Error('Das Relay hat die X32-Einstellungen abgelehnt (Adresse/Kanäle prüfen).');
  }
  // X32/M32 im Netz des Pi suchen (das Relay schickt /xinfo per Broadcast)
  async discover() {
    const res = await this._fetch('/x32/discover', { method: 'POST', headers: this._headers(), signal: AbortSignal.timeout(5000) });
    if (res.status === 404) throw new Error('Das Relay auf dem Pi ist zu alt für die Suche – auf dem Pi aktualisieren (git pull, docker compose up -d --build).');
    if (res.status === 429) throw new Error('Die Suche läuft schon.');
    if (!res.ok) throw new Error(`Relay antwortet mit ${res.status}`);
    return (await res.json()).found || [];
  }
  async readState() {
    try {
      await this._pushConfig().catch(() => {}); // aeltere Relays kennen /x32/config nicht - dann gilt deren .env
      const res = await this._fetch('/x32/state', { headers: this._headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = await res.json();
      this.ok = true; this.error = null; this.lastOk = Date.now();
      this.desk = s.x32 || null;   // antwortet das Pult selbst? (vom Relay gemeldet)
      this.manual = Array.isArray(s.manual) ? s.manual : [];   // Kanaele, die gerade jemand von Hand bewegt hat
      this.hand = Array.isArray(s.hand) ? s.hand : [];         // letzte Handbewegung je Kanal (Wert, Alter, Nummer)
      return {
        mics: (s.mics || []).slice(0, 3).map((m, i) => ({ id: i + 1, name: settings().x32.micNames?.[i] || `Mic ${i + 1}`, open: !!m.open, level: Number(m.level) || 0 })),
        meters: { 1: Number(s.meters?.[1]) || 0, 2: Number(s.meters?.[2]) || 0 },
      };
    } catch (e) { this.ok = false; this.error = e.message; throw e; }
  }
  health() { return { ok: this.ok, detail: this.ok ? 'Pi/X32 verbunden' : (this.error || 'keine Verbindung') }; }
}
