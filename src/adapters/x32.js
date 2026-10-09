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

// Simulierter X32: haelt Fader-Zustaende und simuliert Mics und Pegel.
export class MockX32 {
  constructor() {
    this.kind = 'mock';
    this.levels = { 1: 1, 2: 1 };
    this.mics = [0, 1, 2].map((i) => ({ id: i + 1, name: settings().x32.micNames?.[i] || `Mic ${i + 1}`, open: false, level: 0 }));
  }
  async setPlayerLevel(player, amp) { this.levels[player] = amp; }
  simulateMic(i, open) { if (this.mics[i]) this.mics[i].open = !!open; }
  async readState(playing) {
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
      try { const res = await fetch(urls[i] + path, { ...init, signal: AbortSignal.timeout(1500) }); this.idx = i; return res; } catch (e) { last = e; }
    }
    throw last;
  }
  async setPlayerLevel(player, amp) {
    const ch = settings().x32.channels[`p${player}`];
    try {
      const res = await this._fetch('/x32/level', {
        method: 'POST', headers: this._headers(),
        body: JSON.stringify({ player, channels: ch, fader: ampToFader(amp) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.ok = true; this.error = null; this.lastOk = Date.now();
    } catch (e) { this.ok = false; this.error = e.message; throw e; }
  }
  // Kanalzuordnung kommt aus dem Admin und wird dem Relay mitgeteilt (Relay-.env ist nur der Startwert)
  async _pushConfig() {
    const c = settings().x32.channels;
    const key = JSON.stringify(c);
    if (key === this.sentKey && Date.now() - this.sentAt < 30000) return;
    const res = await this._fetch('/x32/config', { method: 'POST', headers: this._headers(), body: JSON.stringify({ p1: c.p1, p2: c.p2, mics: c.mics }) });
    if (res.ok) { this.sentKey = key; this.sentAt = Date.now(); }
  }
  async readState() {
    try {
      await this._pushConfig().catch(() => {}); // aeltere Relays kennen /x32/config nicht - dann gilt deren .env
      const res = await this._fetch('/x32/state', { headers: this._headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = await res.json();
      this.ok = true; this.error = null; this.lastOk = Date.now();
      return {
        mics: (s.mics || []).slice(0, 3).map((m, i) => ({ id: i + 1, name: settings().x32.micNames?.[i] || `Mic ${i + 1}`, open: !!m.open, level: Number(m.level) || 0 })),
        meters: { 1: Number(s.meters?.[1]) || 0, 2: Number(s.meters?.[2]) || 0 },
      };
    } catch (e) { this.ok = false; this.error = e.message; throw e; }
  }
  health() { return { ok: this.ok, detail: this.ok ? 'Pi/X32 verbunden' : (this.error || 'keine Verbindung') }; }
}
