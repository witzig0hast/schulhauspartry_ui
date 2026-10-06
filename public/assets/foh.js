import { h, api, connect, topbar, clear, cover, $ } from '/assets/app.js';
import { playerSummary, ampel, bar, kpi } from '/assets/staff-ui.js';

const app = $('#app');
let state = null;
const clock = h('span', { class: 'pill mono' });
const top = topbar('FOH-Anzeige', { right: [clock] });
const root = h('div', { class: 'wrap foh' });
const playersBox = h('div', { class: 'grid two' });
const kpiBox = h('div', { class: 'kpis' });
const metersBox = h('div', { class: 'card stack' });
const micsBox = h('div', { class: 'card stack' });
const upBox = h('div', { class: 'card' });
const statusBox = h('div', { class: 'card stack' });
const ampelBox = h('div', { class: 'card' });

const section = (title, ...c) => [h('div', { class: 'card-head' }, h('h2', {}, title)), ...c];

function render() {
  if (!state) return;
  clear(kpiBox).append(kpi('Offen', state.counts.pending, { hot: state.counts.pending > 0 }), kpi('In Queue', state.counts.approved), kpi('Gespielt', state.counts.played), kpi('Abgelehnt', state.counts.denied));
  clear(playersBox).append(playerSummary(1, state.players[1], { fohStyle: true, onAir: state.current === 1 && state.players[1].playing }), playerSummary(2, state.players[2], { fohStyle: true, onAir: state.current === 2 && state.players[2].playing }));
  clear(metersBox).append(...section('Pegel', ...[1, 2].map((n) => h('div', { class: 'stack', style: 'gap:6px' },
    h('div', { class: 'row between small' }, h('strong', {}, `Player ${n}`), h('span', { class: 'muted mono' }, `Fader ${Math.round((state.players[n].level ?? 0) * 100)} %`)), bar(state.players[n].meter ?? 0, 'meter')))));
  clear(micsBox).append(...section('Mikrofone', ...(state.mics || []).map((m) => h('div', { class: 'stack', style: 'gap:6px' },
    h('div', { class: 'row between small' }, h('strong', {}, m.name), h('span', { class: `badge ${m.open ? 'ok' : ''}` }, m.open ? 'offen' : 'stumm')), bar(m.level, 'meter')))));
  clear(upBox).append(...section(`Als Nächstes · ${state.upcomingTotal}`,
    state.upcoming.length ? h('div', {}, ...state.upcoming.slice(0, 7).map((u, i) => h('div', { class: `q-row ${u.prioritized ? 'prio' : ''}` },
      h('div', { class: 'idx' }, String(i + 1)), cover(u.title, 'sm'), h('div', { class: 'grow' }, h('div', { class: 't' }, u.title), h('div', { class: 'a' }, u.artist)),
      u.prioritized ? h('span', { class: 'badge bad' }, '★') : null, h('span', { class: `badge p${u.player}` }, `P${u.player}`)))) : h('div', { class: 'muted' }, 'Warteschlange leer')));
  const bits = [
    ['Wünsche', state.wishMode === 'open' ? 'offen' : state.wishMode === 'paused' ? 'pausiert' : 'geschlossen'],
    ['Auto-Crossfade', state.auto?.enabled ? `an · ${state.auto.crossfadeSec} s` : 'aus'],
    ['Ducking', state.ducking?.enabled ? (state.ducking.active ? 'aktiv' : 'bereit') : 'aus'],
    ['Crossfade', state.crossfade ? `${Math.round(state.crossfade.progress * 100)} %` : '–'],
  ];
  clear(statusBox).append(...section('Status', h('div', { class: 'grid', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' }, ...bits.map(([k, v]) => h('div', {}, h('div', { class: 'eyebrow' }, k), h('div', { class: 'title', style: 'font-size:1.15rem;font-weight:650;margin-top:2px' }, String(v))))),
    h('div', { class: 'row' }, state.panic ? h('span', { class: 'badge bad' }, 'NOT-AUS AKTIV') : null, state.ended ? h('span', { class: 'badge warn' }, 'ENDE-MODUS') : null)));
  if (state.connections) clear(ampelBox).append(ampel(state.connections));
  clock.textContent = new Date().toLocaleTimeString('de-DE');
}

root.append(kpiBox, playersBox, h('div', { class: 'grid two' }, metersBox, micsBox), h('div', { class: 'grid main' }, upBox, statusBox), ampelBox);
app.append(top, root);
connect({ ping: true, onStatus: (ok) => top.setLive(ok), onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
