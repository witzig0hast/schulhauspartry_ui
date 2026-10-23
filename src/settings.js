import { getSetting, setSetting } from './db.js';
import { randomToken, encrypt, decrypt } from './security.js';
import { isFeature } from './features.js';
import { config } from './config.js';

export const DEFAULTS = {
  timezone: 'Europe/Berlin',
  // Abend-Start: Start-Playlist und Freischaltung der Wuensche
  start: { playlist: '', minQueue: 3, autoStart: false, startAt: '17:30' },
  opening: { enabled: false, at: '18:00', auto: true, message: 'Die Wünsche öffnen um {zeit} Uhr – bis dahin läuft schon Musik!' },
  operation: { mode: 'full' },   // full = Spotify-Player/Crossfade/X32 | wishlist = nur Wuensche annehmen/ablehnen (ein DJ spielt selbst)
  // Single Sign-On (OpenID Connect, z. B. Authentik). roleMap: Gruppe im Anbieter -> Rolle in der App
  sso: { enabled: false, issuer: '', clientId: '', clientSecret: '', scopes: 'openid profile email', groupsClaim: 'groups', roleMap: [], defaultRole: '', allowAdmin: false, autoCreate: true, autoLinkEmail: false, buttonLabel: 'Mit SSO anmelden' },
  security: { idleMinutes: 240, maxHours: 12, adminIpAllow: [], adminPasskeyOnly: false, apiPerMin: 900, floodPerMin: 40, requirePasskeyHint: true,
    // Schutz vor Ueberlastung (pro Absender-Adresse und Minute; Gaeste hinter einem Schul-WLAN teilen sich oft eine Adresse -> grosszuegig)
    shield: { enabled: true, attackMode: false, pagePerMin: 1500, assetPerMin: 4000, guestPerMin: 2500, writePerMin: 600, devicePerMin: 240, wishesPerIp: 150, newDevicesPerMin: 300, wsPerIp: 400, wsTotal: 3000, maxInflight: 600, maxPending: 400, banStrikes: 150, banMin: 10 } },
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
  notify: { enabled: false, url: 'https://ntfy.sh', topic: '', token: '', downSec: 20, events: { x32: true, security: true, flood: true, spotify: true, player: true, panic: true, queueEmpty: true, emergency: true, backup: true, mood: true } },
  backup: { enabled: true, everyMin: 60, keep: 24 },
  brand: { name: 'Schulhauspartry', tagline: '', accent: '', logo: null },
  ducking: { enabled: false, db: -12, attackMs: 250, releaseMs: 900 },
  x32: {
    adapter: 'mock', // mock | http
    piUrl: '',
    piToken: '',
    faderSpeed: 'normal',
    muteAfterFade: true,    // nach dem Ausblenden Kanal stumm, Fader faehrt stumm zurueck in die Grundstellung   // sanft | normal | schnell: wie schnell die Motorfader fahren duerfen
    host: '',      // IP des X32 im Veranstaltungsnetz; leer = Wert aus der .env des Pi
    port: 10023,
    channels: { p1: [1, 2], p2: [3, 4], mics: [5, 6, 7] },
    micNames: ['Mic 1', 'Mic 2', 'Mic 3'],
  },
  test: { enabled: false, prefix: null, realEnv: 'live', mockSpeed: 1 },
  // Mehrere Spotify-Apps (Developer Dashboard): jede App hat ihr eigenes Anfrage-Limit. search = fuer die Gaeste-Suche mitnutzen.
  // Ein Player gehoert immer zu der App, ueber die er verbunden wurde (appId).
  spotify: { clientId: '', clientSecret: '', apiBudget: 60, apps: [], players: { 1: { refreshToken: '', deviceId: '', deviceName: '', user: '', appId: '' }, 2: { refreshToken: '', deviceId: '', deviceName: '', user: '', appId: '' } } },
  // Live-Protokoll: wie lange aufheben, ob Debug-Eintraege (jede Spotify-/KI-Anfrage) erzeugt werden
  logs: { keepDays: 14, debug: false },
  // Hardware-Knoepfe ueber Bitfocus Companion (Token nur als Hash)
  companion: { enabled: false, tokenHash: '' },
  // KI ueber einen eigenen Ollama-Server: ein Modell fuer alles. token = optional (z. B. hinter einem Reverse-Proxy)
  ai: { enabled: false, url: '', model: '', token: '', timeoutSec: 90, autoLight: true, autoFiller: false },
  // Grundpegel (Pegel-Fenster): Player-Fader am X32 bei 100 %, Spotify-Lautstaerke, optional Mic-Fader
  levels: { playerDb: { 1: 0, 2: 0 }, spotifyVol: { 1: 100, 2: 100 }, micControl: false, micDb: [0, 0, 0], confirmedAt: 0, confirmedBy: '' },
};
const EMPTY_PLAYER = () => ({ refreshToken: '', deviceId: '', deviceName: '', user: '', appId: '' });
const newAppId = () => 'app-' + randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

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
  // Alte Einzel-App (clientId/clientSecret) wird zur ersten App der Liste; verbundene Player gehoeren zu ihr
  const sp = cache.spotify;
  if (!sp.apps.length && sp.clientId) {
    sp.apps = [{ id: 'main', name: 'Haupt-App', clientId: sp.clientId, clientSecret: sp.clientSecret, search: true }];
    for (const p of [1, 2]) if (sp.players[p].refreshToken && !sp.players[p].appId) sp.players[p].appId = 'main';
    sp.clientId = ''; sp.clientSecret = '';
    saveSettings();
  }
  return cache;
}

