import crypto from 'node:crypto';
import { getDb, getSetting, setSetting, transaction } from './db.js';
import { settings } from './settings.js';
import { isOn } from './features.js';
import { isBlocked } from './devices.js';
import { getEnergy } from './autoorder.js';

const db = () => getDb();

// ---------- Wunsch-Voting ----------
export function votingList(env, deviceId, limit = 20) {
  if (!isOn('voting')) return [];
  const rows = db().prepare("SELECT r.id, r.title, r.artist, r.votes, r.created_at, (SELECT 1 FROM votes v WHERE v.request_id = r.id AND v.device_id = ?) AS mine FROM requests r WHERE r.env = ? AND r.status = 'pending'").all(deviceId, env);
  if (settings().voting.sortByVotes) rows.sort((a, b) => b.votes - a.votes || a.created_at - b.created_at);
  else rows.sort((a, b) => a.created_at - b.created_at);
  return rows.slice(0, limit).map((r) => ({ id: r.id, title: r.title, artist: r.artist, votes: r.votes, mine: !!r.mine }));
}

export function voteState(env, deviceId, now = Date.now()) {
  const { votesPerWindow, windowMin } = settings().voting;
  const rows = db().prepare('SELECT ts FROM vote_actions WHERE env = ? AND device_id = ? AND ts > ? ORDER BY ts ASC').all(env, deviceId, now - windowMin * 60000);
  return { used: rows.length, max: votesPerWindow, remaining: Math.max(0, votesPerWindow - rows.length), retryAfterMs: rows.length >= votesPerWindow ? rows[rows.length - votesPerWindow].ts + windowMin * 60000 - now : 0 };
}

export function castVote(env, requestId, deviceId, now = Date.now()) {
  if (!isOn('voting')) return { status: 404, error: 'Voting ist ausgeschaltet.' };
  if (isBlocked(env, deviceId)) return { status: 403, error: 'Dieses Gerät ist gesperrt.' };
  return transaction(() => {
    const row = db().prepare("SELECT * FROM requests WHERE id = ? AND env = ? AND status = 'pending'").get(requestId, env);
    if (!row) return { status: 404, error: 'Dieser Wunsch ist nicht mehr offen.' };
    if (db().prepare('SELECT 1 FROM votes WHERE request_id = ? AND device_id = ?').get(row.id, deviceId)) return { status: 409, error: 'Du hast hier schon ein +1 gegeben.' };
    const vs = voteState(env, deviceId, now);
    if (vs.remaining <= 0) return { status: 429, error: `Du hast gerade genug abgestimmt. Versuch es in ca. ${Math.ceil(vs.retryAfterMs / 60000)} Min. wieder.` };
    db().prepare('INSERT INTO votes(request_id, device_id) VALUES(?,?)').run(row.id, deviceId);
    db().prepare('UPDATE requests SET votes = votes + 1 WHERE id = ?').run(row.id);
    db().prepare('INSERT INTO vote_actions(env, device_id, ts) VALUES(?,?,?)').run(env, deviceId, now);
    return { ok: true, votes: row.votes + 1 };
  });
}

