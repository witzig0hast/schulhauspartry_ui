import express from 'express';
import { requirePerm } from '../auth.js';
import { requireFeature } from '../features.js';
import * as rq from '../requests.js';
import { settings } from '../settings.js';
import { logEvent } from '../db.js';

// DJ-Funktionen: Songs von Hand als "laeuft jetzt" / "gespielt" markieren (Wunschlisten-Modus oder wenn der DJ nebenbei mitschreibt)
export function djRouter(env, engine, hub) {
  const r = express.Router();
  r.use(express.json({ limit: '1kb' }));
  const guard = [requireFeature('viewDj'), requirePerm('viewDj')];
  const act = (path, fn, type) => r.post(path, ...guard, (req, res) => {
    if (settings().operation.mode !== 'wishlist') return res.status(409).json({ error: 'Nur im Wunschlisten-Modus: Im Normalbetrieb spielt die App selbst.' });
    const out = fn(env, Number(req.body?.id));
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    logEvent(env, type, { id: out.request.id });
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true, status: out.request.status });
  });
  act('/dj/now', rq.djNow, 'dj-now');
  act('/dj/played', rq.djPlayed, 'dj-played');
  act('/dj/undo', rq.djUndo, 'dj-undo');
  return r;
}
