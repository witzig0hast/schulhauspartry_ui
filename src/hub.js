import { WebSocketServer } from 'ws';
import { sessionFromToken, can } from './auth.js';
import { parseCookies, unsign, readCookie } from './security.js';
import * as rq from './requests.js';
import { settings, guestSettings } from './settings.js';
import { getDb } from './db.js';
import { listBlacklist, artistNames } from './blocklist.js';
import { recentMessages } from './chat.js';
import { getMeta } from './trackmeta.js';
import { isOn } from './features.js';

const labelOf = (id) => (id ? getDb().prepare('SELECT label FROM accounts WHERE id = ?').get(id)?.label || null : null);
const publicReq = (r) => ({
  id: r.id, title: r.title, artist: r.artist, explicit: r.explicit, votes: r.votes, player: r.player, status: r.status,
  auto: r.deviceId === 'auto', introMs: getMeta(r.trackId)?.intro_ms ?? null, createdAt: r.createdAt, decidedAt: r.decidedAt, playedAt: r.playedAt, genres: r.genres, year: r.year, reason: r.reason, artists: artistNames(r.artist), trackId: r.trackId, prioritized: !!r.prioritizedAt, prioritizedBy: labelOf(r.prioritizedBy), decidedBy: labelOf(r.decidedBy),
});

// Baut den Zustand, den eine Rolle sehen darf.
export function staffState(engine, role, snap = engine.snapshot(), extra = {}) {
  const out = {
    env: engine.env, ts: snap.ts, role,
    players: {}, current: snap.current, crossfade: snap.crossfade, wishMode: snap.wishMode, ended: snap.ended,
    counts: snap.counts, upcoming: snap.upcoming.map(publicReq), upcomingTotal: snap.upcomingTotal,
    settings: {
      fadePresets: settings().fadePresets, rejectReasons: settings().rejectReasons, explicitMode: settings().explicitMode,
      priorityWithin: settings().priorityWithin, limit: settings().limit,
    },
  };
  for (const p of [1, 2]) {
    const pl = snap.players[p];
    out.players[p] = { playing: pl.playing, title: pl.title, artist: pl.artist, positionMs: pl.positionMs, durationMs: pl.durationMs, remainingMs: pl.remainingMs, fading: pl.fading };
    if (can(role, 'viewTech') || can(role, 'viewFoh')) Object.assign(out.players[p], { gain: pl.gain, level: pl.level, meter: pl.meter, connected: pl.connected });
  }
  if (can(role, 'viewTech') || can(role, 'viewFoh')) {
    out.auto = snap.auto; out.panic = snap.panic; out.emergency = snap.emergency;
    out.ducking = snap.ducking;
  }
  if (can(role, 'connections')) { out.mics = snap.mics; out.connections = snap.connections; out.errors = snap.errors; }
  if (can(role, 'viewMod') || can(role, 'viewFoh') || can(role, 'viewTicker')) {
    out.pending = extra.pending.map(publicReq); out.recent = extra.recent.map(publicReq);
    out.later = (extra.later || []).map(publicReq);
    out.history = (extra.history || []).map(publicReq); out.blacklist = extra.blacklist || [];
    out.chat = extra.chat || []; out.claims = extra.claims || []; out.online = extra.online || [];
    out.nowPlayingTitle = engine.nowPlaying();
  }
  if (!can(role, 'viewMod')) { delete out.history; delete out.blacklist; delete out.later; delete out.chat; delete out.claims; delete out.online; }
  if (!can(role, 'viewMod') && !can(role, 'viewTicker')) { delete out.pending; delete out.recent; }
  out.me = extra.me ?? null;
  out.notice = { enabled: settings().notice.enabled, text: settings().notice.text };
  return out;
}

export function guestState(engine, deviceId) {
  const g = guestSettings();
  const np = engine.nowPlaying();
  const mode = engine.wishMode;
  return {
    nowPlaying: np && isOn('guestNowPlaying') ? { title: np.title, artist: np.artist } : null,
    wishMode: mode,
    ended: engine.state.ended,
    message: mode === 'open' ? null : (engine.state.ended ? g.wishMessages.ended : (mode === 'paused' ? g.wishMessages.paused : g.wishMessages.closed)),
    notice: g.notice,
    explicitMode: g.explicitMode,
    limit: rq.limitState(engine.env, deviceId),
    requests: rq.guestRequests(engine.env, deviceId, !!np),
  };
}

export const staffExtra = (env) => ({ pending: rq.pending(env), later: rq.later(env), recent: rq.recentDecisions(env, 40), history: rq.history(env, 40), blacklist: listBlacklist(), chat: recentMessages(env) });