// ---------- Umfragen ----------
const mapPoll = (p, deviceId) => {
  if (!p) return null;
  const options = JSON.parse(p.options);
  const counts = options.map(() => 0);
  for (const v of db().prepare('SELECT option_idx i, COUNT(*) c FROM poll_votes WHERE poll_id = ? GROUP BY option_idx').all(p.id)) if (counts[v.i] != null) counts[v.i] = v.c;
  const mine = deviceId ? db().prepare('SELECT option_idx i FROM poll_votes WHERE poll_id = ? AND device_id = ?').get(p.id, deviceId)?.i ?? null : null;
  return { id: p.id, question: p.question, options, counts, total: counts.reduce((a, b) => a + b, 0), status: p.status, mine };
};
export const currentPoll = (env, deviceId = null) => {
  if (!isOn('polls')) return null;
  // laufende Umfrage, sonst die zuletzt beendete (60 s lang als Ergebnis zeigen)
  const open = db().prepare("SELECT * FROM polls WHERE env = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(env);
  if (open) return mapPoll(open, deviceId);
  const closed = db().prepare("SELECT * FROM polls WHERE env = ? AND status = 'closed' AND closed_at > ? ORDER BY id DESC LIMIT 1").get(env, Date.now() - 90000);
  return mapPoll(closed, deviceId);
};
export function createPoll(env, question, options) {
  if (!isOn('polls')) throw new Error('Umfragen sind ausgeschaltet.');
  const q = String(question || '').trim().slice(0, 120);
  const o = (Array.isArray(options) ? options : []).map((x) => String(x || '').trim().slice(0, 40)).filter(Boolean).slice(0, 5);
  if (!q || o.length < 2) throw new Error('Eine Frage und mindestens zwei Antworten angeben.');
  db().prepare("UPDATE polls SET status = 'closed', closed_at = ? WHERE env = ? AND status = 'open'").run(Date.now(), env);
  const info = db().prepare('INSERT INTO polls(env, question, options, created_at) VALUES(?,?,?,?)').run(env, q, JSON.stringify(o), Date.now());
  return Number(info.lastInsertRowid);
}
export const closePoll = (env) => db().prepare("UPDATE polls SET status = 'closed', closed_at = ? WHERE env = ? AND status = 'open'").run(Date.now(), env).changes > 0;
export function votePoll(env, deviceId, idx) {
  if (!isOn('polls')) return { status: 404, error: 'Umfragen sind ausgeschaltet.' };
  if (isBlocked(env, deviceId)) return { status: 403, error: 'Dieses Gerät ist gesperrt.' };
  const p = db().prepare("SELECT * FROM polls WHERE env = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(env);
  if (!p) return { status: 404, error: 'Die Umfrage ist beendet.' };
  const n = JSON.parse(p.options).length;
  idx = Number(idx);
  if (!Number.isInteger(idx) || idx < 0 || idx >= n) return { status: 400, error: 'Ungültige Antwort.' };
  db().prepare('INSERT OR REPLACE INTO poll_votes(poll_id, device_id, option_idx) VALUES(?,?,?)').run(p.id, deviceId, idx);
  return { ok: true };
}

// ---------- Zeitplan ----------
export const scheduleList = (env, onlyPublic = false) => db().prepare(`SELECT id, at, title, note, public, done FROM schedule WHERE env = ? ${onlyPublic ? 'AND public = 1' : ''} ORDER BY at ASC, id ASC`).all(env).map((r) => ({ ...r, public: !!r.public, done: !!r.done }));
export function scheduleAdd(env, { at, title, note, public: pub }) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at))) throw new Error('Uhrzeit als HH:MM angeben.');
  const t = String(title || '').trim().slice(0, 80);
  if (!t) throw new Error('Titel fehlt.');
  if (db().prepare('SELECT COUNT(*) c FROM schedule WHERE env = ?').get(env).c >= 60) throw new Error('Zu viele Programmpunkte.');
  db().prepare('INSERT INTO schedule(env, at, title, note, public) VALUES(?,?,?,?,?)').run(env, at, t, String(note || '').slice(0, 160) || null, pub ? 1 : 0);
}
export const scheduleDone = (env, id, done) => db().prepare('UPDATE schedule SET done = ? WHERE id = ? AND env = ?').run(done ? 1 : 0, id, env).changes > 0;
export const scheduleRemove = (env, id) => db().prepare('DELETE FROM schedule WHERE id = ? AND env = ?').run(id, env).changes > 0;

