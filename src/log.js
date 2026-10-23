import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDirPath, setEventHook } from './db.js';
import { settings } from './settings.js';

// Einheitliches Live-Protokoll ueber alles, was passiert.
// Jeder Eintrag ist zweifach lesbar:
//   Mensch:   msg   – ein deutscher Satz ("Wunsch angenommen: Levitating – Dua Lipa (von Lisa)")
//   Maschine: event – fester Name ("request.approved"), data – die Rohdaten als JSON, actor – wer es ausgeloest hat
// Dazu level (debug|info|warn|error), cat (Bereich) und env (live|test) zum Filtern.
// Gespeichert in logs.db (nicht in den Backups); debug-Eintraege nur im Speicher (sehr viele, z. B. jede Spotify-Anfrage).

export const LEVELS = ['debug', 'info', 'warn', 'error'];
export const CATS = {
  wunsch: 'Wünsche', moderation: 'Moderation', wiedergabe: 'Wiedergabe', pult: 'Pult & Mics', spotify: 'Spotify',
  ki: 'KI', verbindung: 'Verbindungen', companion: 'Companion', admin: 'Admin & Einstellungen', sicherheit: 'Sicherheit', system: 'System',
};
// Was die Technik nicht sehen soll (IP-Adressen, Logins): nur fuer den Admin
export const ADMIN_ONLY = new Set(['sicherheit', 'admin']);

const RING_MAX = 3000;
const ring = [];
const listeners = new Set();
let db = null, seq = 0, quietEnv = null, insertCount = 0;

