import { getSetting, setSetting } from './db.js';
import { randomToken, encrypt, decrypt } from './security.js';
import { isFeature } from './features.js';

export const DEFAULTS = {
  timezone: 'Europe/Berlin',
  security: { idleMinutes: 240, maxHours: 12, adminIpAllow: [], adminPasskeyOnly: false, apiPerMin: 900, floodPerMin: 40, requirePasskeyHint: true },
  voting: { votesPerWindow: 8, windowMin: 15, sortByVotes: true },
  handover: { text: '', by: '', ts: 0 },
  limits: { maxGain: 1, maxSongSec: 0 },
  pause: { message: 'Kurze Pause – gleich geht’s weiter!' },
  roleHome: {},
  roleBoards: {},
  features: {},   // Ueberschreibungen der Funktionsschalter (siehe features.js)
  limit: { count: 2, windowMin: 15 },
  explicitMode: 'mark', // off | mark | block
  rejectReasons: ['Zu explizit', 'Passt nicht zur Party', 'Läuft schon / wurde gespielt', 'Nicht verfügbar'],
  notice: { enabled: false, text: '' },
  wishMessages: {
    paused: 'Die Wünsche sind gerade pausiert. Gleich geht es weiter!',
    closed: 'Die Wünsche sind geschlossen.',
    ended: 'Das war es für heute - danke fürs Feiern!',
  },
  priorityWithin: 3,
  replay: { mode: 'allow', cooldownMin: 60 }, // allow | cooldown | block: bereits gespielte Songs
  fadePresets: [
    { name: 'Kurz', sec: 3 },
    { name: 'Normal', sec: 8 },
    { name: 'Lang', sec: 15 },
  ],
  auto: { enabled: false, crossfadeSec: 8, startBeforeEndSec: { 1: 20, 2: 20 }, curve: 'equalPower', smartOutro: true },
  // Automatik rund um die Warteschlange
  autoOrder: { enabled: true, maxRepeat: 2, window: 4, mood: true, phases: [] }, // phases: [{name, from:'HH:MM', to:'HH:MM', prefer:[Genre-Familien]}]
  filler: { enabled: false, playlist: '', minQueue: 1, avoidMin: 90 },
  emergency: { playlist: '', player: 1, shuffle: true },
  notify: { enabled: false, url: 'https://ntfy.sh', topic: '', token: '', downSec: 20, events: { x32: true, security: true, flood: true, spotify: true, player: true, panic: true, queueEmpty: true, emergency: true, backup: true } },
  backup: { enabled: true, everyMin: 60, keep: 24 },
  brand: { name: 'Schulhauspartry', tagline: '', accent: '', logo: null },
  ducking: { enabled: false, db: -12, attackMs: 250, releaseMs: 900 },
  x32: {
    adapter: 'mock', // mock | http
    piUrl: '',
    piToken: '',
    channels: { p1: [1, 2], p2: [3, 4], mics: [5, 6, 7] },
    micNames: ['Mic 1', 'Mic 2', 'Mic 3'],
  },
  test: { enabled: false, prefix: null, realEnv: 'live', mockSpeed: 1 },
  spotify: { clientId: '', clientSecret: '', apiBudget: 60, players: { 1: { refreshToken: '', deviceId: '', deviceName: '', user: '' }, 2: { refreshToken: '', deviceId: '', deviceName: '', user: '' } } },
};

const listeners = new Set();
export const onSettingsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

let cache = null;

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

export function loadSettings() {
  const stored = getSetting('app', {});
  cache = merge(structuredClone(DEFAULTS), stored);
  if (!cache.test.prefix) {
    cache.test.prefix = 't-' + randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    saveSettings();
  }
  return cache;
}

function saveSettings() { setSetting('app', cache); }

export const settings = () => cache || loadSettings();

const clamp = (n, lo, hi, d) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (s, max) => String(s ?? '').slice(0, max);

