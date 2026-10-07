import { h, api, connect, topbar, clear, cover, eq, BASE, $ } from '/assets/app.js';
import { pendingList, upcomingList, historyList, blacklistPanel, empty } from '/assets/staff-ui.js';

// Moderation: vier ruhige Reiter statt alles auf einmal.
const app = $('#app');
let state = null;
let tab = ['wuensche', 'queue', 'gespielt', 'gesperrt'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'wuensche';
let assignMode = 'auto';
const memos = new WeakMap();
const update = (box, key, build) => { if (memos.get(box) === key) return; memos.set(box, key); clear(box).append(build()); };

const roleBadge = h('span', { class: 'badge' });
const bar = topbar('Moderation', { nav: true, right: [roleBadge] });

const nowBox = h('div', { class: 'np' });
const tabBar = h('div', { class: 'tabs' });
const body = h('div');
const boxes = { wuensche: h('div', { class: 'stack' }), queue: h('div'), gespielt: h('div'), gesperrt: h('div') };
const assignSel = h('select', { 'aria-label': 'Annehmen auf', onchange: (e) => { assignMode = e.target.value; } },
  h('option', { value: 'auto' }, 'Auto (ausgeglichen)'), h('option', { value: '1' }, 'Player 1'), h('option', { value: '2' }, 'Player 2'));
const assignRow = h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Annehmen auf'), assignSel);
const pendingBox = h('div');
boxes.wuensche.append(assignRow, pendingBox);

function renderTabs() {
  const n = state ? { wuensche: state.pending.length, queue: state.upcomingTotal, gespielt: state.history?.length || 0, gesperrt: state.blacklist?.length || 0 } : {};
  const labels = { wuensche: 'Wünsche', queue: 'Warteschlange', gespielt: 'Gespielt', gesperrt: 'Gesperrt' };
  clear(tabBar).append(...Object.keys(labels).map((k) => h('button', { class: tab === k ? 'active' : '', onclick: () => { tab = k; location.hash = k; render(); } },
    labels[k], n[k] ? h('span', { class: `count ${k === 'wuensche' && n[k] ? '' : 'soft'}`, style: 'margin-left:8px' }, String(n[k])) : null)));
  clear(body).append(boxes[tab]);
}

function render() {
  if (!state) return;
  const canAct = ['admin', 'tech', 'mod'].includes(state.role);
  roleBadge.textContent = state.role === 'orga' ? 'Nur lesen' : 'Moderation';
  assignRow.classList.toggle('hidden', !canAct);

  const list = [1, 2].map((n) => ({ n, p: state.players[n] }));
  const now = list.find((x) => x.p.playing && x.n === state.current) || list.find((x) => x.p.playing);
  const pct = now && now.p.durationMs ? now.p.positionMs / now.p.durationMs : 0;
  clear(nowBox).append(now
    ? h('div', { class: 'hero' }, cover(now.p.title), h('div', { class: 'meta' },
        h('div', { class: 'row', style: 'gap:8px' }, eq(true), h('span', { class: 'eyebrow' }, `Jetzt läuft · Player ${now.n}`)),
        h('div', { class: 't', style: 'font-size:1.1rem' }, now.p.title), h('div', { class: 'a small' }, now.p.artist),
        h('div', { class: 'bar', style: 'margin-top:8px' }, h('i', { style: `width:${Math.round(pct * 100)}%` }))))
    : h('div', { class: 'row' }, eq(false), h('span', { class: 'muted' }, 'Gerade läuft nichts.')));

  renderTabs();
  update(pendingBox, JSON.stringify([state.pending.map((p) => [p.id, p.votes]), canAct, state.settings.rejectReasons, (state.blacklist || []).length]), () => pendingList(state, { canAct, assign: () => assignMode }));
  update(boxes.queue, JSON.stringify([state.upcoming.map((u) => [u.id, u.player, u.prioritized, u.votes]), canAct]), () => upcomingList(state, { canAct }));
  update(boxes.gespielt, JSON.stringify([state.history?.map((r) => [r.id, r.status]), canAct, (state.blacklist || []).length]), () => historyList(state, { canAct }));
  update(boxes.gesperrt, JSON.stringify([state.blacklist, canAct]), () => blacklistPanel(state, { canAct }));
}

app.append(
  bar,
  h('div', { class: 'wrap' },
    nowBox,
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: `${BASE}/focus`, title: 'Schwarzer Vollbild-Modus: zeigt nur neue Wünsche' }, '⤢ Fokus-Modus'),
      h('a', { class: 'btn', href: `${BASE}/ticker`, title: 'Live-Anzeige aller Wünsche und Entscheidungen' }, '◉ Live-Wünsche')),
    h('div', { class: 'card' }, tabBar, body)),
);
connect({ ping: true, onStatus: (ok) => bar.setLive(ok), onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
void empty;
