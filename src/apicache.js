import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { dataDirPath } from './db.js';

// Dauerhafter Zwischenspeicher fuer Spotify-Antworten (Songs, Genres, Suchen, Playlists) und Album-Cover.
// Was einmal abgefragt wurde, wird hier gemerkt und nicht erneut bei Spotify angefragt – auch nicht nach einem Neustart.
// Eigene Datei (cache.db): nicht in den Backups, jederzeit loeschbar, die App fragt dann einfach neu.

export const TTL = {
  track: 30 * 86400000,    // Titel, Interpret, Album, Cover aendern sich praktisch nie
  artist: 30 * 86400000,   // Genres eines Interpreten
  search: 12 * 3600000,    // Suchtreffer
  playlist: 3600000,       // Playlists koennen sich aendern
};
const MAX_ROWS = 20000;
const MAX_COVERS = 4000;

let db = null;
const stats = { hits: 0, misses: 0, writes: 0, coverHits: 0, coverFetches: 0, coverFails: 0 };

function open() {
  if (db) return db;
  db = new DatabaseSync(dataDirPath ? path.join(dataDirPath, 'cache.db') : ':memory:');
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS api_cache (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(kind, key));
    CREATE INDEX IF NOT EXISTS api_cache_ts ON api_cache(ts);
    CREATE TABLE IF NOT EXISTS covers (track_id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, ts INTEGER NOT NULL);`);
  return db;
}
// Beim Wechsel der Datenbank (Tests: neue In-Memory-DB) frisch anfangen
export function resetCache() { try { db?.close(); } catch { /* schon zu */ } db = null; for (const k of Object.keys(stats)) stats[k] = 0; }

export function cacheGet(kind, key, maxAgeMs = TTL[kind]) {
  const row = open().prepare('SELECT value, ts FROM api_cache WHERE kind = ? AND key = ?').get(kind, String(key));
  if (!row || (maxAgeMs && Date.now() - row.ts > maxAgeMs)) { stats.misses++; return null; }
  stats.hits++;
  try { return JSON.parse(row.value); } catch { return null; }
}
// Auch abgelaufene Eintraege holen (Notfall: Spotify im Limit)
export function cacheGetStale(kind, key) {
  const row = open().prepare('SELECT value FROM api_cache WHERE kind = ? AND key = ?').get(kind, String(key));
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
export function cacheSet(kind, key, value) {
  open().prepare('INSERT INTO api_cache(kind, key, value, ts) VALUES(?,?,?,?) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, ts = excluded.ts').run(kind, String(key), JSON.stringify(value), Date.now());
  if (++stats.writes % 500 === 0) prune();
}

// ----- Album-Cover -----
export const coverGet = (trackId) => { const r = open().prepare('SELECT mime, data FROM covers WHERE track_id = ?').get(trackId); if (r) stats.coverHits++; return r || null; };
export function coverSet(trackId, mime, data) {
  open().prepare('INSERT OR REPLACE INTO covers(track_id, mime, data, ts) VALUES(?,?,?,?)').run(trackId, mime, data, Date.now());
  if (++stats.coverFetches % 200 === 0) prune();
}
export const coverFailed = () => { stats.coverFails++; };

function prune() {
  const d = open();
  d.prepare(`DELETE FROM api_cache WHERE rowid IN (SELECT rowid FROM api_cache ORDER BY ts DESC LIMIT -1 OFFSET ${MAX_ROWS})`).run();
  d.prepare(`DELETE FROM covers WHERE track_id IN (SELECT track_id FROM covers ORDER BY ts DESC LIMIT -1 OFFSET ${MAX_COVERS})`).run();
}

export function cacheInfo() {
  const d = open();
  const kinds = Object.fromEntries(d.prepare('SELECT kind, COUNT(*) c FROM api_cache GROUP BY kind').all().map((r) => [r.kind, r.c]));
  const cv = d.prepare('SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)), 0) b FROM covers').get();
  return { kinds, covers: cv.c, coverBytes: cv.b, ...stats };
}
export function cacheClear() { const d = open(); d.exec('DELETE FROM api_cache; DELETE FROM covers;'); }
