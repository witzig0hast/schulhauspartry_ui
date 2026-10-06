import { h, api, connect, topbar, clear, logout, icon, $ } from '/assets/app.js';
import { pendingList, upcomingList, recentList, playerSummary, kpi, cardHead } from '/assets/staff-ui.js';

const app = $('#app');
let state = null;
let assignMode = 'auto';
const memo = new WeakMap();

const roleBadge = h('span', { class: 'badge' });
const bar = topbar('Moderation', { right: [roleBadge, h('button', { class: 'small ghost', onclick: logout }, 'Abmelden')] });

const kpiBox = h('div', { class: 'kpis' });
const playersBox = h('div', { class: 'grid two' });
const pendingHead = h('div'); const pendingBox = h('div');
const upHead = h('div'); const upBox = h('div');
const recentBox = h('div');

const segBtns = [['auto', 'Auto'], ['1', 'Player 1'], ['2', 'Player 2']].map(([v, l]) => h('button', { class: v === assignMode ? 'on' : '', onclick: () => { assignMode = v; segBtns.forEach((b) => b.classList.toggle('on', b.dataset.v === v)); } }, l));
segBtns.forEach((b, i) => { b.dataset.v = ['auto', '1', '2'][i]; });
const assignRow = h('div', { class: 'row between' }, h('div', { class: 'stack', style: 'gap:2px' }, h('span', { class: 'eyebrow' }, 'Zuweisung beim Annehmen'), h('span', { class: 'tiny muted' }, 'Auto hält beide Player ausgeglichen')), h('div', { class: 'seg' }, ...segBtns));

function update(box, key, build) {
  if (memo.get(box) === key) return;
  memo.set(box, key);
  clear(box).append(build());
}

function render() {
  if (!state) return;
  const canAct = ['admin', 'tech', 'mod'].includes(state.role);
  roleBadge.textContent = state.role === 'orga' ? 'Nur lesen' : 'Moderation';
  assignRow.classList.toggle('hidden', !canAct);

  clear(kpiBox).append(
    kpi('Offene Wünsche', state.counts.pending, { hot: state.counts.pending > 0 }), kpi('In Warteschlange', state.counts.approved),
    kpi('Gespielt', state.counts.played), kpi('Abgelehnt', state.counts.denied));
  clear(playersBox).append(playerSummary(1, state.players[1], { onAir: state.current === 1 && state.players[1].playing }), playerSummary(2, state.players[2], { onAir: state.current === 2 && state.players[2].playing }));

  update(pendingHead, state.pending.length, () => cardHead('Offene Wünsche', state.pending.length));
  update(upHead, state.upcomingTotal, () => cardHead('Als Nächstes', state.upcomingTotal));
  update(pendingBox, JSON.stringify([state.pending.map((p) => [p.id, p.votes]), canAct, state.settings.rejectReasons]), () => pendingList(state, { canAct, assign: () => assignMode }));
  update(upBox, JSON.stringify([state.upcoming.map((u) => [u.id, u.player, u.prioritized, u.votes]), canAct]), () => upcomingList(state, { canAct }));
  update(recentBox, JSON.stringify(state.recent.map((r) => [r.id, r.status])), () => recentList(state));
}

app.append(
  bar,
  h('div', { class: 'wrap' },
    kpiBox, playersBox,
    h('div', { class: 'grid main' },
      h('div', { class: 'card' }, pendingHead, h('div', { class: 'stack' }, assignRow, pendingBox)),
      h('div', { class: 'stack', style: 'gap:16px' },
        h('div', { class: 'card' }, upHead, upBox),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Zuletzt entschieden')), recentBox)))),
);
connect({ ping: true, onStatus: (ok) => bar.setLive(ok), onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
void icon;