// Whitelist-Validierung: nur bekannte Felder werden uebernommen.
export function applyPatch(patch, { allow }) {
  const s = settings();
  const has = (k) => k in patch && allow.includes(k);

  if (has('limit')) {
    s.limit.count = Math.round(clamp(patch.limit.count, 1, 100, s.limit.count));
    s.limit.windowMin = Math.round(clamp(patch.limit.windowMin, 1, 600, s.limit.windowMin));
  }
  if (has('explicitMode') && ['off', 'mark', 'block'].includes(patch.explicitMode)) s.explicitMode = patch.explicitMode;
  if (has('rejectReasons') && Array.isArray(patch.rejectReasons)) {
    s.rejectReasons = patch.rejectReasons.map((r) => str(r, 60).trim()).filter(Boolean).slice(0, 12);
  }
  if (has('notice')) {
    s.notice.enabled = !!patch.notice.enabled;
    s.notice.text = str(patch.notice.text, 400);
  }
  if (has('wishMessages')) {
    for (const k of ['paused', 'closed', 'ended']) if (k in (patch.wishMessages || {})) s.wishMessages[k] = str(patch.wishMessages[k], 200);
  }
  if (has('security')) {
    const q = patch.security, o = s.security;
    if ('idleMinutes' in q) o.idleMinutes = Math.round(clamp(q.idleMinutes, 5, 1440, o.idleMinutes));
    if ('maxHours' in q) o.maxHours = Math.round(clamp(q.maxHours, 1, 72, o.maxHours));
    if ('apiPerMin' in q) o.apiPerMin = Math.round(clamp(q.apiPerMin, 60, 5000, o.apiPerMin));
    if ('floodPerMin' in q) o.floodPerMin = Math.round(clamp(q.floodPerMin, 5, 500, o.floodPerMin));
    if ('adminPasskeyOnly' in q) o.adminPasskeyOnly = !!q.adminPasskeyOnly;
    if (Array.isArray(q.adminIpAllow)) o.adminIpAllow = q.adminIpAllow.map((x) => str(x, 60).trim()).filter((x) => /^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(x)).slice(0, 20);
  }
  if (has('voting')) {
    const v = patch.voting;
    if ('votesPerWindow' in v) s.voting.votesPerWindow = Math.round(clamp(v.votesPerWindow, 1, 100, s.voting.votesPerWindow));
    if ('windowMin' in v) s.voting.windowMin = Math.round(clamp(v.windowMin, 1, 600, s.voting.windowMin));
    if ('sortByVotes' in v) s.voting.sortByVotes = !!v.sortByVotes;
  }
  if (has('handover')) { s.handover = { text: str(patch.handover.text, 600), by: str(patch.handover.by, 24), ts: Date.now() }; }
  if (has('limits')) {
    const l = patch.limits;
    if ('maxGain' in l) s.limits.maxGain = clamp(l.maxGain, 0.3, 1, 1);
    if ('maxSongSec' in l) s.limits.maxSongSec = Math.round(clamp(l.maxSongSec, 0, 1800, 0));
  }
  if (has('pause') && 'message' in patch.pause) s.pause.message = str(patch.pause.message, 120);
  if (has('roleHome') && patch.roleHome && typeof patch.roleHome === 'object') {
    for (const r of ['admin', 'tech', 'mod', 'orga', 'display', 'light']) if (r in patch.roleHome) { const v = String(patch.roleHome[r]); if (v === '' || /^\/[a-z]+$/.test(v)) s.roleHome[r] = v; }
  }
  if (has('roleBoards') && patch.roleBoards && typeof patch.roleBoards === 'object') {
    for (const r of ['admin', 'tech', 'mod', 'orga', 'display']) if (r in patch.roleBoards) {
      const b = patch.roleBoards[r];
      s.roleBoards[r] = Array.isArray(b) ? b.slice(0, 30).map((x) => ({ id: str(x.id, 20), size: ['normal', 'wide', 'full'].includes(x.size) ? x.size : 'normal' })) : null;
    }
  }
  if (has('features') && patch.features && typeof patch.features === 'object') {
    for (const [id, on] of Object.entries(patch.features)) if (isFeature(id) && typeof on === 'boolean') s.features[id] = on;
  }
  if (has('timezone')) { try { new Intl.DateTimeFormat('de-DE', { timeZone: String(patch.timezone) }); s.timezone = String(patch.timezone); } catch { /* ungueltig: ignorieren */ } }
  if (has('autoOrder')) {
    const a = patch.autoOrder, o = s.autoOrder;
    if ('enabled' in a) o.enabled = !!a.enabled;
    if ('mood' in a) o.mood = !!a.mood;
    if ('maxRepeat' in a) o.maxRepeat = Math.round(clamp(a.maxRepeat, 1, 10, o.maxRepeat));
    if ('window' in a) o.window = Math.round(clamp(a.window, 2, 10, o.window));
    if (Array.isArray(a.phases)) {
      const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : null);
      o.phases = a.phases.slice(0, 12).map((p) => ({ name: str(p.name, 30) || 'Phase', from: hhmm(p.from), to: hhmm(p.to), prefer: (Array.isArray(p.prefer) ? p.prefer : []).map((x) => str(x, 40)).filter(Boolean).slice(0, 8) })).filter((p) => p.from && p.to);
    }
  }
  if (has('filler')) {
    const f = patch.filler;
    if ('enabled' in f) s.filler.enabled = !!f.enabled;
    if ('playlist' in f) s.filler.playlist = str(f.playlist, 200).trim();
    if ('minQueue' in f) s.filler.minQueue = Math.round(clamp(f.minQueue, 0, 10, s.filler.minQueue));
    if ('avoidMin' in f) s.filler.avoidMin = Math.round(clamp(f.avoidMin, 5, 1440, s.filler.avoidMin));
  }
  if (has('emergency')) {
    const e = patch.emergency;
    if ('playlist' in e) s.emergency.playlist = str(e.playlist, 200).trim();
    if ([1, 2].includes(Number(e.player))) s.emergency.player = Number(e.player);
    if ('shuffle' in e) s.emergency.shuffle = !!e.shuffle;
  }
  if (has('notify')) {
    const n = patch.notify;
    if ('enabled' in n) s.notify.enabled = !!n.enabled;
    if ('url' in n) { const u = str(n.url, 200).trim().replace(/\/$/, ''); if (/^https?:\/\/[^\s]+$/i.test(u)) s.notify.url = u; }
    if ('topic' in n) s.notify.topic = str(n.topic, 80).trim().replace(/[^\w.-]/g, '');
    if (n.token) s.notify.token = encrypt(str(n.token, 200));
    if (n.clearToken) s.notify.token = '';
    if ('downSec' in n) s.notify.downSec = Math.round(clamp(n.downSec, 5, 300, s.notify.downSec));
    if (n.events) for (const k of Object.keys(s.notify.events)) if (k in n.events) s.notify.events[k] = !!n.events[k];
  }
  if (has('backup')) {
    const b = patch.backup;
    if ('enabled' in b) s.backup.enabled = !!b.enabled;
    if ('everyMin' in b) s.backup.everyMin = Math.round(clamp(b.everyMin, 5, 1440, s.backup.everyMin));
    if ('keep' in b) s.backup.keep = Math.round(clamp(b.keep, 1, 200, s.backup.keep));
  }
  if (has('brand')) {
    const b = patch.brand;
    if ('name' in b) s.brand.name = str(b.name, 40).trim() || 'Schulhauspartry';
    if ('tagline' in b) s.brand.tagline = str(b.tagline, 90).trim();
    if ('accent' in b) s.brand.accent = /^#[0-9a-fA-F]{6}$/.test(String(b.accent)) ? String(b.accent).toLowerCase() : '';
  }
  if (has('replay')) {
    if (['allow', 'cooldown', 'block'].includes(patch.replay.mode)) s.replay.mode = patch.replay.mode;
    if ('cooldownMin' in patch.replay) s.replay.cooldownMin = Math.round(clamp(patch.replay.cooldownMin, 1, 1440, s.replay.cooldownMin));
  }
  if (has('priorityWithin')) s.priorityWithin = Math.round(clamp(patch.priorityWithin, 1, 10, s.priorityWithin));
  if (has('fadePresets') && Array.isArray(patch.fadePresets)) {
    s.fadePresets = patch.fadePresets.slice(0, 6).map((p) => ({ name: str(p.name, 20) || 'Preset', sec: clamp(p.sec, 0.5, 60, 5) }));
  }
  if (has('auto')) {
    const a = patch.auto;
    if ('enabled' in a) s.auto.enabled = !!a.enabled;
    if ('crossfadeSec' in a) s.auto.crossfadeSec = clamp(a.crossfadeSec, 0.5, 60, s.auto.crossfadeSec);
    if (a.startBeforeEndSec) for (const p of [1, 2]) if (p in a.startBeforeEndSec) s.auto.startBeforeEndSec[p] = clamp(a.startBeforeEndSec[p], 1, 180, s.auto.startBeforeEndSec[p]);
    if (['equalPower', 'linear'].includes(a.curve)) s.auto.curve = a.curve;
    if ('smartOutro' in a) s.auto.smartOutro = !!a.smartOutro;
  }
  if (has('ducking')) {
    const d = patch.ducking;
    if ('enabled' in d) s.ducking.enabled = !!d.enabled;
    if ('db' in d) s.ducking.db = clamp(d.db, -40, -1, s.ducking.db);
    if ('attackMs' in d) s.ducking.attackMs = clamp(d.attackMs, 20, 3000, s.ducking.attackMs);
    if ('releaseMs' in d) s.ducking.releaseMs = clamp(d.releaseMs, 50, 10000, s.ducking.releaseMs);
  }
  if (has('x32')) {
    const x = patch.x32;
    if (['mock', 'http'].includes(x.adapter)) s.x32.adapter = x.adapter;
    if ('piUrl' in x) s.x32.piUrl = str(x.piUrl, 400).trim();
    if (x.piToken) s.x32.piToken = encrypt(str(x.piToken, 200));
    if (x.channels) {
      // leere Felder = nicht benutzt; mindestens ein Kanal bleibt, ungueltige Werte werden ignoriert
      const ch = (arr, n) => {
        if (!Array.isArray(arr)) return null;
        const out = [...new Set(arr.filter((c) => c !== '' && c != null).map(Number).filter((c) => Number.isInteger(c) && c >= 1 && c <= 32))].slice(0, n);
        return out.length ? out : null;
      };
      s.x32.channels.p1 = ch(x.channels.p1, 2) || s.x32.channels.p1;
      s.x32.channels.p2 = ch(x.channels.p2, 2) || s.x32.channels.p2;
      s.x32.channels.mics = ch(x.channels.mics, 3) || s.x32.channels.mics;
    }
    if (Array.isArray(x.micNames)) s.x32.micNames = [0, 1, 2].map((i) => str(x.micNames[i], 24).trim() || `Mic ${i + 1}`);
  }
  if (has('test')) {
    const t = patch.test;
    if ('enabled' in t) s.test.enabled = !!t.enabled;
    if (['live', 'test'].includes(t.realEnv)) s.test.realEnv = t.realEnv;
    if ('mockSpeed' in t) s.test.mockSpeed = clamp(t.mockSpeed, 1, 60, 1);
    if (t.regeneratePrefix) s.test.prefix = 't-' + randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, 'x');
  }
  if (has('spotify')) {
    const sp = patch.spotify;
    if ('clientId' in sp) s.spotify.clientId = str(sp.clientId, 100).trim();
    if (sp.clientSecret) s.spotify.clientSecret = encrypt(str(sp.clientSecret, 100).trim());
    if ('apiBudget' in sp) s.spotify.apiBudget = Math.round(clamp(sp.apiBudget, 20, 300, 60));
    if (sp.players) for (const p of [1, 2]) {
      const pp = sp.players[p];
      if (!pp) continue;
      if ('deviceId' in pp) s.spotify.players[p].deviceId = str(pp.deviceId, 100);
      if ('deviceName' in pp) s.spotify.players[p].deviceName = str(pp.deviceName, 100);
      if (pp.disconnect) s.spotify.players[p] = { refreshToken: '', deviceId: '', deviceName: '', user: '' };
    }
  }
  saveSettings();
  for (const fn of listeners) fn(s);
  return s;
}

