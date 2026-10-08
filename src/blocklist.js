import { getDb, transaction } from './db.js';
import { settings } from './settings.js';
import { isOn } from './features.js';

const db = () => getDb();

export const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
export const artistNames = (artist) => String(artist || '').split(', ').map((a) => a.trim()).filter(Boolean);

export const listBlacklist = () => db().prepare('SELECT * FROM blacklist ORDER BY created_at DESC').all().map((r) => ({
  id: r.id, kind: r.kind, key: r.key, title: r.title, artist: r.artist, reason: r.reason, createdAt: r.created_at,
}));

// Sperrt einen Song oder Interpreten und raeumt Wuensche/Queue aller Umgebungen auf.
export function addBlock({ kind, trackId, title, artist, artistName, reason }, accountId, now = Date.now()) {
  if (!['track', 'artist'].includes(kind)) throw new Error('Ungültige Art');
  const key = kind === 'track' ? String(trackId || '') : normName(artistName);
  if (!key) throw new Error('Song/Interpret fehlt');
  const label = kind === 'track' ? title : artistName;
  return transaction(() => {
    db().prepare('INSERT OR IGNORE INTO blacklist(kind, key, title, artist, reason, created_by, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(kind, key, kind === 'track' ? String(title || '').slice(0, 120) : null, kind === 'track' ? String(artist || '').slice(0, 200) : String(artistName).slice(0, 120), String(reason || '').slice(0, 80) || null, accountId ?? null, now);
    // betroffene offene Wuensche ablehnen, Queue-Eintraege entfernen
    const rows = db().prepare("SELECT id, track_id, artist, status FROM requests WHERE status IN ('pending','later','approved')").all();
    let denied = 0, removed = 0;
    for (const r of rows) {
      const hit = kind === 'track' ? r.track_id === key : artistNames(r.artist).some((a) => normName(a) === key);
      if (!hit) continue;
      if (r.status === 'pending' || r.status === 'later') { db().prepare("UPDATE requests SET status='denied', reason='Gesperrt', decided_by=?, decided_at=? WHERE id=?").run(accountId ?? null, now, r.id); denied++; }
      else { db().prepare("UPDATE requests SET status='removed', reason='Gesperrt', decided_by=?, decided_at=? WHERE id=?").run(accountId ?? null, now, r.id); removed++; }
    }
    return { label, denied, removed };
  });
}

export const removeBlock = (id) => db().prepare('DELETE FROM blacklist WHERE id = ?').run(id).changes > 0;

export function isBlacklisted(trackId, artist) {
  const t = db().prepare("SELECT 1 FROM blacklist WHERE kind='track' AND key=?").get(trackId);
  if (t) return { kind: 'track' };
  const names = artistNames(artist).map(normName);
  if (names.length) {
    const rows = db().prepare("SELECT key FROM blacklist WHERE kind='artist'").all();
    const set = new Set(rows.map((r) => r.key));
    if (names.some((n) => set.has(n))) return { kind: 'artist' };
  }
  return null;
}

// Wurde der Song schon gespielt? -> je nach Regel sperren
export function playedBlock(env, trackId, now = Date.now()) {
  const { mode, cooldownMin } = settings().replay;
  if (mode === 'allow') return null;
  const row = db().prepare("SELECT played_at FROM requests WHERE env = ? AND track_id = ? AND status = 'played' ORDER BY played_at DESC LIMIT 1").get(env, trackId);
  if (!row?.played_at) return null;
  const agoMin = Math.floor((now - row.played_at) / 60000);
  if (mode === 'block') return { agoMin, waitMin: null };
  const waitMin = cooldownMin - agoMin;
  return waitMin > 0 ? { agoMin, waitMin } : null;
}

// Gemeinsame Pruefung fuer Suche und Wunsch. null = erlaubt.
export function blockReason(env, track, now = Date.now()) {
  if (isOn('blacklist') && isBlacklisted(track.id, track.artist)) return { kind: 'blacklist', short: 'nicht möglich', text: 'Dieser Song ist hier leider nicht möglich.' };
  const p = isOn('replayRule') ? playedBlock(env, track.id, now) : null;
  if (p) {
    const ago = p.agoMin < 1 ? 'gerade eben' : `vor ${p.agoMin} Min.`;
    return { kind: 'played', short: 'lief schon', text: p.waitMin == null ? `Dieser Song wurde heute schon gespielt (${ago}).` : `Dieser Song lief ${ago} – in ca. ${p.waitMin} Min. kannst du ihn wieder wünschen.` };
  }
  return null;
}

export function logAttempt(env, kind, key, now = Date.now()) {
  db().prepare('INSERT INTO block_attempts(env, ts, kind, key) VALUES(?,?,?,?)').run(env, now, kind, key || null);
}
