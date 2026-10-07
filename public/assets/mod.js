import { h, api, connect, topbar, clear, cover, eq, $ } from '/assets/app.js';
import { pendingList, upcomingList, recentList, cardHead } from '/assets/staff-ui.js';

const app = $('#app');
let state = null;
let assignMode = 'auto';
const memo = new WeakMap();

const roleBadge = h('span', { class: 'badge' });
const bar = topbar('Moderation', { nav: true, right: [roleBadge] });

const nowBox = h('div', { class: 'np' });
const pendingHead = h('div'); const pendingBox = h('div');
const upHead = h('div'); const upBox = h('div');
const recentBox = h('div');
const recentSum = h('summary', {}, 'Zuletzt entschieden');

const assignSel = h('select', { 'aria-label': 'Zuweisung', onchange: (e) => { assignMode = e.target.value; } },
  h('option', { value: 'auto' }, 'Auto (ausgeglichen)'), h('option', { value: '1' }, 'Player 1'), h('option', { value: '2' }, 'Player 2'));
const assignRow = h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Annehmen auf'), assignSel);

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

  // eine ruhige Zeile statt zwei grosser Player-Karten
  const now = [1, 2].map((n) => ({ n, p: state.players[n] })).find((x) => x.p.playing && x.n === state.current) || [1, 2].map((n) => ({ n, p: state.players[n] })).find((x) => x.p.playing);
  const pct = now && now.p.durationMs ? now.p.positionMs / now.p.durationMs : 0;
  clear(nowBox).append(now
    ? h('div', { class: 'hero' }, cover(now.p.title), h('div', { class: 'meta' },
        h('div', { class: 'row', style: 'gap:8px' }, eq(true), h('span', { class: 'eyebrow' }, `Jetzt läuft · Player ${now.n}`)),
        h('div', { class: 't', style: 'font-size:1.1rem' }, now.p.title), h('div', { class: 'a small' }, now.p.artist),
        h('div', { class: 'bar', style: 'margin-top:8px' }, h('i', { style: `width:${Math.round(pct * 100)}%` }))))
    : h('div', { class: 'row' }, eq(false), h('span', { class: 'muted' }, 'Gerade läuft nichts.')));

  update(pendingHead, state.pending.length, () => cardHead('Offene Wünsche', state.pending.length));
  update(upHead, state.upcomingTotal, () => cardHead('Als Nächstes', state.upcomingTotal));
  update(pendingBox, JSON.stringify([state.pending.map((p) => [p.id, p.votes]), canAct, state.settings.rejectReasons]), () => pendingList(state, { canAct, assign: () => assignMode }));
  update(upBox, JSON.stringify([state.upcoming.map((u) => [u.id, u.player, u.prioritized, u.votes]), canAct]), () => upcomingList(state, { canAct }));
  update(recentBox, JSON.stringify(state.recent.map((r) => [r.id, r.status])), () => recentList(state));
  recentSum.textContent = `Zuletzt entschieden (${state.recent.length})`;
}

app.append(
  bar,
  h('div', { class: 'wrap' },
    nowBox,
    h('div', { class: 'grid main' },
      h('div', { class: 'card' }, pendingHead, h('div', { class: 'stack' }, assignRow, pendingBox)),
      h('div', { class: 'stack', style: 'gap:16px' },
        h('div', { class: 'card' }, upHead, upBox),
        h('details', { class: 'card more' }, recentSum, h('div', { style: 'margin-top:12px' }, recentBox)))))
);
connect({ ping: true, onStatus: (ok) => bar.setLive(ok), onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
