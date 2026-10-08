import express from 'express';
import { requirePerm, requireAnyPerm, clientIp } from '../auth.js';
import { requireFeature, isOn } from '../features.js';
import { applyPatch, settings } from '../settings.js';
import { audit } from '../audit.js';
import { logEvent } from '../db.js';
import { setEnergy } from '../autoorder.js';
import * as x from '../extras.js';

const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };

export function extrasRouter(env, engine, hub) {
  const r = express.Router();
  r.use(express.json({ limit: '4kb' }));
  const push = () => hub.pushEnv(env, { guests: true });

  // Pausen-Modus, Stimmungs-Knopf, Lautstaerke-Merker
  r.post('/control/pause-mode', requireFeature('pauseMode'), requirePerm('wishMode'), wrap((req, res) => {
    engine.setPauseMode(!!req.body?.on);
    logEvent(env, 'wishmode', { pause: !!req.body?.on });
    push(); res.json({ ok: true });
  }));
  r.post('/control/energy', requireFeature('energyKnob'), requirePerm('moderate'), wrap((req, res) => {
    const v = Math.sign(Number(req.body?.v) || 0);
    setEnergy(env, v); engine.afterQueueChange(); push();
    res.json({ ok: true, v });
  }));
  r.post('/control/gain-remember', requireFeature('gainMemory'), requirePerm('control'), wrap((req, res) => {
    const p = Number(req.body?.player);
    if (p !== 1 && p !== 2) throw new Error('Ungültiger Player');
    res.json({ ok: true, gain: engine.rememberGain(p) });
  }));

  // Umfragen
  r.post('/poll', requireFeature('polls'), requirePerm('control'), wrap((req, res) => {
    const id = x.createPoll(env, req.body?.question, req.body?.options);
    logEvent(env, 'poll', { id }); push(); res.json({ ok: true, id });
  }));
  r.post('/poll/close', requireFeature('polls'), requirePerm('control'), wrap((req, res) => { const ok = x.closePoll(env); push(); res.json({ ok }); }));
  r.get('/poll', requireFeature('polls'), requireAnyPerm('viewMod', 'viewFoh'), (req, res) => res.json({ poll: x.currentPoll(env) }));

  // Zeitplan
  r.get('/schedule', requireFeature('viewSchedule'), requirePerm('viewSchedule'), (req, res) => res.json({ items: x.scheduleList(env), tz: settings().timezone }));
  r.post('/schedule', requireFeature('viewSchedule'), requirePerm('control'), wrap((req, res) => { x.scheduleAdd(env, req.body || {}); push(); res.json({ ok: true }); }));
  r.post('/schedule/:id/done', requireFeature('viewSchedule'), requirePerm('control'), wrap((req, res) => { res.json({ ok: x.scheduleDone(env, Number(req.params.id), req.body?.done !== false) }); push(); }));
  r.delete('/schedule/:id', requireFeature('viewSchedule'), requirePerm('control'), wrap((req, res) => { const ok = x.scheduleRemove(env, Number(req.params.id)); push(); res.json({ ok }); }));

  // Uebergabe-Notiz
  r.post('/handover', requireFeature('handover'), requirePerm('moderate'), wrap((req, res) => {
    applyPatch({ handover: { text: req.body?.text, by: req.session.label } }, { allow: ['handover'] });
    push(); res.json({ ok: true });
  }));

  // Aktivitaetsverlauf
  r.get('/activity', requireFeature('viewActivity'), requirePerm('viewActivity'), (req, res) => res.json({ events: x.activity(env) }));

  // Rueckblick: Admin verwaltet den Link, Besucher brauchen den geheimen Teil
  r.get('/admin/recap', requirePerm('viewAdmin'), (req, res) => res.json({ token: x.recapToken(), enabled: isOn('viewRecap') }));
  r.post('/admin/recap/regenerate', requirePerm('viewAdmin'), wrap((req, res) => { audit('recap.regenerate', req.session.label, clientIp(req)); res.json({ token: x.recapToken(true) }); }));
  r.get('/recap/:token', requireFeature('viewRecap'), (req, res) => {
    if (!x.recapValid(req.params.token)) return res.status(404).json({ error: 'Nicht gefunden' });
    res.json(x.recapData(env));
  });
  return r;
}
