import { h, api, connect, topbar, clear, cover, eq, toast, BASE, $, feat, safe } from '/assets/app.js';
import { pendingList, upcomingList, historyList, blacklistPanel, chatPanel, ban } from '/assets/staff-ui.js';
import { actionFor, openHotkeyEditor, getHotkeys, ACTIONS } from '/assets/hotkeys.js';

// Moderation: ruhige Reiter statt alles auf einmal, Tastenkuerzel, Team-Chat.
const app = $('#app');
const TABS = ['wuensche', 'spaeter', 'queue', 'gespielt', 'gesperrt', 'chat'];
let state = null;
let tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'wuensche';
let assignMode = 'auto';
let chatSeen = 0;
const memos = new WeakMap();
const update = (box, key, build) => { if (memos.get(box) === key) return; memos.set(box, key); clear(box).append(build()); };

const roleBadge = h('span', { class: 'badge' });
const onlineEl = h('span', { class: 'online-dots', title: 'Aktuell online' });
const bar = topbar('Moderation', { nav: true, right: [onlineEl, roleBadge] });

const nowBox = h('div', { class: 'np' });
const state0Banner = h('div', { class: 'hidden banner-pause' }, '⏸ Pausen-Modus ist an – Wünsche sind pausiert.');
const tabBar = h('div', { class: 'tabs' });
const body = h('div');
const boxes = Object.fromEntries(TABS.map((t) => [t, h('div')]));
const assignSel = h('select', { 'aria-label': 'Annehmen auf', onchange: (e) => { assignMode = e.target.value; } },
  h('option', { value: 'auto' }, 'Auto (ausgeglichen)'), h('option', { value: '1' }, 'Player 1'), h('option', { value: '2' }, 'Player 2'));
const assignRow = h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Annehmen auf'), assignSel);
const pendingBox = h('div'); const laterBox = h('div');
boxes.wuensche.append(assignRow, pendingBox);
boxes.spaeter.append(laterBox);

function renderTabs() {
  const n = { wuensche: state.pending.length, spaeter: state.later?.length || 0, queue: state.upcomingTotal, gespielt: state.history?.length || 0, gesperrt: state.blacklist?.length || 0, chat: Math.max(0, (state.chat?.length || 0) - chatSeen) };
  const labels = { wuensche: 'Wünsche', spaeter: 'Später', queue: 'Warteschlange', gespielt: 'Gespielt', gesperrt: 'Gesperrt', chat: 'Chat' };
  if (tab === 'chat') chatSeen = state.chat?.length || 0;
  clear(tabBar).append(...TABS.map((k) => h('button', { class: tab === k ? 'active' : '', onclick: () => { tab = k; location.hash = k; render(); } },
    labels[k], n[k] && !(k === 'chat' && tab === 'chat') ? h('span', { class: `count ${['wuensche', 'chat'].includes(k) ? '' : 'soft'}`, style: 'margin-left:8px' }, String(n[k])) : null)));
  clear(body).append(boxes[tab]);
}

function render() {
  if (!state) return;
  const canAct = ['admin', 'tech', 'mod'].includes(state.role);
  roleBadge.textContent = state.role === 'orga' ? 'Nur lesen' : 'Moderation';
  assignRow.classList.toggle('hidden', !canAct);
  onlineEl.textContent = state.online?.length ? `● ${state.online.length} online: ${state.online.join(', ')}` : '';

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
  renderExtras();
  state0Banner.classList.toggle('hidden', !state.pauseMode);
  const claimKey = JSON.stringify(state.claims || []);
  const pk = (arr) => arr.map((p) => [p.id, p.votes]);
  update(pendingBox, JSON.stringify([pk(state.pending), canAct, state.settings.rejectReasons, claimKey, state.me]), () => pendingList(state, { canAct, assign: () => assignMode, me: state.me }));
  update(laterBox, JSON.stringify([pk(state.later || []), canAct, state.settings.rejectReasons, claimKey, state.me]), () => pendingList(state, { canAct, assign: () => assignMode, list: 'later', me: state.me }));
  update(boxes.queue, JSON.stringify([state.upcoming.map((u) => [u.id, u.player, u.prioritized, u.votes, u.auto]), canAct]), () => upcomingList(state, { canAct }));
  update(boxes.gespielt, JSON.stringify([state.history?.map((r) => [r.id, r.status]), canAct, (state.blacklist || []).length]), () => historyList(state, { canAct }));
  update(boxes.gesperrt, JSON.stringify([state.blacklist, canAct]), () => blacklistPanel(state, { canAct }));
  update(boxes.chat, JSON.stringify([state.chat?.map((m) => m.id), canAct]), () => chatPanel(state, { canWrite: canAct }));
}

