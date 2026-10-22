import express from 'express';
import { requirePerm, adminIpGuard, clientIp } from '../auth.js';
import { requireFeature } from '../features.js';
import { audit } from '../audit.js';
import { settings, applyPatch } from '../settings.js';
import { getSetting } from '../db.js';
import { RateLimiter } from '../security.js';
import * as ai from '../ai.js';
import { prepChecks } from './ops.js';
import { buildReport } from './admin.js';
import { buildAnalytics } from '../analytics.js';
import * as rq from '../requests.js';

// KI-Funktionen (Ollama). Alles nur fuer Technik/Admin; jede Person hoechstens 12 KI-Anfragen pro Minute.
const limiter = new RateLimiter(12, 60000);

export function aiRouter(env, engine, hub, { engines }) {
  const r = express.Router();
  const json = express.json({ limit: '4kb' });
  const ctl = requirePerm('control');
  const throttle = (req, res, next) => (limiter.check(`${req.session?.tokenHash || clientIp(req)}`).ok ? next() : res.status(429).json({ error: 'Zu viele KI-Anfragen – kurz warten.' }));
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 502).json({ error: e.message }); } };
  const ready = (req, res, next) => (ai.aiReady() ? next() : res.status(409).json({ error: 'Die KI ist nicht eingerichtet (Admin → KI).' }));

  r.get('/ai/status', requirePerm('viewTech'), (req, res) => res.json({ ...ai.aiStats(), features: { energy: ai.aiOn('aiEnergy'), filler: ai.aiOn('aiFiller'), light: ai.aiOn('aiLight'), help: ai.aiOn('aiHelp'), recap: ai.aiOn('aiRecap') } }));

  // 3: Energie-Kurve
  r.post('/ai/energy', requireFeature('aiEnergy'), ctl, ready, throttle, json, wrap(async (req, res) => res.json(await ai.suggestEnergy(engine))));
  r.post('/ai/energy/apply', requireFeature('aiEnergy'), ctl, json, wrap((req, res) => {
    ai.applyOrder(env, req.body?.order);
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true });
  }));

  // 4: Lueckenfueller
  r.post('/ai/filler', requireFeature('aiFiller'), ctl, ready, throttle, json, wrap(async (req, res) => res.json({ suggestions: await ai.suggestFiller(engine, 6) })));
  r.post('/ai/filler/add', requireFeature('aiFiller'), ctl, json, wrap(async (req, res) => {
    const row = await ai.addSuggested(engine, req.body?.trackId);
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true, title: row.title });
  }));

  // 5: Licht-Vorschlag fuer einen Song neu erzeugen (sonst laufen sie automatisch im Hintergrund)
  r.post('/ai/light', requireFeature('aiLight'), ctl, ready, throttle, json, wrap(async (req, res) => {
    const row = [...rq.upcoming(env), ...rq.history(env, 10)].find((x) => x.id === Number(req.body?.id));
    if (!row) throw Object.assign(new Error('Song nicht gefunden'), { status: 404 });
    res.json({ cue: await ai.makeLightCue(row) });
    hub.pushEnv(env);
  }));

  // 7: Fehler-Assistent
  r.post('/ai/help', requireFeature('aiHelp'), requirePerm('viewTech'), ready, throttle, json, wrap(async (req, res) => {
    const s = settings();
    const checks = await prepChecks(env, engine, engines).catch(() => []);
    const lt = getSetting('livetest:last', null);
    const st = engine.snapshot();
    const context = {
      umgebung: env === 'test' ? 'Testmodus' : 'Live', uhrzeit: new Date().toLocaleTimeString('de-DE', { timeZone: s.timezone }),
      betriebsart: s.operation.mode === 'wishlist' ? 'Nur Wunschliste (DJ spielt selbst)' : 'Normalbetrieb (App spielt)',
      echte_verbindungen_bei: s.test.realEnv, verbindungen: st.connections,
      player: [1, 2].map((n) => ({ player: n, spielt: st.players[n].playing, song: st.players[n].title || null, verbunden: st.players[n].connected, pegel_am_pult: Math.round((st.players[n].meter || 0) * 100), fader_prozent: Math.round((st.players[n].level || 0) * 100), konto_verbunden: !!s.spotify.players[n].refreshToken, geraet: s.spotify.players[n].deviceName || (s.spotify.players[n].deviceId ? 'gewählt' : 'automatisch') })),
      zustand: { not_aus: st.panic, notfall_playlist: st.emergency, ende_modus: st.ended, pause: st.pauseMode, wuensche: st.wishMode, warteschlange: st.upcomingTotal, auto_crossfade: s.auto.enabled, ducking: s.ducking.enabled, mics: (st.mics || []).map((m) => ({ name: m.name, offen: m.open })) },
      x32: { anbindung: s.x32.adapter === 'http' ? 'Pi-Relay' : 'simuliert', pi_urls: s.x32.piUrl ? s.x32.piUrl.split(/[\s,;]+/).length : 0, kanaele: s.x32.channels },
      spotify_apps: s.spotify.apps.length || (engine.spotify.kind === 'real' ? 1 : 0),
      fehler: engine.errors.slice(0, 15).map((e) => ({ zeit: new Date(e.ts).toLocaleTimeString('de-DE', { timeZone: s.timezone }), meldung: e.msg })),
      pruefliste: checks.filter((c) => c.status !== 'ok').map((c) => ({ punkt: `${c.group}: ${c.label}`, status: c.status, detail: c.detail })),
      letzter_live_test: lt ? { ergebnis: lt.verdict, wann: new Date(lt.endedAt || lt.startedAt).toLocaleString('de-DE', { timeZone: s.timezone }), probleme: (lt.steps || []).filter((x) => x.status === 'fail' || x.status === 'warn').map((x) => `${x.title}: ${x.detail}`) } : null,
    };
    res.json(await ai.diagnose(context, req.body?.question));
  }));

  // ----- Admin: Einrichtung und Rueckblick (nur Live-Umgebung) -----
  if (env === 'live') {
    const adm = [adminIpGuard, requirePerm('viewAdmin')];
    r.post('/admin/ai/models', ...adm, json, wrap(async (req, res) => {
      const url = req.body?.url != null ? String(req.body.url).trim().replace(/\/+$/, '') : settings().ai.url;
      if (url && url !== settings().ai.url) applyPatch({ ai: { url } }, { allow: ['ai'] });
      if (req.body?.token) applyPatch({ ai: { token: req.body.token } }, { allow: ['ai'] });
      res.json({ models: await ai.listModels(settings().ai.url) });
    }));
    r.post('/admin/ai/test', ...adm, throttle, json, wrap(async (req, res) => {
      const t0 = Date.now();
      const out = await ai.chat({ system: 'Antworte nur mit dem JSON {"ok": true, "gruss": "<kurzer Gruß auf Deutsch>"}.', user: 'Test', schema: { type: 'object', properties: { ok: { type: 'boolean' }, gruss: { type: 'string' } }, required: ['ok', 'gruss'] }, maxTokens: 60 });
      audit('ai.test', req.session.label, clientIp(req), settings().ai.model);
      res.json({ ok: true, ms: Date.now() - t0, reply: String(out.gruss || '').slice(0, 120) });
    }));
    r.get('/admin/ai/recap', ...adm, (req, res) => res.json({ recap: ai.lastRecap(req.query.env === 'test' ? 'test' : 'live') }));
    r.post('/admin/ai/recap', requireFeature('aiRecap'), ...adm, ready, throttle, json, wrap(async (req, res) => {
      const e = req.body?.env === 'test' ? 'test' : 'live';
      res.json({ recap: await ai.writeRecap(e, buildReport(e), buildAnalytics(e, 0)) });
    }));
  }
  return r;
}
