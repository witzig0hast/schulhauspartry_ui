import { settings } from './settings.js';
import * as rq from './requests.js';
import { isBlacklisted, playedBlock } from './blocklist.js';
import { isOn } from './features.js';

// Lueckenfueller: ist die Warteschlange leer, waehrend Musik laeuft, wird automatisch ein Song aus der
// Fueller-Playlist eingereiht -- ohne Wiederholungen, ohne gesperrte Songs.
export function playlistId(input) {
  const m = String(input || '').match(/playlist[/:]([A-Za-z0-9]{22})/) || String(input || '').match(/^([A-Za-z0-9]{22})$/);
  return m ? m[1] : null;
}

// Songs aus einer Playlist waehlen: ohne Wiederholungen, ohne gesperrte/explizite Songs.
// relaxed: reicht das nicht (z. B. alles schon einmal gelaufen), werden Wiederholungs-Regeln ignoriert – Sperren und Explicit-Filter gelten immer.
async function pickTracks(engine, playlist, n, avoidMin, now, { relaxed = false } = {}) {
  const id = playlistId(playlist);
  const tracks = await engine.spotify.getPlaylistTracks?.(id || playlist);
  if (!tracks?.length) return [];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const allowed = tracks.filter((t) => !isBlacklisted(t.id, t.artist) && !(settings().explicitMode === 'block' && t.explicit));
  const recent = rq.recentTrackIds(engine.env, now - avoidMin * 60000);
  const fresh = shuffle(allowed.filter((t) => !recent.has(t.id) && !playedBlock(engine.env, t.id, now)));
  if (!relaxed || fresh.length >= n) return fresh.slice(0, n);
  const queued = new Set(rq.upcoming(engine.env).map((u) => u.trackId));
  return [...fresh, ...shuffle(allowed.filter((t) => !fresh.includes(t) && !queued.has(t.id)))].slice(0, n);
}

// Abend-Start: Songs der Start-Playlist in die Warteschlange legen (mindestens `count`)
export async function fillStart(engine, count, now = Date.now()) {
  const sp = settings().start;
  const have = rq.upcoming(engine.env).length;
  if (have >= count) return have;
  const tracks = await pickTracks(engine, sp.playlist, count - have, 240, now, { relaxed: true });
  for (const t of tracks) rq.addAuto(engine.env, t, engine.current);
  if (tracks.length) engine.emit('change');
  return have + tracks.length;
}

export async function maybeFill(engine, now = Date.now()) {
  // Solange noch kein Wunsch angenommen wurde, fuellt die Start-Playlist die Warteschlange; danach der normale Lueckenfueller
  const sp = settings().start;
  const startMode = isOn('startPlaylist') && !!sp.playlist && engine.state.started && rq.noWishesYet(engine.env);
  const cfg = startMode ? { enabled: true, playlist: sp.playlist, minQueue: sp.minQueue, avoidMin: 240 } : settings().filler;
  if (!cfg.enabled || !cfg.playlist || (!startMode && !isOn('filler'))) return null;
  if (engine.state.ended || engine.state.panic || engine.state.emergency) return null;
  const playing = engine.current && engine.players[engine.current].status().playing;
  if (!playing) return null;
  const env = engine.env;
  if (rq.upcoming(env).length >= Math.max(1, cfg.minQueue)) return null;
  if (now - (engine.lastFill || 0) < 20000) return null; // hoechstens alle 20 s
  engine.lastFill = now;

  const id = playlistId(cfg.playlist);
  const tracks = await engine.spotify.getPlaylistTracks?.(id || cfg.playlist);
  if (!tracks?.length) return null;
  const recent = rq.recentTrackIds(env, now - cfg.avoidMin * 60000);
  const ok = tracks.filter((t) => !recent.has(t.id) && !isBlacklisted(t.id, t.artist) && !playedBlock(env, t.id, now)
    && !(settings().explicitMode === 'block' && t.explicit));
  if (!ok.length) return null;
  const pick = ok[Math.floor(Math.random() * ok.length)];
  const row = rq.addAuto(env, pick, engine.current);
  engine.emit('change');
  return row;
}
