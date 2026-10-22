import express from 'express';
import { requirePerm, adminIpGuard, clientIp } from '../auth.js';
import { requireFeature } from '../features.js';
import { audit } from '../audit.js';

// Generalprobe steuern (nur Admin)
export function rehearsalRouter(rehearsal) {
  const r = express.Router();
  const guard = [requireFeature('rehearsal'), adminIpGuard, requirePerm('viewAdmin')];
  const wrap = (fn) => (req, res) => { try { fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
  r.get('/admin/rehearsal', ...guard, (req, res) => res.json(rehearsal.status()));
  r.post('/admin/rehearsal/start', express.json({ limit: '2kb' }), ...guard, wrap((req, res) => {
    const out = rehearsal.start(req.body || {}, req.session.label);
    audit('rehearsal.start', req.session.label, clientIp(req), `${out.current.opt.guests} Gäste, ${out.current.opt.durationMin} Min.`);
    res.json(out);
  }));
  r.post('/admin/rehearsal/stop', ...guard, wrap((req, res) => res.json(rehearsal.stop('abgebrochen'))));
  return r;
}
