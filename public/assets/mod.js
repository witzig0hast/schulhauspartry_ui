import { h, api, connect, topbar, clear, logout, $ } from '/assets/app.js';
import { pendingList, upcomingList, recentList, playerSummary } from '/assets/staff-ui.js';

const app = $('#app');
let state = null;
let assignMode = 'auto';

const roleBadge = h('span', { class: 'badge' });
const assign = h('select', { 'aria-label': 'Zuweisung', onchange: (e) => { assignMode = e.target.value; } },
  h('option', { value: 'auto' }, 'Auto-Zuweisung (ausgeglichen)'), h('option', { value: '1' }, 'Immer Player 1'), h('option', { value: '2' }, 'Immer Player 2'));
const playersBox = h('div', { class: 'grid two' });
const pendingBox = h('div');
const upcomingBox = h('div');
const recentBox = h('div');
const pendingTitle = h('h2', {}, 'Offene Wünsche');
const upTitle = h('h2', {}, 'Als Nächstes (gesamt)');
const assignRow = h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Zuweisung:'), assign);

const memo = {};
function update(box, key, build) {
  if (memo[box.id ||= 'b' + Math.random()] === key) return;
  memo[box.id] = key;
  clear(box).append(build());
}

function render() {
  if (!state) return;
  const canAct = ['admin', 'tech', 'mod'].includes(state.role);
  roleBadge.textContent = state.role === 'orga' ? 'Nur lesen' : 'Moderation';
  assignRow.classList.toggle('hidden', !canAct);
  clear(playersBox).append(playerSummary(1, state.players[1]), playerSummary(2, state.players[2]));
  pendingTitle.textContent = `Offene Wünsche (${state.pending.length})`;
  upTitle.textContent = `Als Nächstes (${state.upcomingTotal})`;
  update(pendingBox, JSON.stringify([state.pending.map((p) => [p.id, p.votes]), canAct, state.settings.rejectReasons]), () => pendingList(state, { canAct, assign: () => assignMode, onAfter: () => {} }));
  update(upcomingBox, JSON.stringify([state.upcoming.map((u) => [u.id, u.player, u.prioritized, u.votes]), canAct]), () => upcomingList(state, { canAct }));
  update(recentBox, JSON.stringify(state.recent.map((r) => [r.id, r.status])), () => recentList(state));
}

app.append(
  topbar('Moderation', { right: [roleBadge, h('button', { class: 'ghost small', onclick: logout }, 'Abmelden')] }),
  h('div', { class: 'wrap stack' }, playersBox, assignRow,
    h('div', { class: 'grid two' },
      h('div', { class: 'card stack' }, pendingTitle, pendingBox),
      h('div', { class: 'stack' }, h('div', { class: 'card stack' }, upTitle, upcomingBox), h('div', { class: 'card stack' }, h('h2', {}, 'Zuletzt entschieden'), recentBox)))),
);
connect({ ping: true, onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
