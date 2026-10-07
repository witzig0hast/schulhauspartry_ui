import { getDb, transaction, logEvent } from './db.js';
import { settings } from './settings.js';

const db = () => getDb();

const mapRow = (r) => r && ({
  id: r.id, trackId: r.track_id, uri: r.uri, title: r.title, artist: r.artist, album: r.album,
  explicit: !!r.explicit, durationMs: r.duration_ms, createdAt: r.created_at, status: r.status,
  reason: r.reason, decidedBy: r.decided_by, decidedAt: r.decided_at, player: r.player, queuePos: r.queue_pos,
  votes: r.votes, prioritizedBy: r.prioritized_by, prioritizedAt: r.prioritized_at, playedAt: r.played_at,
  deviceId: r.device_id, genres: r.genres ? JSON.parse(r.genres) : null, year: r.year, popularity: r.popularity,
});

export const getRequest = (id) => mapRow(db().prepare('SELECT * FROM requests WHERE id = ?').get(id));

export const upcoming = (env) =>
  db().prepare("SELECT * FROM requests WHERE env = ? AND status = 'approved' ORDER BY queue_pos ASC, id ASC").all(env).map(mapRow);

export const pending = (env) =>
  db().prepare("SELECT * FROM requests WHERE env = ? AND status = 'pending' ORDER BY created_at ASC, id ASC").all(env).map(mapRow);

export const nowPlayingRequest = (env) =>
  mapRow(db().prepare("SELECT * FROM requests WHERE env = ? AND status = 'playing' ORDER BY played_at DESC LIMIT 1").get(env));

export function recentDecisions(env, limit = 30) {
  return db().prepare("SELECT * FROM requests WHERE env = ? AND status IN ('approved','denied','playing','played','removed') AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT ?")
    .all(env, limit).map(mapRow);
}

// ---------- Gaeste ----------

export function limitState(env, deviceId, now = Date.now()) {
  const { count, windowMin } = settings().limit;
  const since = now - windowMin * 60000;
  const rows = db().prepare('SELECT ts FROM guest_actions WHERE env = ? AND device_id = ? AND ts > ? ORDER BY ts ASC').all(env, deviceId, since);
  const used = rows.length;
  const retryAfterMs = used >= count ? rows[used - count].ts + windowMin * 60000 - now : 0;
  return { used, max: count, windowMin, remaining: Math.max(0, count - used), retryAfterMs: Math.max(0, retryAfterMs) };
}

export function songsAhead(env, req, playingNow) {
  const up = upcoming(env);
  const base = playingNow ? 1 : 0;
  if (req.status === 'approved') return base + up.findIndex((u) => u.id === req.id);
  if (req.status === 'pending') {
    const before = pending(env).findIndex((p) => p.id === req.id);
    return base + up.length + Math.max(0, before);
  }
  return null;
}

