import { settings } from './settings.js';
import { sendNotify } from './notify.js';
import * as rq from './requests.js';
import { isOn } from './features.js';

// Ueberwacht Verbindungen und Betrieb und meldet Probleme per ntfy -- erst nach `downSec` Sekunden Stoerung
// (kein Alarm bei kurzem Ruckeln) und mit "wieder ok" nach der Entwarnung.
export function createMonitor(engines) {
  const state = new Map(); // key -> { since, alerted }
  let timer;

  const enabled = (ev) => isOn('notify') && settings().notify.enabled && settings().notify.events[ev] !== false;

  async function check(key, ev, env, isDown, downText, upText, { priority = 4 } = {}) {
    const k = `${env}:${key}`;
    const s = state.get(k) || { since: null, alerted: false };
    const now = Date.now();
    if (isDown) {
      s.since ??= now;
      if (!s.alerted && now - s.since >= settings().notify.downSec * 1000 && enabled(ev)) {
        s.alerted = true;
        await sendNotify({ title: '⚠️ Problem bei der Party', message: downText, priority, tags: ['warning'], key: `down:${k}`, env });
      }
    } else {
      if (s.alerted && enabled(ev)) await sendNotify({ title: '✅ Wieder in Ordnung', message: upText, priority: 3, tags: ['white_check_mark'], key: `up:${k}`, env });
      s.since = null; s.alerted = false;
    }
    state.set(k, s);
  }

  async function tick() {
    for (const [env, e] of Object.entries(engines)) {
      if (!e.realConnections && env !== 'live') continue;
      const c = e.connections();
      const hw = e.realConnections;
      if (hw && e.x32.kind === 'http') await check('x32', 'x32', env, c.x32.ok === false, 'X32/Pi ist nicht erreichbar – Fader und Mics gehen nicht.', 'X32/Pi ist wieder erreichbar.');
      if (hw) await check('spotify', 'spotify', env, c.spotify.ok === false || (c.spotify.ok === null && /Limit/.test(c.spotify.detail)), `Spotify: ${c.spotify.detail}`, 'Spotify läuft wieder.');
      for (const n of [1, 2]) {
        const real = e.players[n].kind === 'real';
        const p = c[`player${n}`];
        if (real) await check(`player${n}`, 'player', env, p.ok === false, `Player ${n} ist nicht mit Spotify verbunden (${p.detail}).`, `Player ${n} ist wieder verbunden.`);
      }
      // Party laeuft, aber nichts mehr in der Warteschlange und kein Fueller aktiv
      const playing = [1, 2].some((n) => e.players[n].status().playing);
      const empty = playing && rq.upcoming(env).length === 0 && !e.state.ended && !(settings().filler.enabled && settings().filler.playlist);
      await check('queue', 'queueEmpty', env, empty, 'Die Warteschlange ist leer – bald könnte Stille entstehen.', 'Die Warteschlange hat wieder Songs.', { priority: 3 });
    }
  }

  // Einmalige Ereignisse direkt melden
  for (const [env, e] of Object.entries(engines)) {
    e.on('panic', () => { if (enabled('panic')) sendNotify({ title: '🛑 NOT-AUS ausgelöst', message: 'Die Technik hat den Not-Aus gedrückt – beide Player gestoppt.', priority: 5, tags: ['rotating_light'], key: `panic:${env}`, env }); });
    e.on('emergency', () => { if (enabled('emergency')) sendNotify({ title: '🆘 Notfall-Playlist gestartet', message: 'Die Notfall-Playlist läuft.', priority: 4, tags: ['sos'], key: `emergency:${env}`, env }); });
  }

  return {
    start() { timer = setInterval(() => tick().catch(() => {}), 5000); timer.unref?.(); },
    stop() { clearInterval(timer); },
    tick, state,
  };
}
