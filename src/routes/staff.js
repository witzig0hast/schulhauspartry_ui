import express from 'express';
import { holdNotify } from '../notify.js';
import {
  login, logout, requirePerm, requireAnyPerm, can, setSessionCookie, clearSessionCookie, clientIp, homeFor,
} from '../auth.js';
import { parseCookies, readCookie } from '../security.js';
import * as rq from '../requests.js';
import { applyPatch, settings } from '../settings.js';
import { staffState } from '../hub.js';
import { addBlock, removeBlock, listBlacklist, isBlacklisted } from '../blocklist.js';
import { buildAnalytics } from '../analytics.js';
import { isOn, requireFeature } from '../features.js';
import { logEvent, getDb } from '../db.js';
import { audit } from '../audit.js';
import * as L from '../log.js';

const staffActor = (req) => ({ kind: 'staff', label: req.session?.label || null, role: req.session?.role || null });


const num = (v, d, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
const player = (v) => { const n = Number(v); if (n !== 1 && n !== 2) throw Object.assign(new Error('Ungültiger Player'), { status: 400 }); return n; };

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};

export function staffRouter(env, engine, hub) {
  const r = express.Router();
  const json = express.json({ limit: '8kb' });
  r.use(json);

  r.post('/login', (req, res) => {
    const out = login(String(req.body?.secret || '').slice(0, 200), clientIp(req), req.headers['user-agent']);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    setSessionCookie(req, res, out.token);
    res.json({ ok: true, role: out.role, home: homeFor(out.role, out.accountId) });
  });
  r.post('/logout', (req, res) => {
    logout(readCookie(parseCookies(req.headers.cookie || ''), 'sid'));
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });
  r.get('/me', (req, res) => {
    if (!req.session) return res.json({ role: null });
    res.json({ role: req.session.role, label: req.session.label, home: homeFor(req.session.role, req.session.accountId), env });
  });

  r.get('/state', requireAnyPerm('viewMod', 'viewFoh', 'viewLight'), (req, res) => {
    res.json(staffState(engine, req.session.role, engine.snapshot(), { ...hub.extraFor(env), me: req.session.accountId ?? 'admin' }));
  });

  // Auswertungen werden kurz gemerkt: viele offene Boards/Dashboards fragen alle 10 s – berechnet wird nur neu,
  // wenn sich an den Wuenschen etwas geaendert hat oder 15 s vergangen sind
  const results = new Map();
  const fingerprint = getDb().prepare("SELECT COUNT(*) n, MAX(id) i, MAX(decided_at) d, MAX(played_at) p, SUM(votes) v FROM requests WHERE env = ?");
  const remembered = (key, fn) => {
    const fp = JSON.stringify(fingerprint.get(env));
    const hit = results.get(key);
    if (hit && hit.fp === fp && Date.now() - hit.ts < 15000) return hit.value;
    const value = fn();
    results.set(key, { fp, ts: Date.now(), value });
    return value;
  };
  r.get('/stats', requireFeature('viewBoard'), requireAnyPerm('viewStats'), (req, res) => res.json(remembered('stats', () => rq.liveStats(env))));
  r.get('/analytics', requireFeature('viewAnalytics'), requireAnyPerm('viewStats'), (req, res) => {
    const r = Number(req.query.range), range = [0, 15, 60, 120, 360].includes(r) ? r : 0;
    res.json(remembered(`analytics:${range}`, () => buildAnalytics(env, range)));
  });

  // ----- Moderation -----
  r.post('/mod/decide', requirePerm('moderate'), wrap((req, res) => {
    const { id, action, reason, player: pl } = req.body || {};
    if (!['approve', 'deny', 'later'].includes(action)) throw new Error('Ungültige Aktion');
    if (action === 'later' && !isOn('later')) throw new Error('„Später“ ist ausgeschaltet.');
    if (action === 'deny' && reason && !settings().rejectReasons.includes(String(reason))) throw new Error('Ungültiger Ablehnungsgrund');
    const out = rq.decide(env, Number(id), { action, reason, player: pl ? Number(pl) : null, accountId: req.session.accountId }, engine.current);
    if (out.ok && action === 'approve') engine.afterQueueChange(); // Genre-Balance / Stimmung, Meta laden
    if (out.ok) { const q = out.request; L.info('moderation', `request.${action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'later'}`, `${{ approve: 'Angenommen', deny: 'Abgelehnt', later: 'Zurückgestellt' }[action]}: ${q.title} – ${q.artist}${action === 'deny' && reason ? ` (${reason})` : ''}${action === 'approve' && q.player ? ` → Player ${q.player}` : ''}`, { env, actor: staffActor(req), data: { id: q.id, trackId: q.trackId, action, reason: reason || null, player: q.player, votes: q.votes } }); }
    else L.info('moderation', 'request.conflict', `Entscheidung nicht möglich: ${out.error}`, { env, actor: staffActor(req), data: { id, action, status: out.status } });
    hub.pushEnv(env, { guests: true });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, request: { id: out.request.id, status: out.request.status, player: out.request.player } });
  }));

  r.post('/mod/prioritize', requirePerm('prioritize'), wrap((req, res) => {
    const out = rq.prioritize(env, Number(req.body?.id), req.session.accountId, engine.current);
    if (out.ok) L.info('moderation', 'request.prioritized', `Vorgezogen auf Platz ${out.position}: ${out.request.title}`, { env, actor: staffActor(req), data: { id: out.request.id, position: out.position } });
    hub.pushEnv(env, { guests: true });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, position: out.position });
  }));

  r.post('/mod/remove', requirePerm('moderate'), wrap((req, res) => {
    const ok = rq.removeFromQueue(env, Number(req.body?.id), req.session.accountId);
    if (ok) { const q = rq.getRequest(Number(req.body?.id)); L.info('moderation', 'request.removed', `Aus der Warteschlange entfernt: ${q?.title}`, { env, actor: staffActor(req), data: { id: q?.id } }); }
    hub.pushEnv(env, { guests: true });
    res.json({ ok });
  }));

  // ----- Sperrliste & Wiederholungen -----
  r.get('/mod/blacklist', requireAnyPerm('moderate', 'viewMod'), (req, res) => res.json({ blacklist: listBlacklist() }));
  r.post('/mod/blacklist', requireFeature('blacklist'), requirePerm('moderate'), wrap((req, res) => {
    const b = req.body || {};
    const out = addBlock({ kind: b.kind, trackId: b.trackId, title: b.title, artist: b.artist, artistName: b.artistName, reason: b.reason }, req.session.accountId);
    logEvent(env, 'blacklist', { kind: b.kind, label: out.label });
    hub.pushEnv(env, { guests: true }); hub.pushEnv(env === 'live' ? 'test' : 'live', { guests: true });
    res.json({ ok: true, ...out });
  }));
  r.post('/mod/blacklist/remove', requireFeature('blacklist'), requirePerm('moderate'), wrap((req, res) => {
    const ok = removeBlock(Number(req.body?.id));
    hub.pushEnv(env, { guests: true });
    res.json({ ok });
  }));
  // Suche fuer Mitarbeitende (z. B. um einen Song direkt zu sperren)
  r.get('/mod/search', requireFeature('blacklist'), requirePerm('moderate'), wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ tracks: [] });
    const tracks = await engine.spotify.search(q, 8);
    res.json({ tracks: tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist })) });
  }));
  // Admin legt selbst Lieder in die Warteschlange (hinten oder als Naechstes)
  r.get('/queue/search', requirePerm('addSongs'), wrap(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json({ tracks: [] });
    const queued = new Set(rq.upcoming(env).map((u) => u.trackId));
    const tracks = await engine.spotify.search(q, 8);
    res.json({ tracks: tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist, durationMs: t.durationMs, explicit: !!t.explicit, blocked: !!isBlacklisted(t.id, t.artist), queued: queued.has(t.id) })) });
  }));
  r.post('/queue/add', requirePerm('addSongs'), wrap(async (req, res) => {
    const id = String(req.body?.trackId || '');
    if (!/^[A-Za-z0-9]{1,40}$/.test(id)) throw new Error('Ungültiger Song');
    if (rq.upcoming(env).some((u) => u.trackId === id)) return res.status(409).json({ error: 'Der Song ist schon in der Warteschlange.' });
    const t = await engine.spotify.getTrack(id);
    if (!t) return res.status(404).json({ error: 'Song nicht gefunden' });
    if (isBlacklisted(t.id, t.artist)) return res.status(409).json({ error: 'Dieser Song ist gesperrt.' });
    let row = rq.addAuto(env, t, engine.current, Date.now(), { deviceId: 'staff', source: 'team', decidedBy: req.session.accountId ?? null });
    if (req.body?.next) { rq.prioritize(env, row.id, req.session.accountId ?? null, engine.current); row = rq.getRequest(row.id); }
    engine.afterQueueChange();
    L.info('moderation', 'queue.added', `Vom Team eingereiht${req.body?.next ? ' und vorgezogen' : ''}: ${t.title} – ${t.artist}`, { env, actor: staffActor(req), data: { id: row.id, trackId: t.id, next: !!req.body?.next } });
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true, id: row.id, title: t.title });
  }));
  // Schon gespielten (oder abgelehnten/entfernten) Song nochmal einreihen
  r.post('/mod/requeue', requirePerm('moderate'), wrap((req, res) => {
    const row = rq.getRequest(Number(req.body?.id));
    if (!row) return res.status(404).json({ error: 'Song nicht gefunden' });
    if (isBlacklisted(row.trackId, row.artist)) return res.status(409).json({ error: 'Dieser Song ist gesperrt.' });
    const out = rq.requeue(env, Number(req.body.id), req.session.accountId, engine.current);
    if (out.ok) engine.afterQueueChange();
    hub.pushEnv(env, { guests: true });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, player: out.request.player });
  }));

  // ----- Technik -----
  const ctlPerm = requirePerm('control');
  // Im Wunschlisten-Modus gibt es keine Wiedergabe ueber die App (ein DJ spielt selbst)
  const ctl = (req, res, next) => ctlPerm(req, res, () => (settings().operation.mode === 'wishlist' ? res.status(409).json({ error: 'Wunschlisten-Modus: Die App spielt keine Musik ab (der DJ spielt selbst).' }) : next()));
  // Jeder Technik-Knopf landet im Protokoll (wer, was, womit)
  const CTL_TEXT = { play: 'Play', pause: 'Pause', 'fade-in': 'Einblenden', 'fade-out': 'Ausblenden', crossfade: 'Crossfade von Hand', 'panic-clear': 'Not-Aus aufheben', end: 'Ende-Modus', 'end-clear': 'Ende-Modus aufheben', emergency: 'Notfall-Playlist', 'emergency-clear': 'Notfall beenden' };
  r.use('/control/:act', (req, res, next) => {
    const act = req.params.act, t = CTL_TEXT[act];   // merken: req.params aendert sich beim weiteren Routing
    if (!t || req.method !== 'POST') return next();
    let why = null;   // Fehlertext der Antwort mitschreiben, damit im Protokoll steht, WARUM abgelehnt wurde
    const json = res.json.bind(res);
    res.json = (body) => { if (body?.error) why = String(body.error).slice(0, 200); return json(body); };
    res.on('finish', () => L.log(res.statusCode < 400 ? 'info' : 'warn', 'wiedergabe', `control.${act}`, `${t}${req.body?.player ? ` (Player ${req.body.player})` : ''}${res.statusCode >= 400 ? ` – abgelehnt (${res.statusCode}${why ? `: ${why}` : ''})` : ''}`, { env, actor: staffActor(req), data: { action: act, body: req.body || null, status: res.statusCode, error: why } }));
    next();
  });
  r.post('/control/play', ctl, wrap(async (req, res) => { await engine.play(player(req.body.player)); res.json({ ok: true }); }));
  r.post('/control/pause', ctl, wrap(async (req, res) => { await engine.pause(player(req.body.player)); res.json({ ok: true }); }));
  r.post('/control/fade-in', ctl, wrap(async (req, res) => { await engine.fadeIn(player(req.body.player), num(req.body.sec, settings().auto.fadeSec ?? 5, 0.1, 120)); res.json({ ok: true }); }));
  r.post('/control/fade-out', ctl, wrap((req, res) => { engine.fadeOut(player(req.body.player), num(req.body.sec, settings().auto.fadeSec ?? 5, 0.1, 120)); res.json({ ok: true }); }));
  r.post('/control/gain', ctl, wrap((req, res) => { engine.setGain(player(req.body.player), num(req.body.value, 1, 0, 1)); res.json({ ok: true }); }));
  r.post('/control/crossfade', ctl, wrap(async (req, res) => {
    const out = await engine.startCrossfade(num(req.body.sec, 8, 0.1, 120));
    res.json({ ok: true, ...out });
  }));
  r.post('/control/panic-arm', ctl, wrap((req, res) => res.json({ ok: true, nonce: engine.panicArm() })));
  r.post('/control/panic', ctl, wrap(async (req, res) => { await engine.panicFire(String(req.body.nonce || '')); res.json({ ok: true }); }));
  r.post('/control/panic-clear', ctl, wrap((req, res) => { engine.panicClear(); res.json({ ok: true }); }));
  r.post('/control/end', ctl, wrap((req, res) => { engine.endEvening(num(req.body.sec, 10, 1, 120)); res.json({ ok: true }); }));
  r.post('/control/end-clear', ctl, wrap((req, res) => { engine.endClear(); res.json({ ok: true }); }));
  r.post('/control/mic-sim', ctl, wrap((req, res) => {
    if (engine.x32.kind !== 'mock') throw new Error('Nur im simulierten Modus verfügbar.');
    engine.x32.simulateMic(num(req.body.index, 0, 0, 2), !!req.body.open);
    res.json({ ok: true });
  }));

  r.post('/control/emergency', requireFeature('emergency'), ctl, wrap(async (req, res) => { await engine.emergencyStart(); res.json({ ok: true }); }));
  r.post('/control/emergency-clear', ctl, wrap((req, res) => { engine.emergencyClear(); res.json({ ok: true }); }));

  r.post('/control/wishmode', requirePerm('wishMode'), wrap((req, res) => {
    engine.setWishMode(String(req.body.mode));
    logEvent(env, 'wishmode', { mode: req.body.mode });
    res.json({ ok: true });
  }));

  // Pegel-Fenster: Grundpegel, Spotify-Lautstaerke, Mic-Fader, Obergrenze, Ducking und Crossfade-Dauer (gilt sofort)
  r.post('/control/levels', ctl, wrap((req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.levels && typeof b.levels === 'object') patch.levels = { ...b.levels, by: req.session.label };
    if (b.maxGain != null) patch.limits = { maxGain: b.maxGain };
    if (b.duckDb != null) patch.ducking = { db: b.duckDb };
    if (b.crossfadeSec != null) patch.auto = { crossfadeSec: b.crossfadeSec };
    applyPatch(patch, { allow: ['levels', 'limits', 'ducking', 'auto'] });
    if (b.levels?.confirm) { audit('levels.confirm', req.session.label, clientIp(req), JSON.stringify(settings().levels.playerDb)); logEvent(env, 'levels', { by: req.session.label }); }
    hub.pushEnv(env);
    res.json({ ok: true, levels: settings().levels });
  }));
  r.post('/control/level-test', ctl, wrap(async (req, res) => {
    if (req.body?.stop) { await engine.levelTestStop(); return res.json({ ok: true }); }
    const t = await engine.levelTest(player(req.body.player));
    res.json({ ok: true, title: t.title, artist: t.artist });
  }));

  // Auto-Crossfade, Ducking und Orga-Hinweis darf auch die Technik aendern
  // Soundcheck-Modus: App steuert voruebergehend nichts (nur Technik/Admin, nicht im Wunschlisten-Modus noetig)
  r.post('/control/soundcheck', ctlPerm, wrap((req, res) => {
    const by = req.session.label || null;
    if (req.body?.on) engine.startHold({ by, stopMusic: req.body.stopMusic !== false, pauseWishes: req.body.pauseWishes !== false });
    else engine.endHold({ by });
    holdNotify(env, engine.held);
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true, hold: engine.state.hold || null });
  }));
  r.post('/settings/tech', ctlPerm, wrap((req, res) => {
    const allow = ['auto', 'ducking', 'notice', 'wishMessages'];
    applyPatch(req.body || {}, { allow });
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true });
  }));

  return r;
}

export { can };