function open() {
  if (db) return db;
  db = new DatabaseSync(dataDirPath ? path.join(dataDirPath, 'logs.db') : ':memory:');
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, env TEXT NOT NULL, level TEXT NOT NULL, cat TEXT NOT NULL, event TEXT NOT NULL, msg TEXT NOT NULL, actor TEXT, data TEXT);
    CREATE INDEX IF NOT EXISTS logs_ts ON logs(ts);
    CREATE INDEX IF NOT EXISTS logs_cat ON logs(cat, ts);`);
  return db;
}
export function resetLogs() { try { db?.close(); } catch { /* zu */ } db = null; ring.length = 0; seq = 0; }

// Gaeste nie mit Geraete-ID: nur ein kurzes, nicht umkehrbares Kuerzel (gleiches Geraet = gleiches Kuerzel)
export const guestTag = (deviceId) => (deviceId ? `Gast ${crypto.createHash('sha256').update(`g:${deviceId}`).digest('hex').slice(0, 5)}` : 'Gast');
// Rehearsal/Generalprobe erzeugt tausende Eintraege: dann laufen normale Eintraege dieser Umgebung nur im Speicher mit
export function setQuietEnv(env) { quietEnv = env; }
export const onLog = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

const clip = (v, depth = 0) => {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 25).map((x) => clip(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, /token|secret|password|passwort|code_hash|cookie/i.test(k) ? '***' : clip(x, depth + 1)]));
  return String(v);
};

export function log(level, cat, event, msg, { env = 'live', data = null, actor = null } = {}) {
  try {
    if (level === 'debug' && !settings().logs?.debug) return null;
    const persist = level !== 'debug' && !(quietEnv === env && level === 'info');
    const e = { id: null, seq: ++seq, ts: Date.now(), env, level, cat: CATS[cat] ? cat : 'system', event: String(event).slice(0, 60), msg: String(msg).slice(0, 400), actor: actor ? clip(actor) : null, data: data == null ? null : clip(data) };
    if (persist) {
      const r = open().prepare('INSERT INTO logs(ts, env, level, cat, event, msg, actor, data) VALUES(?,?,?,?,?,?,?,?)').run(e.ts, e.env, e.level, e.cat, e.event, e.msg, e.actor ? JSON.stringify(e.actor) : null, e.data == null ? null : JSON.stringify(e.data));
      e.id = Number(r.lastInsertRowid);
      if (++insertCount % 500 === 0) prune();
    }
    ring.push(e); if (ring.length > RING_MAX) ring.shift();
    for (const fn of listeners) { try { fn(e); } catch { /* Zuhoerer duerfen nichts kaputt machen */ } }
    return e;
  } catch { return null; }   // Protokoll darf nie etwas kaputt machen
}
export const info = (cat, event, msg, o) => log('info', cat, event, msg, o);
export const warn = (cat, event, msg, o) => log('warn', cat, event, msg, o);
export const error = (cat, event, msg, o) => log('error', cat, event, msg, o);
export const debug = (cat, event, msg, o) => log('debug', cat, event, msg, o);

function prune() {
  const days = Math.max(1, settings().logs?.keepDays ?? 14);
  const d = open();
  d.prepare('DELETE FROM logs WHERE ts < ?').run(Date.now() - days * 86400000);
  d.prepare('DELETE FROM logs WHERE id <= (SELECT MAX(id) FROM logs) - 300000').run();
}

const rowOf = (r) => ({ id: r.id, seq: null, ts: r.ts, env: r.env, level: r.level, cat: r.cat, event: r.event, msg: r.msg, actor: r.actor ? JSON.parse(r.actor) : null, data: r.data ? JSON.parse(r.data) : null });

// Abfrage mit Filtern. cats = erlaubte Bereiche (Rolle), before = aeltere Seite laden
export function queryLogs({ env = null, minLevel = 'info', cats = null, q = '', before = null, limit = 300 } = {}) {
  const lv = LEVELS.slice(Math.max(0, LEVELS.indexOf(minLevel)));
  const where = [`level IN (${lv.map(() => '?').join(',')})`], args = [...lv];
  if (env) { where.push('env = ?'); args.push(env); }
  if (cats?.length) { where.push(`cat IN (${cats.map(() => '?').join(',')})`); args.push(...cats); }
  if (q) { where.push('(msg LIKE ? OR event LIKE ? OR data LIKE ?)'); const s = `%${String(q).replace(/[%_]/g, '')}%`; args.push(s, s, s); }
  if (before) { where.push('ts < ?'); args.push(Number(before)); }
  const n = Math.min(2000, Math.max(1, Number(limit) || 300));
  let rows = open().prepare(`SELECT * FROM logs WHERE ${where.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args, n).map(rowOf);
  // Debug-Eintraege liegen nur im Speicher
  if (minLevel === 'debug') {
    const ql = String(q || '').toLowerCase();
    const mem = ring.filter((e) => e.level === 'debug' && (!env || e.env === env) && (!cats?.length || cats.includes(e.cat)) && (!before || e.ts < before)
      && (!ql || `${e.msg} ${e.event} ${JSON.stringify(e.data)}`.toLowerCase().includes(ql)));
    rows = [...rows, ...mem].sort((a, b) => b.ts - a.ts).slice(0, n);
  }
  return rows;
}
export function logCounts(sinceMs = 3600000) {
  return open().prepare('SELECT cat, level, COUNT(*) c FROM logs WHERE ts > ? GROUP BY cat, level').all(Date.now() - sinceMs)
    .reduce((m, r) => { (m[r.cat] ||= { total: 0 })[r.level] = r.c; m[r.cat].total += r.c; return m; }, {});
}

