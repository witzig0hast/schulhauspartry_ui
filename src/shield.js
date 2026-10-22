import { settings } from './settings.js';
import { clientIp } from './security.js';
import { sendNotify } from './notify.js';
import { audit } from './audit.js';

// Schutz vor Ueberlastung und Missbrauch. Das ist die zweite Verteidigungslinie hinter Cloudflare (dort wehrt man
// Datenflut ab) -- hier geht es darum, dass einzelne Absender, Geraete oder Skripte die App nicht lahmlegen koennen.
//  * Grenzen pro Absender-Adresse und Klasse (Seiten, Dateien, Gaeste-API, schreibende Aufrufe)
//  * Grenzen pro Gaeste-Geraet, pro Adresse fuer Wuensche und fuer neue Geraete (Cookie-Wechsel hilft nicht)
//  * WebSocket: Verbindungen pro Adresse/Geraet/insgesamt, Nachrichtenrate
//  * Gleichzeitige Anfragen gedeckelt (die Technik/Admin bleiben bedienbar), automatische Sperre bei Dauerfeuer
const MAXKEYS = 200000;

class Window {
  constructor(ms) { this.ms = ms; this.m = new Map(); }
  hit(key, max, now = Date.now()) {
    let e = this.m.get(key);
    if (!e || e.reset <= now) {
      e = { n: 0, reset: now + this.ms };
      this.m.set(key, e);
      if (this.m.size > MAXKEYS) this.m.delete(this.m.keys().next().value);   // Speicher nie unbegrenzt wachsen lassen
    }
    e.n++;
    return e.n <= max;
  }
  retryAfter(key, now = Date.now()) { const e = this.m.get(key); return e ? Math.max(1, Math.ceil((e.reset - now) / 1000)) : 1; }
  sweep(now = Date.now()) { for (const [k, e] of this.m) if (e.reset <= now) this.m.delete(k); }
}

const cfg = () => settings().security.shield;
const factor = () => (cfg().attackMode ? 0.2 : 1);          // Angriffsmodus: alles auf 20 %
const lim = (n) => Math.max(1, Math.floor(n * factor()));

const w = { page: new Window(60000), asset: new Window(60000), guest: new Window(60000), write: new Window(60000), device: new Window(60000), wish: new Window(15 * 60000), newDev: new Window(60000), strike: new Window(60000) };
const bans = new Map();             // ip -> { until, reason }
const stats = { total: 0, byReason: {}, perMinute: new Map(), offenders: new Map() };
let inflight = 0;
const ws = { total: 0, perIp: new Map(), perDev: new Map() };

function count(reason, ip) {
  stats.total++;
  stats.byReason[reason] = (stats.byReason[reason] || 0) + 1;
  const min = Math.floor(Date.now() / 60000);
  stats.perMinute.set(min, (stats.perMinute.get(min) || 0) + 1);
  for (const k of stats.perMinute.keys()) if (k < min - 60) stats.perMinute.delete(k);
  if (ip) {
    stats.offenders.set(ip, (stats.offenders.get(ip) || 0) + 1);
    if (stats.offenders.size > 500) stats.offenders.delete(stats.offenders.keys().next().value);
  }
}

// Wer dauernd abgewiesen wird, wird fuer eine Weile komplett gesperrt (billige Abweisung ohne weitere Arbeit)
function strike(ip, reason) {
  count(reason, ip);
  if (!w.strike.hit(ip, cfg().banStrikes)) {
    if (!bans.has(ip)) {
      bans.set(ip, { until: Date.now() + cfg().banMin * 60000, reason, since: Date.now() });
      if (ip.startsWith('198.18.')) return;   // Generalprobe: keine Meldungen fuer Mess-Adressen
      audit('shield.ban', null, ip, `${reason}, ${cfg().banMin} Min.`);
      sendNotify({ title: '🛡️ Absender gesperrt', message: `${ip} wurde wegen Dauerfeuer (${reason}) für ${cfg().banMin} Minuten gesperrt.`, priority: 3, tags: ['shield'], key: `ban:${ip}` }).catch(() => {});
    }
  }
}
const banned = (ip, now = Date.now()) => { const b = bans.get(ip); if (!b) return false; if (b.until <= now) { bans.delete(ip); return false; } return true; };

const isAsset = (p) => p.startsWith('/assets/') || p === '/brand.css' || p.startsWith('/brand/') || p.startsWith('/cover/');
const isGuestApi = (p) => /^(\/t-[a-z0-9]+)?\/api\/guest\//.test(p);
const reject = (res, code, retry, text = 'Zu viele Anfragen. Bitte kurz warten.') => {
  res.status(code).set({ 'Retry-After': String(retry), 'Cache-Control': 'no-store' });
  return res.type('application/json').send(JSON.stringify({ error: text }));
};

