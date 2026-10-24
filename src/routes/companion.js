import express from 'express';
import crypto from 'node:crypto';
import { requirePerm, adminIpGuard, clientIp } from '../auth.js';
import { requireFeature, isOn } from '../features.js';
import { settings, applyPatch } from '../settings.js';
import { sha256, randomToken, RateLimiter } from '../security.js';
import { audit } from '../audit.js';
import * as rq from '../requests.js';
import * as L from '../log.js';

// Hardware-Knoepfe ueber Bitfocus Companion (Stream Deck & Co.), Modul "Generic HTTP":
//   POST {Adresse}/api/companion/action/<name>   Header: Authorization: Bearer <Token>
//   GET  {Adresse}/api/companion/state            -> JSON fuer Variablen/Feedback (Titel, Countdown, Not-Aus …)
// Eigenes Token (nur als Hash gespeichert), eigenes Anfrage-Limit, jeder Druck im Protokoll.
const limiter = new RateLimiter(240, 60000);
const failLimiter = new RateLimiter(20, 10 * 60000);
const pad = (n) => String(n).padStart(2, '0');
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };

export const COMPANION_ACTIONS = {
  crossfade: 'Crossfade zum nächsten Song', panic: 'NOT-AUS (zweimal innerhalb von 4 s drücken)', 'panic-clear': 'Not-Aus aufheben',
  'play-1': 'Player 1 Play', 'play-2': 'Player 2 Play', 'pause-1': 'Player 1 Pause', 'pause-2': 'Player 2 Pause',
  'fade-in-1': 'Player 1 einblenden', 'fade-in-2': 'Player 2 einblenden', 'fade-out-1': 'Player 1 ausblenden', 'fade-out-2': 'Player 2 ausblenden',
  'wishes-open': 'Wünsche öffnen', 'wishes-pause': 'Wünsche pausieren', 'wishes-close': 'Wünsche schließen',
  'pause-mode': 'Pausen-Modus an/aus', 'auto-toggle': 'Auto-Crossfade an/aus', 'ducking-toggle': 'Ducking an/aus',
  emergency: 'Notfall-Playlist an/aus', end: 'Ende-Modus an/aus', stop: 'Stopp / Weiter (sofort still, z. B. Stopptanz)', soundcheck: 'Soundcheck-Modus an (App steuert nichts; einschalten nur durch Admin)',
};
const PLAYBACK = /^(crossfade|panic|play-|pause-\d|fade-|emergency|end)/;

