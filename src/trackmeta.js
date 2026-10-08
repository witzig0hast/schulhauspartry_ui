import { getDb } from './db.js';

// Intro-/Outro-Zeiten pro Song (aus Spotify-Audioanalyse, falls verfuegbar). Dient der "smarten" Crossfade-Zeit:
// der Uebergang beginnt, wenn der Song ausklingt, nicht mitten im Refrain.
const TTL = 24 * 3600 * 1000;

export function getMeta(trackId) {
  return trackId ? getDb().prepare('SELECT intro_ms, outro_ms, src FROM track_meta WHERE track_id = ?').get(trackId) || null : null;
}

export async function ensureMeta(spotify, track) {
  if (!track?.id || !spotify.getTrackMeta) return null;
  const known = getDb().prepare('SELECT ts FROM track_meta WHERE track_id = ?').get(track.id);
  if (known && Date.now() - known.ts < TTL) return getMeta(track.id);
  let meta = null;
  // Dauer aus der Datenbank ergaenzen, falls der Aufrufer nur die ID hat
  if (!track.durationMs) track = { ...track, durationMs: getDb().prepare('SELECT duration_ms d FROM requests WHERE track_id = ? ORDER BY id DESC LIMIT 1').get(track.id)?.d };
  try { meta = await spotify.getTrackMeta(track); } catch { /* Limit/nicht verfuegbar: spaeter nochmal */ return null; }
  getDb().prepare('INSERT INTO track_meta(track_id, intro_ms, outro_ms, src, ts) VALUES(?,?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET intro_ms=excluded.intro_ms, outro_ms=excluded.outro_ms, src=excluded.src, ts=excluded.ts')
    .run(track.id, meta?.introMs ?? null, meta?.outroMs ?? null, meta ? meta.src : 'none', Date.now());
  return getMeta(track.id);
}