export const shield = {
  middleware(req, res, next) {
    const c = cfg();
    if (!c.enabled || req.path === '/healthz') return next();
    const ip = clientIp(req), p = req.path, now = Date.now();
    const staffCookie = /(^|;\s*)(__Host-)?sid=/.test(req.headers.cookie || '');
    // Gesperrte Adressen kommen nicht mehr auf Seiten und Gaeste-API; angemeldetes Team (Cookie) auf die Team-API schon (z. B. wenn das ganze Schul-WLAN dieselbe Adresse hat)
    if (banned(ip, now) && !(staffCookie && p.includes('/api/') && !isGuestApi(p))) { count('gesperrt'); res.set('Connection', 'close'); return reject(res, 429, Math.ceil((bans.get(ip).until - now) / 1000), 'Dein Gerät wurde vorübergehend gesperrt.'); }
    // 1) Grenze pro Adresse und Klasse
    const klass = isAsset(p) ? 'asset' : isGuestApi(p) ? 'guest' : 'page';
    const max = lim(klass === 'asset' ? c.assetPerMin : klass === 'guest' ? c.guestPerMin : c.pagePerMin);
    if (!w[klass].hit(ip, max, now)) { strike(ip, `zu viele ${klass === 'asset' ? 'Datei' : klass === 'guest' ? 'Gäste-' : 'Seiten-/Team-'}Anfragen`); return reject(res, 429, w[klass].retryAfter(ip, now)); }
    // 2) schreibende Aufrufe strenger
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !w.write.hit(ip, lim(c.writePerMin), now)) { strike(ip, 'zu viele schreibende Anfragen'); return reject(res, 429, w.write.retryAfter(ip, now)); }
    // 3) gleichzeitige Anfragen deckeln; Team (angemeldet, nicht Gaeste-API) bleibt bedienbar
    inflight++;
    let done = false;
    const end = () => { if (!done) { done = true; inflight--; } };
    res.on('close', end); res.on('finish', end);
    const staff = p.includes('/api/') && !isGuestApi(p) && staffCookie;
    if (!staff && inflight > lim(c.maxInflight)) { end(); count('überlastet', ip); return reject(res, 503, 3, 'Gerade sehr viel los – bitte gleich nochmal versuchen.'); }
    next();
  },
  // pro Gaeste-Geraet
  deviceOk(deviceId) { return !cfg().enabled || w.device.hit(String(deviceId), lim(cfg().devicePerMin)); },
  // neue Geraete (Cookie wegwerfen und neu anfangen) pro Adresse begrenzen
  newDeviceOk(ip) { if (!cfg().enabled) return true; const ok = w.newDev.hit(ip, lim(cfg().newDevicesPerMin)); if (!ok) strike(ip, 'zu viele neue Geräte'); return ok; },
  // Wuensche pro Adresse (zusaetzlich zum Limit pro Geraet)
  wishOk(ip) { if (!cfg().enabled) return true; const ok = w.wish.hit(ip, lim(cfg().wishesPerIp)); if (!ok) count('Wunsch-Limit pro Adresse', ip); return ok; },
  pendingFull(total) { return cfg().enabled && total >= lim(cfg().maxPending) * (cfg().attackMode ? 5 : 1); },
  // WebSocket: Verbindung anmelden; liefert eine Freigabe-Funktion oder null
  wsOpen(ip, deviceKey) {
    const c = cfg();
    if (!c.enabled) return () => {};
    if (banned(ip)) { count('gesperrt', ip); return null; }
    const perIp = ws.perIp.get(ip) || 0, perDev = deviceKey ? ws.perDev.get(deviceKey) || 0 : 0;
    if (ws.total >= c.wsTotal || perIp >= lim(c.wsPerIp) || perDev >= (String(deviceKey).startsWith('s:') ? 12 : 4)) { strike(ip, 'zu viele Live-Verbindungen'); return null; }
    ws.total++; ws.perIp.set(ip, perIp + 1); if (deviceKey) ws.perDev.set(deviceKey, perDev + 1);
    let released = false;
    return () => {
      if (released) return; released = true; ws.total--;
      const n = (ws.perIp.get(ip) || 1) - 1; if (n <= 0) ws.perIp.delete(ip); else ws.perIp.set(ip, n);
      if (deviceKey) { const d = (ws.perDev.get(deviceKey) || 1) - 1; if (d <= 0) ws.perDev.delete(deviceKey); else ws.perDev.set(deviceKey, d); }
    };
  },
  wsMessageFlood(ip) { count('Live-Nachrichtenflut', ip); strike(ip, 'Live-Nachrichtenflut'); },
  // Sichtbarkeit fuer den Admin
  status() {
    const now = Date.now(), min = Math.floor(now / 60000);
    return {
      cfg: { ...cfg() }, inflight, ws: { total: ws.total, ips: ws.perIp.size },
      blocked: { total: stats.total, byReason: stats.byReason, last60: Array.from({ length: 60 }, (_, i) => stats.perMinute.get(min - 59 + i) || 0) },
      offenders: [...stats.offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ip, n]) => ({ ip, n, banned: banned(ip, now) })),
      bans: [...bans.entries()].filter(([, b]) => b.until > now).map(([ip, b]) => ({ ip, reason: b.reason, untilSec: Math.ceil((b.until - now) / 1000) })),
    };
  },
  unbanWhere(fn) { for (const ip of [...bans.keys()]) if (fn(ip)) bans.delete(ip); for (const ip of [...stats.offenders.keys()]) if (fn(ip)) stats.offenders.delete(ip); for (const k of [...w.strike.m.keys()]) if (fn(k)) w.strike.m.delete(k); },
  unban(ip) { stats.offenders.delete(ip); w.strike.m.delete(ip); return bans.delete(ip); },
  sweep() { const now = Date.now(); for (const x of Object.values(w)) x.sweep(now); for (const [ip, b] of bans) if (b.until <= now) bans.delete(ip); },
  reset() { for (const x of Object.values(w)) x.m.clear(); bans.clear(); stats.total = 0; stats.byReason = {}; stats.perMinute.clear(); stats.offenders.clear(); },
};