function saveSettings() { setSetting('app', cache); }

export const settings = () => cache || loadSettings();

// X32-Adresse: nur IPv4 im lokalen Netz (gleiche Regel wie im Relay auf dem Pi)
export function validX32Host(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(h || ''));
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255) || d === 0 || d === 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}
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
    if (q.shield && typeof q.shield === 'object') {
      const sh = o.shield, v = q.shield;
      if ('enabled' in v) sh.enabled = !!v.enabled;
      if ('attackMode' in v) sh.attackMode = !!v.attackMode;
      const lim = { pagePerMin: [30, 100000], assetPerMin: [30, 200000], guestPerMin: [30, 100000], writePerMin: [10, 50000], devicePerMin: [20, 20000], wishesPerIp: [5, 5000], newDevicesPerMin: [5, 20000], wsPerIp: [5, 5000], wsTotal: [50, 50000], maxInflight: [50, 20000], maxPending: [20, 5000], banStrikes: [20, 5000], banMin: [1, 1440] };
      for (const [k, [lo, hi]] of Object.entries(lim)) if (k in v) sh[k] = Math.round(clamp(v[k], lo, hi, sh[k]));
    }
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
    for (const r of ['admin', 'tech', 'mod', 'orga', 'display', 'light', 'dj']) if (r in patch.roleHome) { const v = String(patch.roleHome[r]); if (v === '' || /^\/[a-z]+$/.test(v)) s.roleHome[r] = v; }
  }
  if (has('roleBoards') && patch.roleBoards && typeof patch.roleBoards === 'object') {
    for (const r of ['admin', 'tech', 'mod', 'orga', 'display']) if (r in patch.roleBoards) {
      const b = patch.roleBoards[r];
      s.roleBoards[r] = Array.isArray(b) ? b.slice(0, 30).map((x) => ({ id: str(x.id, 20), size: ['normal', 'wide', 'full'].includes(x.size) ? x.size : 'normal' })) : null;
    }
  }
  const hhmm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
  if (has('start')) {
    const q = patch.start, o = s.start;
    if ('playlist' in q) o.playlist = str(q.playlist, 200).trim();
    if ('minQueue' in q) o.minQueue = Math.round(clamp(q.minQueue, 1, 10, o.minQueue));
    if ('autoStart' in q) o.autoStart = !!q.autoStart;
    if ('startAt' in q) o.startAt = hhmm(q.startAt, o.startAt);
  }
  if (has('opening')) {
    const q = patch.opening, o = s.opening;
    if ('enabled' in q) o.enabled = !!q.enabled;
    if ('at' in q) o.at = hhmm(q.at, o.at);
    if ('auto' in q) o.auto = !!q.auto;
    if ('message' in q) o.message = str(q.message, 200).trim() || 'Die Wünsche öffnen um {zeit} Uhr.';
  }
  if (has('operation') && ['full', 'wishlist'].includes(patch.operation?.mode)) s.operation.mode = patch.operation.mode;
  if (has('sso')) {
    const q = patch.sso, o = s.sso;
    if ('enabled' in q) o.enabled = !!q.enabled;
    if ('issuer' in q) { const u = str(q.issuer, 300).trim(); if (u === '' || /^https:\/\/[^\s]+$/i.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s]*)?$/i.test(u)) o.issuer = u; }
    if ('clientId' in q) o.clientId = str(q.clientId, 200).trim();
    if (q.clientSecret) o.clientSecret = encrypt(str(q.clientSecret, 400));
    if (q.clearSecret) o.clientSecret = '';
    if ('scopes' in q) o.scopes = str(q.scopes, 200).trim().replace(/[^\w .:-]/g, '') || 'openid profile email';
    if ('groupsClaim' in q) o.groupsClaim = str(q.groupsClaim, 60).trim().replace(/[^\w.:-]/g, '') || 'groups';
    if (Array.isArray(q.roleMap)) o.roleMap = q.roleMap.slice(0, 40).map((r) => ({ group: str(r?.group, 120).trim(), role: String(r?.role) })).filter((r) => r.group && ['admin', 'tech', 'mod', 'dj', 'orga', 'display', 'light'].includes(r.role));
    if ('defaultRole' in q) o.defaultRole = ['tech', 'mod', 'dj', 'orga', 'display', 'light', 'admin'].includes(q.defaultRole) ? q.defaultRole : '';
    if ('allowAdmin' in q) o.allowAdmin = !!q.allowAdmin;
    if ('autoCreate' in q) o.autoCreate = !!q.autoCreate;
    if ('autoLinkEmail' in q) o.autoLinkEmail = !!q.autoLinkEmail;
    if ('buttonLabel' in q) o.buttonLabel = str(q.buttonLabel, 40).trim() || 'Mit SSO anmelden';
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
    if ('host' in x) {
      const h = str(x.host, 40).trim();
      if (h && !validX32Host(h)) throw new Error('X32-Adresse: bitte eine IPv4-Adresse aus dem lokalen Netz (z. B. 192.168.1.50).');
      s.x32.host = h;
    }
    if (['sanft', 'normal', 'schnell'].includes(x.faderSpeed)) s.x32.faderSpeed = x.faderSpeed;
    if ('muteAfterFade' in x) s.x32.muteAfterFade = !!x.muteAfterFade;
    if ('port' in x) s.x32.port = Math.round(clamp(x.port, 1, 65535, 10023));
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
    const sp = patch.spotify, o = s.spotify;
    // Bindung Player -> App loesen, wenn die App wegfaellt oder eine andere Client-ID bekommt (der Token gehoert zur alten App)
    const dropPlayersOf = (keep) => { for (const p of [1, 2]) { const id = o.players[p].appId; if (o.players[p].refreshToken && id && !keep(id)) o.players[p] = EMPTY_PLAYER(); } };
    const appFields = (a, prev, i) => ({
      name: str(a?.name, 40).trim() || prev?.name || `App ${i + 1}`,
      clientId: 'clientId' in (a || {}) ? str(a.clientId, 100).trim().replace(/[^A-Za-z0-9]/g, '') : prev?.clientId || '',
      clientSecret: a?.clientSecret ? encrypt(str(a.clientSecret, 100).trim()) : prev?.clientSecret || '',
      search: 'search' in (a || {}) ? !!a.search : prev?.search ?? true,
    });
    if (Array.isArray(sp.apps)) {
      const old = new Map(o.apps.map((a) => [a.id, a]));
      const next = [];
      for (const a of sp.apps.slice(0, 8)) {
        const prev = old.get(String(a?.id));
        const id = prev ? prev.id : newAppId();
        if (next.some((x) => x.id === id)) continue;
        next.push({ id, ...appFields(a, prev, next.length) });
      }
      // Player, die ueber die App aus der .env verbunden sind: zur gleichen Client-ID in der Liste umziehen, sonst trennen
      for (const p of [1, 2]) {
        const pl = o.players[p];
        if (!pl.refreshToken || (pl.appId && pl.appId !== 'env')) continue;
        const same = config.spotifyClientId && next.find((x) => x.clientId === config.spotifyClientId);
        if (same) pl.appId = same.id; else o.players[p] = EMPTY_PLAYER();
      }
      dropPlayersOf((id) => { const n = next.find((x) => x.id === id); return n && n.clientId === (old.get(id)?.clientId ?? n.clientId); });
      o.apps = next;
    }
    // Aeltere Form (eine App): landet in der ersten App der Liste
    if ('clientId' in sp || sp.clientSecret) {
      const first = o.apps[0];
      const f = appFields({ clientId: 'clientId' in sp ? sp.clientId : first?.clientId, clientSecret: sp.clientSecret }, first, 0);
      if (first) { if (f.clientId !== first.clientId) dropPlayersOf((id) => id !== first.id); Object.assign(first, f); }
      else if (f.clientId) o.apps.push({ id: 'main', ...f, name: 'Haupt-App' });
    }
    if ('apiBudget' in sp) o.apiBudget = Math.round(clamp(sp.apiBudget, 20, 300, 60));
    if (sp.players) for (const p of [1, 2]) {
      const pp = sp.players[p];
      if (!pp) continue;
      if ('deviceId' in pp) o.players[p].deviceId = str(pp.deviceId, 100);
      if ('deviceName' in pp) o.players[p].deviceName = str(pp.deviceName, 100);
      if (pp.disconnect) o.players[p] = EMPTY_PLAYER();
    }
  }
  if (has('companion')) {
    const c = patch.companion;
    if ('enabled' in c) s.companion.enabled = !!c.enabled;
    if (typeof c.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(c.tokenHash)) s.companion.tokenHash = c.tokenHash;
    if (c.clearToken) { s.companion.tokenHash = ''; s.companion.enabled = false; }
  }
  if (has('logs')) {
    if ('keepDays' in patch.logs) s.logs.keepDays = Math.round(clamp(patch.logs.keepDays, 1, 365, s.logs.keepDays));
    if ('debug' in patch.logs) s.logs.debug = !!patch.logs.debug;
  }
  if (has('ai')) {
    const q = patch.ai, o = s.ai;
    if ('enabled' in q) o.enabled = !!q.enabled;
    if ('url' in q) { const u = str(q.url, 300).trim().replace(/\/+$/, ''); if (u === '' || /^https?:\/\/[^\s/@]+(:\d+)?(\/[^\s@]*)?$/i.test(u)) o.url = u; }
    if ('model' in q) o.model = str(q.model, 120).trim().replace(/[^\w.:/-]/g, '');
    if (q.token) o.token = encrypt(str(q.token, 300));
    if (q.clearToken) o.token = '';
    if ('timeoutSec' in q) o.timeoutSec = Math.round(clamp(q.timeoutSec, 10, 600, o.timeoutSec));
    if ('autoLight' in q) o.autoLight = !!q.autoLight;
    if ('autoFiller' in q) o.autoFiller = !!q.autoFiller;
  }
  if (has('levels')) {
    const l = patch.levels, o = s.levels;
    for (const p of [1, 2]) {
      if (l.playerDb && p in l.playerDb) o.playerDb[p] = Math.round(clamp(l.playerDb[p], -40, 6, o.playerDb[p]) * 2) / 2;
      if (l.spotifyVol && p in l.spotifyVol) o.spotifyVol[p] = Math.round(clamp(l.spotifyVol[p], 0, 100, o.spotifyVol[p]));
    }
    if ('micControl' in l) o.micControl = !!l.micControl;
    if (Array.isArray(l.micDb)) o.micDb = [0, 1, 2].map((i) => Math.round(clamp(l.micDb[i], -60, 10, o.micDb[i] ?? 0) * 2) / 2);
    if (l.confirm) { o.confirmedAt = Date.now(); o.confirmedBy = str(l.by, 40); }
  }
  saveSettings();
  for (const fn of listeners) fn(s);
  return s;
}