export function createHub(server, engines, { testPrefix, testEnabled, allowedOrigin }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Set();
  // Weiche Sperren: wer gerade an einem Wunsch arbeitet (8 s), und wer online ist
  const claims = new Map(); // `${env}:${id}` -> { label, until, by }
  const claim = (env, id, label, by) => { claims.set(`${env}:${id}`, { label, until: Date.now() + 8000, by }); };
  const release = (env, id, by) => { const c = claims.get(`${env}:${id}`); if (c && c.by === by) claims.delete(`${env}:${id}`); };
  const claimsOf = (env) => { const now = Date.now(); const out = []; for (const [k, v] of claims) { if (v.until < now) { claims.delete(k); continue; } if (k.startsWith(`${env}:`)) out.push({ id: Number(k.split(':')[1]), label: v.label, by: v.by }); } return out; };
  const onlineOf = (env) => [...new Set([...clients].filter((c) => c.env === env && c.session && ['admin', 'tech', 'mod', 'orga'].includes(c.session.role)).map((c) => c.session.label))];
  const extraFor = (env) => ({ ...staffExtra(env), claims: claimsOf(env), online: onlineOf(env) });

  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://x');
      const prefix = testPrefix();
      let env = null;
      if (url.pathname === '/ws') env = 'live';
      else if (url.pathname === `/${prefix}/ws` && testEnabled() && isOn('testMode')) env = 'test';
      if (!env) return socket.destroy();
      const origin = req.headers.origin;
      if (origin && !allowedOrigin(origin, req)) return socket.destroy();
      const cookies = parseCookies(req.headers.cookie || '');
      const session = sessionFromToken(readCookie(cookies, 'sid'));
      const deviceId = unsign(readCookie(cookies, 'dev') || '');
      wss.handleUpgrade(req, socket, head, (ws) => {
        const c = { ws, env, session, deviceId, alive: true, lastGuestSend: 0 };
        clients.add(c);
        ws.on('pong', () => { c.alive = true; });
        ws.on('close', () => clients.delete(c));
        ws.on('error', () => clients.delete(c));
        ws.on('message', (raw) => {
          try {
            const m = JSON.parse(raw.toString());
            if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', ts: m.ts }));
          } catch { /* ignorieren */ }
        });
        sendTo(c);
      });
    } catch { socket.destroy(); }
  });

  function sendTo(c, cache) {
    if (c.ws.readyState !== 1) return;
    const engine = engines[c.env];
    if (c.session) {
      const snap = cache?.snap || engine.snapshot();
      const extra = cache?.extra || extraFor(c.env);
      c.ws.send(JSON.stringify({ type: 'state', data: staffState(engine, c.session.role, snap, { ...extra, me: c.session.accountId ?? 'admin' }) }));
    } else if (c.deviceId) {
      c.ws.send(JSON.stringify({ type: 'guest', data: guestState(engine, c.deviceId) }));
    }
  }

  const lastGuestPush = {};
  function pushEnv(env, { staff = true, guests = false } = {}) {
    const engine = engines[env];
    if (staff) {
      const cache = { snap: engine.snapshot(), extra: extraFor(env) };
      for (const c of clients) if (c.env === env && c.session) sendTo(c, cache);
    }
    if (guests) {
      const now = Date.now();
      if (now - (lastGuestPush[env] || 0) < 400) return schedule(env);
      lastGuestPush[env] = now;
      for (const c of clients) if (c.env === env && !c.session && c.deviceId) sendTo(c);
    }
  }
  const scheduled = {};
  function schedule(env) {
    if (scheduled[env]) return;
    scheduled[env] = setTimeout(() => { scheduled[env] = null; pushEnv(env, { staff: false, guests: true }); }, 450);
  }

  for (const env of Object.keys(engines)) {
    let lastNp = null;
    engines[env].on('tick', () => {
      if (![...clients].some((c) => c.env === env)) return;
      pushEnv(env);
      const np = engines[env].nowPlaying();
      const key = np ? `${np.title}|${np.artist}` : '';
      if (key !== lastNp) { lastNp = key; pushEnv(env, { staff: false, guests: true }); }
    });
    engines[env].on('change', () => pushEnv(env, { guests: true }));
  }

  const hb = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
      c.alive = false; c.ws.ping();
    }
  }, 30000);
  hb.unref?.();

  return {
    pushEnv, claim, release, extraFor,
    clientCount: () => clients.size,
    kickSession: (accountId) => { for (const c of clients) if (c.session?.accountId === accountId) c.ws.close(4001, 'revoked'); },
    closeEnv: (env) => { for (const c of clients) if (c.env === env) c.ws.close(4004, 'disabled'); },
    close: () => { clearInterval(hb); wss.close(); for (const c of clients) c.ws.terminate(); },
  };
}