// ---------- Bestehende Ereignisse (events-Tabelle) mit Text versehen ----------
const EVENT_TEXT = {
  play: ['info', 'wiedergabe', 'playback.started', (d) => `Player ${d.player} startet „${d.title}“${d.auto ? ' (Auto-Crossfade)' : ''}`],
  start: ['info', 'wiedergabe', 'evening.started', () => 'Abend gestartet (Start-Playlist)'],
  panic: ['warn', 'wiedergabe', 'panic.fired', () => 'NOT-AUS ausgelöst – beide Player gestoppt'],
  'panic-clear': ['info', 'wiedergabe', 'panic.cleared', () => 'Not-Aus aufgehoben'],
  emergency: ['warn', 'wiedergabe', 'emergency.started', () => 'Notfall-Playlist gestartet'],
  'emergency-clear': ['info', 'wiedergabe', 'emergency.cleared', () => 'Notfall-Playlist beendet'],
  end: ['info', 'wiedergabe', 'evening.ended', () => 'Ende-Modus: Musik wird ausgeblendet, Wünsche geschlossen'],
  'end-clear': ['info', 'wiedergabe', 'evening.end_cleared', () => 'Ende-Modus aufgehoben'],
  wishmode: ['info', 'wunsch', 'wishes.mode', (d) => (d.auto === 'open' ? 'Wünsche zur eingestellten Uhrzeit freigeschaltet' : d.gate ? 'Wünsche von Hand freigeschaltet' : 'pause' in d ? (d.pause ? 'Pausen-Modus an' : 'Pausen-Modus aus') : `Wünsche: ${{ open: 'offen', paused: 'pausiert', closed: 'geschlossen' }[d.mode] || d.mode}`)],
  error: ['error', 'system', 'engine.error', (d) => `Fehler (${d.where}): ${d.msg}`],
  reset: ['warn', 'admin', 'env.reset', () => 'Umgebung zurückgesetzt (Wünsche, Warteschlange, Setlist gelöscht)'],
  notify: ['info', 'system', 'notify.sent', (d) => `Handy-Benachrichtigung gesendet: ${d.title}`],
  'notify-error': ['warn', 'system', 'notify.failed', (d) => `Handy-Benachrichtigung fehlgeschlagen: ${d.msg}`],
  'backup-error': ['error', 'system', 'backup.failed', (d) => `Backup fehlgeschlagen: ${d.msg}`],
  blacklist: ['info', 'moderation', 'blacklist.added', (d) => `Gesperrt (${d.kind === 'artist' ? 'Interpret' : 'Song'}): ${d.label}`],
  poll: ['info', 'wunsch', 'poll.started', () => 'Live-Umfrage gestartet'],
  levels: ['info', 'pult', 'levels.confirmed', (d) => `Grundpegel bestätigt${d.by ? ` von ${d.by}` : ''}`],
  livetest: ['info', 'system', 'livetest', (d) => (d.start ? `Live-Test gestartet${d.by ? ` von ${d.by}` : ''}` : `Live-Test beendet: ${d.verdict}`)],
  now: ['info', 'wiedergabe', 'dj.now', (d) => `DJ: Wunsch #${d.id} läuft jetzt`],
  played: ['info', 'wiedergabe', 'dj.played', (d) => `DJ: Wunsch #${d.id} gespielt`],
  undo: ['info', 'wiedergabe', 'dj.undo', (d) => `DJ: Markierung bei Wunsch #${d.id} zurückgenommen`],
};
setEventHook((env, type, data) => {
  const t = EVENT_TEXT[type];
  if (t) log(t[0], t[1], t[2], t[3](data || {}), { env, data });
  else log('info', 'system', `event.${type}`, `Ereignis „${type}“`, { env, data });
});

// ---------- Sicherheitsprotokoll (audit) mit Text versehen ----------
const AUDIT_TEXT = {
  'login.ok': ['info', 'Anmeldung'], 'login.fail': ['warn', 'Fehlgeschlagene Anmeldung'], 'login.locked': ['warn', 'Anmeldung gesperrt (zu viele Versuche)'],
  'login.blocked': ['warn', 'Anmeldung abgewiesen'], 'login.passkey': ['info', 'Anmeldung per Passkey'], 'login.sso': ['info', 'Anmeldung per SSO'],
  'sso.fail': ['warn', 'SSO-Anmeldung fehlgeschlagen'], 'settings.change': ['info', 'Einstellungen geändert'], 'mode.change': ['info', 'Betriebsart geändert'],
  'account.create': ['info', 'Code angelegt'], 'account.delete': ['info', 'Code gelöscht'], 'account.revoke': ['info', 'Code gesperrt'],
  'shield.ban': ['warn', 'Adresse automatisch gesperrt'], 'shield.unban': ['info', 'Sperre aufgehoben'], 'admin.blocked': ['warn', 'Admin-Zugriff abgewiesen'],
  'password.change': ['info', 'Admin-Passwort geändert'], 'companion.token': ['info', 'Companion-Token neu erzeugt'], 'spotify.connect.fail': ['warn', 'Spotify-Verbindung fehlgeschlagen'],
};
export function auditToLog(kind, who, ip, detail) {
  const t = AUDIT_TEXT[kind] || ['info', kind];
  const cat = /^(settings|mode|account|cache|reset|levels|recap|ai|livetest|rehearsal|companion)\./.test(kind) || kind === 'reset' ? 'admin' : 'sicherheit';
  log(t[0], cat, `audit.${kind}`, `${t[1]}${who ? ` – ${who}` : ''}${detail ? ` (${String(detail).slice(0, 120)})` : ''}`, { data: { kind, who, ip, detail }, actor: who ? { kind: 'staff', label: who } : null });
}
