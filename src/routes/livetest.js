import express from 'express';
import { requirePerm, adminIpGuard, clientIp } from '../auth.js';
import { requireFeature } from '../features.js';
import { audit } from '../audit.js';

// Live-Test steuern (nur Admin)
export function liveTestRouter(liveTest) {
  const r = express.Router();
  const guard = [requireFeature('liveTest'), adminIpGuard, requirePerm('viewAdmin')];
  const json = express.json({ limit: '2kb' });
  const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
  r.get('/admin/livetest', ...guard, (req, res) => res.json(liveTest.status()));
  r.post('/admin/livetest/start', json, ...guard, wrap((req, res) => {
    const out = liveTest.start(req.body || {}, req.session.label);
    audit('livetest.start', req.session.label, clientIp(req), out.run.simulated ? 'simuliert' : 'echtes Setup');
    res.json(out);
  }));
  r.post('/admin/livetest/answer', json, ...guard, wrap((req, res) => res.json(liveTest.answer(String(req.body?.step || ''), req.body?.value))));
  r.post('/admin/livetest/stop', ...guard, wrap((req, res) => res.json(liveTest.stop())));
  return r;
}
