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

export async function maybeFill(engine, now = Date.now()) {
  const cfg = settings().filler;
  if (!cfg.enabled || !cfg.playlist || !isOn('filler')) return null;
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