export function setPlayerToken(player, refreshToken, user, appId = '') {
  const s = settings();
  s.spotify.players[player].refreshToken = encrypt(refreshToken);
  s.spotify.players[player].user = user || '';
  s.spotify.players[player].appId = appId || '';
  saveSettings();
  for (const fn of listeners) fn(s);
}

// Alle eingerichteten Spotify-Apps mit Zugangsdaten. Ohne eigene App gilt die aus der .env (id 'env').
export function spotifyApps(envCfg = {}) {
  const list = settings().spotify.apps.filter((a) => a.clientId && a.clientSecret).map((a) => ({ id: a.id, name: a.name, clientId: a.clientId, clientSecret: decrypt(a.clientSecret), search: a.search !== false }));
  if (!list.length && envCfg.spotifyClientId && envCfg.spotifyClientSecret) list.push({ id: 'env', name: 'App aus .env', clientId: envCfg.spotifyClientId, clientSecret: envCfg.spotifyClientSecret, search: true });
  return list;
}
// App eines Players (aeltere Verbindungen ohne appId: die erste App)
export function spotifyApp(appId, envCfg = {}) {
  const list = spotifyApps(envCfg);
  return list.find((a) => a.id === appId) || (appId && settings().spotify.apps.some((a) => a.id === appId) ? null : list[0]) || null;
}
export function spotifyCredentials(envCfg) {
  const a = spotifyApps(envCfg)[0];
  return { clientId: a?.clientId || '', clientSecret: a?.clientSecret || '' };
}

