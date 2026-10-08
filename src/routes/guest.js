import express from 'express';
import { randomToken, sign, unsign, parseCookies, cookieString, isSecure, clientIp, RateLimiter } from '../security.js';
import { settings } from '../settings.js';
import * as rq from '../requests.js';
import { guestState } from '../hub.js';
import { blockReason, logAttempt } from '../blocklist.js';
import { RateLimitError } from '../adapters/spotify-governor.js';

const limited = (res, e) => res.status(503).set('Retry-After', String(Math.ceil(e.retryAfterMs / 1000))).json({ error: 'Spotify macht gerade eine kurze Pause. Gleich geht’s weiter …', retryAfterSec: Math.max(1, Math.ceil(e.retryAfterMs / 1000)) });

const ipLimiter = new RateLimiter(900, 60000);
const searchLimiter = new RateLimiter(25, 20000);

export function deviceMiddleware(req, res, next) {
  const raw = parseCookies(req.headers.cookie || '').dev;
  let id = unsign(raw || '');
  if (!id) {
    id = randomToken(18);
    // Lax: der erste Aufruf kommt per QR-Code aus einer anderen App
    res.append('Set-Cookie', cookieString('dev', sign(id), { maxAgeSec: 60 * 60 * 24 * 365, secure: isSecure(req), sameSite: 'Lax' }));
  }
  req.deviceId = id;
  next();
}

export function guestRouter(env, engine, hub) {
  const r = express.Router();
  const searchCache = new Map();

  r.use(deviceMiddleware);
  r.use((req, res, next) => {
    if (!ipLimiter.check(clientIp(req)).ok) return res.status(429).json({ error: 'Zu viele Anfragen.' });
    next();
  });

  r.get('/state', (req, res) => res.json(guestState(engine, req.deviceId)));

  r.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (q.length < 2) return res.json({ tracks: [] });
    if (!searchLimiter.check(req.deviceId).ok) return res.status(429).json({ error: 'Bitte kurz warten.' });
    const key = q.toLowerCase();
    let tracks = searchCache.get(key);
    if (!tracks || Date.now() - tracks.ts > 5 * 60000) {
      try {
        const found = await engine.spotify.search(q, 8);
        tracks = { ts: Date.now(), list: found };
        searchCache.set(key, tracks);
        if (searchCache.size > 300) searchCache.delete(searchCache.keys().next().value);
      } catch (e) { if (e instanceof RateLimitError) return limited(res, e); return res.status(502).json({ error: 'Die Suche ist gerade nicht erreichbar.' }); }
    }
    const mode = settings().explicitMode;
    res.json({
      tracks: tracks.list.map((t) => {
        const br = blockReason(env, t);
        const explicitBlock = mode === 'block' && t.explicit;
        return { id: t.id, title: t.title, artist: t.artist, blocked: !!br || explicitBlock, blockedText: br ? br.short : explicitBlock ? 'nicht möglich' : null };
      }),
    });
  });

  r.post('/request', express.json({ limit: '2kb' }), async (req, res) => {
    const gs = guestState(engine, req.deviceId);
    if (gs.wishMode !== 'open') return res.status(423).json({ error: gs.message, state: gs });
    const trackId = String(req.body?.trackId || '');
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(trackId)) return res.status(400).json({ error: 'Ungültiger Song.' });
    let track;
    try { track = await engine.spotify.getTrack(trackId); } catch (e) { if (e instanceof RateLimitError) return limited(res, e); return res.status(502).json({ error: 'Spotify ist gerade nicht erreichbar.' }); }
    if (!track) return res.status(404).json({ error: 'Song nicht gefunden.' });
    if (settings().explicitMode === 'block' && track.explicit) { logAttempt(env, 'explicit', track.id); return res.status(403).json({ error: 'Dieser Song ist hier leider nicht möglich.' }); }
    // Gesperrte oder (je nach Regel) schon gespielte Songs: nicht annehmen. Laeuft er gerade, greift der Duplikat-Pfad unten.
    const br = blockReason(env, track);
    if (br) { logAttempt(env, br.kind, track.id); return res.status(403).json({ error: br.text }); }

    const out = rq.submitWish(env, track, req.deviceId);
    if (out.result === 'limit') {
      const min = Math.ceil(out.limit.retryAfterMs / 60000);
      return res.status(429).json({ error: `Du hast dein Limit erreicht. Versuch es in ca. ${min} Min. wieder.`, limit: out.limit });
    }
    hub.pushEnv(env, { guests: true });
    // Genres kommen vom Interpreten und werden nachgeladen (blockiert den Wunsch nie)
    if (out.result === 'created' && !track.genres && engine.spotify.getGenres) {
      engine.spotify.getGenres(track).then((g) => { rq.setGenres(out.request.id, g); }).catch(() => {});
    } else if (out.result === 'created' && track.genres) rq.setGenres(out.request.id, track.genres);
    const np = engine.nowPlaying();
    if (out.result === 'duplicate') {
      const ahead = rq.songsAhead(env, out.request, !!np);
      let info;
      if (out.request.status === 'playing') info = 'Dein Song läuft gerade!';
      else if (out.request.status === 'approved') info = `Dein Song wurde bereits vorgeschlagen und wird voraussichtlich in ca. ${ahead} Songs abgespielt.`;
      else info = 'Dein Song wurde bereits vorgeschlagen und wartet noch auf Freigabe.';
      return res.json({ ok: true, duplicate: true, alreadyVoted: out.alreadyVoted, info, votes: out.request.votes, state: guestState(engine, req.deviceId) });
    }
    res.json({ ok: true, duplicate: false, info: 'Dein Wunsch ist angekommen und wartet auf Freigabe.', state: guestState(engine, req.deviceId) });
  });

  return r;
}