// ---- Tastenkuerzel: wirken auf den obersten Wunsch ----
const decide = async (id, action, reason) => {
  try { const out = await api('/mod/decide', { method: 'POST', body: { id, action, reason, ...(action === 'approve' && assignMode !== 'auto' ? { player: Number(assignMode) } : {}) } }); toast(action === 'approve' ? `✓ Player ${out.request.player}` : action === 'later' ? '⏳ Später' : '✕ Abgelehnt'); }
  catch (e) { toast(e.message, true); }
};
addEventListener('keydown', (e) => {
  if (!state || !['admin', 'tech', 'mod'].includes(state.role) || !['wuensche', 'spaeter'].includes(tab)) return;
  const act = actionFor(e); if (!act) return;
  const first = (tab === 'spaeter' ? state.later : state.pending)?.[0]; if (!first) return;
  if (act === 'approve') decide(first.id, 'approve');
  else if (act === 'later') decide(first.id, 'later');
  else if (act === 'noreason') decide(first.id, 'deny');
  else if (/^reason\d$/.test(act)) { const reason = state.settings.rejectReasons[Number(act.slice(6)) - 1]; if (reason) decide(first.id, 'deny', reason); }
  else if (act === 'ban') ban({ kind: 'track', trackId: first.trackId, title: first.title, artist: first.artist, reason: 'Gesperrt (Taste)' }, `„${first.title}“`);
  else return;
  e.preventDefault();
});

const hk = getHotkeys();
// Stimmungs-Knopf, Uebergabe-Notiz, Umfrage-Stand
let energy = 0;
const energyRow = feat('energyKnob') ? h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Stimmung der nächsten 20 Min.:'),
  ...[[-1, '😌 Ruhiger'], [0, 'Normal'], [1, '🔥 Mehr Energie']].map(([v, l]) => h('button', { class: 'small', onclick: safe(async () => { energy = v; await api('/control/energy', { method: 'POST', body: { v } }); toast(l); }) }, l))) : null;
const hoText = h('textarea', { rows: 2, maxlength: 600, placeholder: 'Notiz für die nächste Schicht …' });
const hoMeta = h('div', { class: 'tiny muted' });
let hoShown = null;
const handoverCard = feat('handover') ? h('div', { class: 'card stack' }, h('div', { class: 'eyebrow' }, 'Übergabe-Notiz'), hoText, hoMeta,
  h('button', { class: 'small', onclick: safe(async () => { await api('/handover', { method: 'POST', body: { text: hoText.value } }); toast('Notiz gespeichert'); }) }, 'Speichern')) : null;
const pollBox = h('div', { class: 'hidden card stack' });
function renderExtras() {
  if (handoverCard && state.handover && hoShown !== state.handover.ts && document.activeElement !== hoText) { hoShown = state.handover.ts; hoText.value = state.handover.text || ''; hoMeta.textContent = state.handover.by ? `zuletzt ${state.handover.by}` : ''; }
  const p = state.poll;
  pollBox.classList.toggle('hidden', !p);
  if (p) clear(pollBox).append(h('div', { class: 'eyebrow' }, p.status === 'open' ? 'Umfrage läuft' : 'Umfrage beendet'), h('b', {}, p.question), ...p.options.map((o, i) => h('div', { class: 'row between small' }, h('span', {}, o), h('b', {}, `${p.counts[i]}`))));
}
void energy;
app.append(
  bar,
  h('div', { class: 'wrap' },
    nowBox,
    state0Banner,
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: `${BASE}/focus`, title: 'Schwarzer Vollbild-Modus: zeigt nur neue Wünsche' }, '⤢ Fokus-Modus'),
      h('a', { class: 'btn', href: `${BASE}/ticker`, title: 'Live-Anzeige aller Wünsche und Entscheidungen' }, '◉ Live-Wünsche'),
      h('button', { class: 'ghost', title: 'Tastenkürzel ansehen und ändern', onclick: () => openHotkeyEditor() }, `⌨ Tasten (${hk.approve.toUpperCase()} = annehmen)`)),
    energyRow, handoverCard, pollBox,
    h('div', { class: 'card' }, tabBar, body)),
);
connect({ ping: true, onStatus: (ok) => bar.setLive(ok), onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
void ACTIONS;