// Legt einen Wunsch an oder zaehlt bei Duplikaten einen Vote hoch. Alles atomar.
export function submitWish(env, track, deviceId, now = Date.now()) {
  return transaction(() => {
    const lim = limitState(env, deviceId, now);
    if (lim.remaining <= 0) return { result: 'limit', limit: lim };

    const dup = db().prepare("SELECT * FROM requests WHERE env = ? AND track_id = ? AND status IN ('pending','approved','playing') ORDER BY id DESC LIMIT 1").get(env, track.id);
    if (dup) {
      const voted = db().prepare('SELECT 1 FROM votes WHERE request_id = ? AND device_id = ?').get(dup.id, deviceId);
      if (!voted) {
        db().prepare('INSERT INTO votes(request_id, device_id) VALUES(?,?)').run(dup.id, deviceId);
        db().prepare('UPDATE requests SET votes = votes + 1 WHERE id = ?').run(dup.id);
        db().prepare('INSERT INTO guest_actions(env, device_id, ts) VALUES(?,?,?)').run(env, deviceId, now);
      }
      return { result: 'duplicate', request: getRequest(dup.id), alreadyVoted: !!voted, limit: limitState(env, deviceId, now) };
    }

    const info = db().prepare(`INSERT INTO requests(env, track_id, uri, title, artist, album, explicit, duration_ms, device_id, created_at, artist_ids, genres, year, popularity)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(env, track.id, track.uri, track.title, track.artist, track.album || '', track.explicit ? 1 : 0, track.durationMs || 0, deviceId, now,
      JSON.stringify(track.artistIds || []), track.genres ? JSON.stringify(track.genres) : null, track.year ?? null, track.popularity ?? null);
    const id = Number(info.lastInsertRowid);
    db().prepare('INSERT INTO votes(request_id, device_id) VALUES(?,?)').run(id, deviceId);
    db().prepare('INSERT INTO guest_actions(env, device_id, ts) VALUES(?,?,?)').run(env, deviceId, now);
    return { result: 'created', request: getRequest(id), limit: limitState(env, deviceId, now) };
  });
}

export function guestRequests(env, deviceId, playingNow) {
  const rows = db().prepare(`SELECT r.* FROM requests r JOIN votes v ON v.request_id = r.id
    WHERE r.env = ? AND v.device_id = ? ORDER BY r.created_at DESC LIMIT 20`).all(env, deviceId).map(mapRow);
  return rows.map((r) => ({
    id: r.id, title: r.title, artist: r.artist, status: r.status, reason: r.status === 'denied' ? r.reason : null,
    votes: r.votes, player: r.status === 'approved' || r.status === 'playing' ? r.player : null,
    ahead: songsAhead(env, r, playingNow),
    prioritized: !!r.prioritizedAt,
  }));
}

// ---------- Moderation ----------

export function assignPlayer(env, currentPlayer) {
  const up = upcoming(env);
  const count = { 1: 0, 2: 0 };
  for (const u of up) if (u.player) count[u.player]++;
  if (count[1] !== count[2]) return count[1] < count[2] ? 1 : 2;
  const last = up[up.length - 1]?.player ?? currentPlayer;
  return last === 1 ? 2 : 1;
}

// Erster Klick gewinnt: der Statuswechsel passiert nur, wenn der Wunsch noch 'pending' ist.
export function decide(env, id, { action, reason, player, accountId }, currentPlayer, now = Date.now()) {
  return transaction(() => {
    const r = db().prepare('SELECT * FROM requests WHERE id = ? AND env = ?').get(id, env);
    if (!r) return { ok: false, status: 404, error: 'Wunsch nicht gefunden' };
    if (r.status !== 'pending') {
      return { ok: false, status: 409, error: r.status === 'approved' ? 'Wurde bereits von jemand anderem angenommen.' : 'Wurde bereits von jemand anderem bearbeitet.', current: r.status };
    }
    if (action === 'deny') {
      db().prepare("UPDATE requests SET status='denied', reason=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'")
        .run(String(reason || '').slice(0, 80) || null, accountId ?? null, now, id);
    } else {
      const p = player === 1 || player === 2 ? player : assignPlayer(env, currentPlayer);
      const max = db().prepare("SELECT MAX(queue_pos) AS m FROM requests WHERE env = ? AND status='approved'").get(env).m;
      db().prepare("UPDATE requests SET status='approved', player=?, queue_pos=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'")
        .run(p, (max ?? 0) + 1, accountId ?? null, now, id);
    }
    return { ok: true, request: getRequest(id) };
  });
}

export function removeFromQueue(env, id, accountId, now = Date.now()) {
  const res = db().prepare("UPDATE requests SET status='removed', reason='Aus Queue entfernt', decided_by=?, decided_at=? WHERE id=? AND env=? AND status='approved'")
    .run(accountId ?? null, now, id, env);
  return res.changes > 0;
}

export function prioritize(env, id, accountId, currentPlayer, now = Date.now()) {
  return transaction(() => {
    const up = upcoming(env);
    const item = up.find((u) => u.id === id);
    if (!item) return { ok: false, status: 409, error: 'Song ist nicht (mehr) in der Warteschlange.' };
    const rest = up.filter((u) => u.id !== id);
    const idx = Math.min(settings().priorityWithin - 1, rest.length);
    let pos;
    if (rest.length === 0) pos = item.queuePos;
    else if (idx === 0) pos = rest[0].queuePos - 1;
    else if (idx >= rest.length) pos = rest[rest.length - 1].queuePos + 1;
    else pos = (rest[idx - 1].queuePos + rest[idx].queuePos) / 2;
    const prev = idx === 0 ? { player: currentPlayer } : rest[idx - 1];
    const player = prev?.player ? (prev.player === 1 ? 2 : 1) : item.player;
    db().prepare('UPDATE requests SET queue_pos=?, player=?, prioritized_by=?, prioritized_at=? WHERE id=?').run(pos, player, accountId ?? null, now, id);
    return { ok: true, request: getRequest(id), position: idx + 1 };
  });
}

// ---------- Engine ----------

export function markPlaying(env, requestId, player, now = Date.now()) {
  transaction(() => {
    db().prepare("UPDATE requests SET status='played' WHERE env = ? AND status='playing'").run(env);
    const r = db().prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
    db().prepare("UPDATE requests SET status='playing', player=?, played_at=? WHERE id=?").run(player, now, requestId);
    db().prepare('INSERT INTO plays(env, ts, player, title, artist, request_id) VALUES(?,?,?,?,?,?)').run(env, now, player, r.title, r.artist, requestId);
  });
}

export function recordExternalPlay(env, player, title, artist, now = Date.now()) {
  db().prepare("UPDATE requests SET status='played' WHERE env = ? AND status='playing'").run(env);
  db().prepare('INSERT INTO plays(env, ts, player, title, artist, request_id) VALUES(?,?,?,?,?,NULL)').run(env, now, player, title || '?', artist || '');
}

export function reassignPlayer(id, player) { db().prepare('UPDATE requests SET player = ? WHERE id = ?').run(player, id); }

export function counts(env) {
  const row = (s) => db().prepare('SELECT COUNT(*) AS c FROM requests WHERE env = ? AND status = ?').get(env, s).c;
  return { pending: row('pending'), approved: row('approved'), denied: row('denied'), played: row('played') + row('playing') };
}

export function resetEnv(env) {
  transaction(() => {
    db().prepare('DELETE FROM votes WHERE request_id IN (SELECT id FROM requests WHERE env = ?)').run(env);
    for (const t of ['requests', 'guest_actions', 'plays', 'events', 'block_attempts']) db().prepare(`DELETE FROM ${t} WHERE env = ?`).run(env);
  });
  logEvent(env, 'reset', {});
}

// Live-Statistik fuer Dashboards (ohne Bezug zu einzelnen Codes -> anonym)
export function liveStats(env, now = Date.now()) {
  const q = (sql, ...p) => db().prepare(sql).all(...p);
  const since = now - 2 * 3600 * 1000;
  const buckets = Object.fromEntries(q('SELECT (created_at / 600000) * 600000 AS b, COUNT(*) c FROM requests WHERE env = ? AND created_at > ? GROUP BY b', env, since).map((r) => [r.b, r.c]));
  const start = Math.floor(since / 600000) * 600000;
  const series = [];
  for (let t = start; t <= now; t += 600000) series.push({ t, count: buckets[t] || 0 });
  const total = q('SELECT COUNT(*) c FROM requests WHERE env = ?', env)[0].c;
  const decided = q("SELECT COUNT(*) c FROM requests WHERE env = ? AND status IN ('approved','playing','played','removed','denied')", env)[0].c;
  const ok = q("SELECT COUNT(*) c FROM requests WHERE env = ? AND status IN ('approved','playing','played')", env)[0].c;
  return {
    total, approvalRate: decided ? Math.round(100 * ok / decided) : null,
    devices: q('SELECT COUNT(DISTINCT device_id) c FROM guest_actions WHERE env = ?', env)[0].c,
    plays: q('SELECT COUNT(*) c FROM plays WHERE env = ?', env)[0].c,
    top: q("SELECT title, artist, votes FROM requests WHERE env = ? AND status != 'denied' ORDER BY votes DESC, id ASC LIMIT 5", env),
    series,
  };
}

// Genres nachtraeglich eintragen (kommen asynchron von Spotify)
export function setGenres(id, genres) { db().prepare('UPDATE requests SET genres = ? WHERE id = ?').run(JSON.stringify(genres || []), id); }

// Verlauf: gespielte Songs der Umgebung (neueste zuerst)
export function history(env, limit = 40) {
  return db().prepare("SELECT * FROM requests WHERE env = ? AND status IN ('played','playing') AND played_at IS NOT NULL ORDER BY played_at DESC LIMIT ?").all(env, limit).map(mapRow);
}

// Einen schon gespielten (oder abgelehnten/entfernten) Song erneut hinten in die Queue legen
export function requeue(env, id, accountId, currentPlayer, now = Date.now()) {
  return transaction(() => {
    const r = db().prepare('SELECT * FROM requests WHERE id = ? AND env = ?').get(id, env);
    if (!r) return { ok: false, status: 404, error: 'Song nicht gefunden' };
    if (['pending', 'approved'].includes(r.status)) return { ok: false, status: 409, error: 'Der Song ist schon in der Warteschlange.' };
    const inQueue = db().prepare("SELECT 1 FROM requests WHERE env = ? AND track_id = ? AND status IN ('pending','approved')").get(env, r.track_id);
    if (inQueue) return { ok: false, status: 409, error: 'Der Song ist schon in der Warteschlange.' };
    const max = db().prepare("SELECT MAX(queue_pos) AS m FROM requests WHERE env = ? AND status='approved'").get(env).m;
    const info = db().prepare(`INSERT INTO requests(env, track_id, uri, title, artist, album, explicit, duration_ms, device_id, created_at, status, decided_by, decided_at, player, queue_pos, artist_ids, genres, year, popularity)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(env, r.track_id, r.uri, r.title, r.artist, r.album, r.explicit, r.duration_ms, 'staff', now, 'approved', accountId ?? null, now,
      assignPlayer(env, currentPlayer), (max ?? 0) + 1, r.artist_ids, r.genres, r.year, r.popularity);
    return { ok: true, request: getRequest(Number(info.lastInsertRowid)) };
  });
}