// ---------- Rueckblick (geheimer Link) ----------
export function recapToken(regenerate = false) {
  let t = getSetting('recapToken');
  if (!t || regenerate) { t = crypto.randomBytes(18).toString('base64url'); setSetting('recapToken', t); }
  return t;
}
export function recapValid(t) {
  const real = Buffer.from(recapToken()), got = Buffer.from(String(t || ''));
  return real.length === got.length && crypto.timingSafeEqual(real, got);
}
export function recapData(env) {
  const q = (sql, ...p) => db().prepare(sql).all(...p);
  const first = q('SELECT MIN(ts) a, MAX(ts) b, COUNT(*) c FROM plays WHERE env = ?', env)[0];
  const reqs = q("SELECT COUNT(*) c, COUNT(DISTINCT device_id) d FROM requests WHERE env = ? AND device_id NOT IN ('staff','auto')", env)[0];
  return {
    name: settings().brand.name,
    plays: first.c, from: first.a, to: first.b,
    wishes: reqs.c, guests: reqs.d,
    topWished: q("SELECT title, artist, votes FROM requests WHERE env = ? AND status != 'denied' AND device_id NOT IN ('staff','auto') ORDER BY votes DESC, id ASC LIMIT 5", env),
    played: q('SELECT title, artist, ts FROM plays WHERE env = ? ORDER BY ts DESC LIMIT 15', env),
  };
}

// ---------- Oeffentliche Daten (Beamer, Charts, Playlist des Abends) ----------
export function publicData(env, engine, deviceId = null) {
  const np = engine.nowPlaying();
  const out = {
    brand: { name: settings().brand.name, tagline: settings().brand.tagline },
    nowPlaying: np ? { title: np.title, artist: np.artist } : null,
    wishMode: engine.wishMode, pause: engine.state.pauseMode && isOn('pauseMode') ? settings().pause.message : null,
    poll: currentPoll(env, deviceId),
    schedule: isOn('viewSchedule') ? scheduleList(env, true).filter((s) => !s.done) : [],
  };
  if (isOn('viewCharts')) out.charts = db().prepare("SELECT title, artist, votes, status FROM requests WHERE env = ? AND status IN ('pending','approved','playing','later') AND device_id NOT IN ('staff','auto') ORDER BY votes DESC, id ASC LIMIT 10").all(env);
  if (isOn('viewWall')) out.wall = db().prepare('SELECT title, artist, ts FROM plays WHERE env = ? ORDER BY ts DESC LIMIT 40').all(env);
  return out;
}

// ---------- Aktivitaetsverlauf (anonym) ----------
export function activity(env, limit = 120) {
  const q = (sql, ...p) => db().prepare(sql).all(...p);
  const ev = [];
  for (const r of q("SELECT title, artist, created_at, decided_at, status, reason FROM requests WHERE env = ? AND device_id NOT IN ('staff','auto') ORDER BY id DESC LIMIT 200", env)) {
    ev.push({ ts: r.created_at, kind: 'wish', text: `Wunsch: ${r.title} – ${r.artist}` });
    if (r.decided_at && r.status === 'denied') ev.push({ ts: r.decided_at, kind: 'deny', text: `Abgelehnt: ${r.title}${r.reason ? ` (${r.reason})` : ''}` });
    else if (r.decided_at) ev.push({ ts: r.decided_at, kind: 'approve', text: `Angenommen: ${r.title}` });
  }
  for (const p of q('SELECT ts, title, artist FROM plays WHERE env = ? ORDER BY ts DESC LIMIT 100', env)) ev.push({ ts: p.ts, kind: 'play', text: `Gespielt: ${p.title} – ${p.artist}` });
  for (const e of q("SELECT ts, type FROM events WHERE env = ? AND type IN ('panic','emergency','end','wishmode','blacklist','poll') ORDER BY id DESC LIMIT 40", env)) ev.push({ ts: e.ts, kind: 'sys', text: { panic: 'Not-Aus ausgelöst', emergency: 'Notfall-Playlist gestartet', end: 'Ende-Modus', wishmode: 'Wunsch-Modus geändert', blacklist: 'Song gesperrt', poll: 'Umfrage' }[e.type] || e.type });
  return ev.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

export { getEnergy };