export const playerRefreshToken = (p) => {
  const t = settings().spotify.players[p].refreshToken;
  return t ? decrypt(t) : null;
};
export const notifyToken = () => (settings().notify.token ? decrypt(settings().notify.token) : '');
export const aiToken = () => (settings().ai.token ? decrypt(settings().ai.token) : '');
export const piToken = () => (settings().x32.piToken ? decrypt(settings().x32.piToken) : '');

// Geheimnisse maskiert fuer die Admin-UI
export function publicSettings() {
  const s = structuredClone(settings());
  s.spotify.clientSecret = s.spotify.clientSecret ? '***' : '';
  s.spotify.apps = s.spotify.apps.map((a) => ({ ...a, clientSecret: a.clientSecret ? '***' : '' }));
  for (const p of [1, 2]) {
    s.spotify.players[p].connected = !!s.spotify.players[p].refreshToken;
    delete s.spotify.players[p].refreshToken;
  }
  s.x32.piToken = s.x32.piToken ? '***' : '';
  s.notify.token = s.notify.token ? '***' : '';
  s.ai.token = s.ai.token ? '***' : '';
  s.companion = { enabled: s.companion.enabled, hasToken: !!s.companion.tokenHash };
  s.sso.clientSecret = s.sso.clientSecret || process.env.SSO_CLIENT_SECRET ? '***' : '';
  return s;
}

// Fuer Gaeste und andere Rollen: nur das Noetige
export function guestSettings() {
  const s = settings();
  return { limit: s.limit, explicitMode: s.explicitMode, notice: s.notice.enabled ? s.notice.text : '', wishMessages: s.wishMessages };
}