export function setPlayerToken(player, refreshToken, user) {
  const s = settings();
  s.spotify.players[player].refreshToken = encrypt(refreshToken);
  s.spotify.players[player].user = user || '';
  saveSettings();
  for (const fn of listeners) fn(s);
}

export function spotifyCredentials(envCfg) {
  const s = settings();
  return {
    clientId: s.spotify.clientId || envCfg.spotifyClientId,
    clientSecret: s.spotify.clientSecret ? decrypt(s.spotify.clientSecret) : envCfg.spotifyClientSecret,
  };
}

export const playerRefreshToken = (p) => {
  const t = settings().spotify.players[p].refreshToken;
  return t ? decrypt(t) : null;
};
export const notifyToken = () => (settings().notify.token ? decrypt(settings().notify.token) : '');
export const piToken = () => (settings().x32.piToken ? decrypt(settings().x32.piToken) : '');

// Geheimnisse maskiert fuer die Admin-UI
export function publicSettings() {
  const s = structuredClone(settings());
  s.spotify.clientSecret = s.spotify.clientSecret ? '***' : '';
  for (const p of [1, 2]) {
    s.spotify.players[p].connected = !!s.spotify.players[p].refreshToken;
    delete s.spotify.players[p].refreshToken;
  }
  s.x32.piToken = s.x32.piToken ? '***' : '';
  s.notify.token = s.notify.token ? '***' : '';
  return s;
}

// Fuer Gaeste und andere Rollen: nur das Noetige
export function guestSettings() {
  const s = settings();
  return { limit: s.limit, explicitMode: s.explicitMode, notice: s.notice.enabled ? s.notice.text : '', wishMessages: s.wishMessages };
}
