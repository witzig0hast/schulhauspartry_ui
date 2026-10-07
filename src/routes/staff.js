import express from 'express';
import {
  login, logout, requirePerm, requireAnyPerm, can, setSessionCookie, clearSessionCookie, clientIp,
} from '../auth.js';
import { parseCookies } from '../security.js';
import * as rq from '../requests.js';
import { applyPatch, settings } from '../settings.js';
import { staffState } from '../hub.js';
import { logEvent } from '../db.js';

const HOME = { admin: '/admin', tech: '/tech', mod: '/mod', orga: '/mod', display: '/foh' };

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
    const out = login(String(req.body?.secret || '').slice(0, 200), clientIp(req));
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    setSessionCookie(req, res, out.token);
    res.json({ ok: true, role: out.role, home: HOME[out.role] });
  });
  r.post('/logout', (req, res) => {
    logout(parseCookies(req.headers.cookie || '').sid);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });
  r.get('/me', (req, res) => {
    if (!req.session) return res.json({ role: null });
    res.json({ role: req.session.role, label: req.session.label, home: HOME[req.session.role], env });
  });

  r.get('/state', requireAnyPerm('viewMod', 'viewFoh'), (req, res) => {
    res.json(staffState(engine, req.session.role, engine.snapshot(), { pending: rq.pending(env), recent: rq.recentDecisions(env) }));
  });

  r.get('/stats', requireAnyPerm('viewStats'), (req, res) => res.json(rq.liveStats(env)));

  // ----- Moderation -----
  r.post('/mod/decide', requirePerm('moderate'), wrap((req, res) => {
    const { id, action, reason, player: pl } = req.body || {};
    if (!['approve', 'deny'].includes(action)) throw new Error('Ungültige Aktion');
    if (action === 'deny' && reason && !settings().rejectReasons.includes(String(reason))) throw new Error('Ungültiger Ablehnungsgrund');
    const out = rq.decide(env, Number(id), { action, reason, player: pl ? Number(pl) : null, accountId: req.session.accountId }, engine.current);
    hub.pushEnv(env, { guests: true });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, request: { id: out.request.id, status: out.request.status, player: out.request.player } });
  }));

  r.post('/mod/prioritize', requirePerm('prioritize'), wrap((req, res) => {
    const out = rq.prioritize(env, Number(req.body?.id), req.session.accountId, engine.current);
    hub.pushEnv(env, { guests: true });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true, position: out.position });
  }));

  r.post('/mod/remove', requirePerm('moderate'), wrap((req, res) => {
    const ok = rq.removeFromQueue(env, Number(req.body?.id), req.session.accountId);
    hub.pushEnv(env, { guests: true });
    res.json({ ok });
  }));

  // ----- Technik -----
  const ctl = requirePerm('control');
  r.post('/control/play', ctl, wrap(async (req, res) => { await engine.play(player(req.body.player)); res.json({ ok: true }); }));
  r.post('/control/pause', ctl, wrap(async (req, res) => { await engine.pause(player(req.body.player)); res.json({ ok: true }); }));
  r.post('/control/fade-in', ctl, wrap(async (req, res) => { await engine.fadeIn(player(req.body.player), num(req.body.sec, 5, 0.1, 120)); res.json({ ok: true }); }));
  r.post('/control/fade-out', ctl, wrap((req, res) => { engine.fadeOut(player(req.body.player), num(req.body.sec, 5, 0.1, 120)); res.json({ ok: true }); }));
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

  r.post('/control/wishmode', requirePerm('wishMode'), wrap((req, res) => {
    engine.setWishMode(String(req.body.mode));
    logEvent(env, 'wishmode', { mode: req.body.mode });
    res.json({ ok: true });
  }));

  // Auto-Crossfade, Ducking und Orga-Hinweis darf auch die Technik aendern
  r.post('/settings/tech', ctl, wrap((req, res) => {
    const allow = ['auto', 'ducking', 'notice', 'wishMessages'];
    applyPatch(req.body || {}, { allow });
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true });
  }));

  return r;
}

export { can };