export function companionRouter(env, engine, hub) {
  const r = express.Router();
  const json = express.json({ limit: '1kb' });
  let armedUntil = 0;

  const auth = (req, res, next) => {
    const c = settings().companion;
    if (!isOn('companion') || !c.enabled || !c.tokenHash) return res.status(404).json({ error: 'Companion-Anbindung ist aus.' });
    const ip = clientIp(req);
    if (!limiter.check(ip).ok) return res.status(429).json({ error: 'Zu viele Anfragen.' });
    const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-companion-token'] || '');
    const a = Buffer.from(sha256(raw)), b = Buffer.from(c.tokenHash);
    if (!raw || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      if (failLimiter.check(ip).ok) L.warn('companion', 'companion.denied', `Companion-Anfrage mit falschem Token abgewiesen (${req.method} ${req.path})`, { env, data: { ip, path: req.path } });
      return res.status(401).json({ error: 'Token fehlt oder ist falsch.' });
    }
    next();
  };

  r.get('/companion/state', auth, (req, res) => {
    const s = engine.snapshot();
    const cur = [1, 2].find((n) => n === s.current && s.players[n].playing) || [1, 2].find((n) => s.players[n].playing) || null;
    const p = cur ? s.players[cur] : null;
    const to = s.crossfadeIn ? s.crossfadeIn.inMs : null;
    res.json({
      env, now_title: p?.title || '', now_artist: p?.artist || '', now_player: cur || 0, now_remaining: p ? mmss(p.remainingMs) : '',
      next_title: s.upcoming[0]?.title || '', next_artist: s.upcoming[0]?.artist || '',
      crossfade_in: to != null ? mmss(to) : '', crossfade_in_sec: to != null ? Math.round(to / 1000) : -1, crossfading: !!s.crossfade,
      wish_mode: s.wishMode, queue: s.upcomingTotal, pending: s.counts.pending,
      panic: s.panic, panic_armed: Date.now() < armedUntil, soundcheck: !!s.hold, stopped: !!s.quickStopped, emergency: s.emergency, ended: s.ended, pause_mode: s.pauseMode,
      auto: !!s.auto.enabled, ducking: !!s.ducking.enabled, ducking_active: !!s.ducking.active,
      mics_open: (s.mics || []).filter((m) => m.open).map((m) => m.name).join(', '),
      p1_playing: s.players[1].playing, p2_playing: s.players[2].playing, p1_level: Math.round((s.players[1].level || 0) * 100), p2_level: Math.round((s.players[2].level || 0) * 100),
    });
  });

  r.post('/companion/action/:name', auth, json, async (req, res) => {
    const name = String(req.params.name);
    if (!COMPANION_ACTIONS[name]) return res.status(404).json({ error: 'Unbekannte Aktion', actions: Object.keys(COMPANION_ACTIONS) });
    if (engine.wishlist && PLAYBACK.test(name)) return res.status(409).json({ error: 'Wunschlisten-Modus: Die App spielt keine Musik.' });
    const n = Number(name.slice(-1));
    const sec = Math.min(60, Math.max(0.5, Number(req.query.sec ?? req.body?.sec) || 0)) || null;
    let result = 'ok';
    try {
      switch (name) {
        case 'crossfade': { const o = await engine.startCrossfade(sec || settings().auto.crossfadeSec); result = `Player ${o.player}: ${o.title}`; break; }
        case 'panic':
          if (Date.now() > armedUntil) { armedUntil = Date.now() + 4000; result = 'scharf – nochmal drücken'; break; }
          armedUntil = 0; await engine.panicFire(engine.panicArm()); result = 'ausgelöst'; break;
        case 'panic-clear': engine.panicClear(); break;
        case 'play-1': case 'play-2': await engine.play(n); break;
        case 'pause-1': case 'pause-2': await engine.pause(n); break;
        case 'fade-in-1': case 'fade-in-2': await engine.fadeIn(n, sec || settings().auto.fadeSec || 5); break;
        case 'fade-out-1': case 'fade-out-2': engine.fadeOut(n, sec || settings().auto.fadeSec || 5); break;
        case 'wishes-open': engine.setWishMode('open'); break;
        case 'wishes-pause': engine.setWishMode('paused'); break;
        case 'wishes-close': engine.setWishMode('closed'); break;
        case 'pause-mode': if (!isOn('pauseMode')) throw new Error('Pausen-Modus ist ausgeschaltet.'); engine.setPauseMode(!engine.state.pauseMode); result = engine.state.pauseMode ? 'an' : 'aus'; break;
        case 'auto-toggle': applyPatch({ auto: { enabled: !settings().auto.enabled } }, { allow: ['auto'] }); result = settings().auto.enabled ? 'an' : 'aus'; break;
        case 'ducking-toggle': applyPatch({ ducking: { enabled: !settings().ducking.enabled } }, { allow: ['ducking'] }); result = settings().ducking.enabled ? 'an' : 'aus'; break;
        case 'emergency': if (engine.state.emergency) { engine.emergencyClear(); result = 'beendet'; } else { if (!isOn('emergency')) throw new Error('Notfall-Playlist ist ausgeschaltet.'); await engine.emergencyStart(); result = 'gestartet'; } break;
        case 'stop': if (engine.quickStopped) { await engine.quickGo(); result = 'weiter'; } else { await engine.quickStop(); result = 'gestoppt'; } break;
        case 'soundcheck': if (engine.held) throw Object.assign(new Error('Einschalten darf nur ein Admin (Technik-Ansicht).'), { status: 403 }); engine.startHold({ by: 'Companion' }); result = 'an'; break;
        case 'end': if (engine.state.ended) { engine.endClear(); result = 'aufgehoben'; } else { engine.endEvening(10); result = 'gestartet'; } break;
        default: break;
      }
    } catch (e) {
      L.warn('companion', `companion.${name}`, `Companion „${COMPANION_ACTIONS[name]}“ fehlgeschlagen: ${e.message}`, { env, actor: { kind: 'companion' }, data: { action: name, sec, error: e.message } });
      return res.status(409).json({ error: e.message });
    }
    L.info('companion', `companion.${name}`, `Companion: ${COMPANION_ACTIONS[name]}${result !== 'ok' ? ` – ${result}` : ''}`, { env, actor: { kind: 'companion' }, data: { action: name, sec, result } });
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true, action: name, result, queue: rq.upcoming(env).length });
  });

  // ----- Admin: Token erzeugen, an/aus (nur Live-Umgebung) -----
  if (env === 'live') {
    r.post('/admin/companion/token', requireFeature('companion'), adminIpGuard, requirePerm('viewAdmin'), json, (req, res) => {
      const token = randomToken(32).replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      applyPatch({ companion: { tokenHash: sha256(token), enabled: true } }, { allow: ['companion'] });
      audit('companion.token', req.session.label, clientIp(req));
      res.json({ ok: true, token, actions: COMPANION_ACTIONS });   // Klartext nur dieses eine Mal
    });
  }
  return r;
}
