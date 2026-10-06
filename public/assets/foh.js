import { h, api, connect, topbar, clear, $, fmtTime } from '/assets/app.js';
import { playerSummary, ampel, bar } from '/assets/staff-ui.js';

const app = $('#app');
let state = null;
const clock = h('span', { class: 'muted' });
const playersBox = h('div', { class: 'grid two' });
const metersBox = h('div', { class: 'card stack' });
const micsBox = h('div', { class: 'card stack' });
const upBox = h('div', { class: 'card stack' });
const statusBox = h('div', { class: 'card stack' });
const ampelBox = h('div', { class: 'card' });

function render() {
  if (!state) return;
  clear(playersBox).append(playerSummary(1, state.players[1], { fohStyle: true }), playerSummary(2, state.players[2], { fohStyle: true }));
  clear(metersBox).append(h('h2', {}, 'Pegel'),
    ...[1, 2].map((n) => h('div', { class: 'stack' }, h('div', { class: 'row between small' }, h('span', {}, `Player ${n}`), h('span', { class: 'muted' }, `Fader ${Math.round((state.players[n].level ?? 0) * 100)} %`)), bar(state.players[n].meter ?? 0, 'meter'))));
  clear(micsBox).append(h('h2', {}, 'Mikrofone'),
    ...(state.mics || []).map((m) => h('div', { class: 'stack' }, h('div', { class: 'row between small' }, h('span', {}, m.name), h('span', { class: `badge ${m.open ? 'ok' : ''}` }, m.open ? 'offen' : 'stumm')), bar(m.level, 'meter'))));
  clear(upBox).append(h('h2', {}, `Als Nächstes (${state.upcomingTotal})`),
    ...state.upcoming.slice(0, 8).map((u, i) => h('div', { class: 'row between' }, h('span', {}, `${i + 1}. ${u.title} – ${u.artist}`), h('span', { class: 'row' }, u.prioritized ? h('span', { class: 'badge bad' }, '★') : null, h('span', { class: `badge p${u.player}` }, `P${u.player}`)))),
    state.upcoming.length ? null : h('div', { class: 'muted' }, 'Leer'));
  const bits = [
    ['Wünsche', state.wishMode === 'open' ? 'offen' : state.wishMode === 'paused' ? 'pausiert' : 'geschlossen'],
    ['Offen', state.counts.pending], ['In Queue', state.counts.approved], ['Gespielt', state.counts.played], ['Abgelehnt', state.counts.denied],
    ['Auto-Crossfade', state.auto?.enabled ? `an (${state.auto.crossfadeSec}s)` : 'aus'], ['Ducking', state.ducking?.enabled ? (state.ducking.active ? 'aktiv' : 'an') : 'aus'],
    ['Crossfade', state.crossfade ? `${Math.round(state.crossfade.progress * 100)} %` : '–'],
  ];
  clear(statusBox).append(h('h2', {}, 'Status'), h('div', { class: 'grid three' }, ...bits.map(([k, v]) => h('div', {}, h('div', { class: 'muted tiny' }, k), h('div', { class: 'title' }, String(v))))),
    state.panic ? h('div', { class: 'badge bad' }, 'NOT-AUS AKTIV') : null, state.ended ? h('div', { class: 'badge warn' }, 'ENDE-MODUS') : null);
  if (state.connections) clear(ampelBox).append(ampel(state.connections));
  clock.textContent = new Date().toLocaleTimeString('de-DE');
}

app.append(
  topbar('FOH-Anzeige', { right: [clock] }),
  h('div', { class: 'wrap foh stack' }, playersBox, h('div', { class: 'grid two' }, metersBox, micsBox), h('div', { class: 'grid two' }, upBox, statusBox), ampelBox),
);
connect({ ping: true, onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
void fmtTime;
