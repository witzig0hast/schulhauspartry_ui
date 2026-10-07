import { h, api, connect, topbar, clear, cover, eq, $ } from '/assets/app.js';

// Live-Wuensche: neue Wuensche erscheinen sofort, danach "Angenommen" oder "Abgelehnt" -- als grosse Anzeige.
const app = $('#app');
let state = null;
const seen = new Map();      // id -> letzter Status
const flashUntil = new Map();

const top = topbar('Live-Wünsche', { nav: true });
const statBox = h('div', { class: 'tk-head' });
const list = h('div', { class: 'tk-list' });
const nowBox = h('div', { class: 'np' });

const stat = (label, value, hot) => h('div', { class: 'tk-stat', style: hot ? 'background:var(--ink);color:var(--ink-text)' : '' }, h('div', { class: 'eyebrow', style: hot ? 'color:inherit;opacity:.65' : '' }, label), h('div', { class: 'v' }, String(value)));

function stateOf(r) {
  if (r.status === 'pending') return { cls: 'pending', badge: h('span', { class: 'badge warn' }, '● Neu – wartet auf Entscheidung'), sub: '' };
  if (r.status === 'denied') return { cls: 'denied', badge: h('span', { class: 'badge bad' }, '✕ Abgelehnt'), sub: r.reason || '' };
  const where = r.player ? `Player ${r.player}` : '';
  return { cls: 'approved', badge: h('span', { class: 'badge ok' }, `✓ Angenommen${r.prioritized ? ' · ★ priorisiert' : ''}`), sub: r.status === 'playing' ? 'läuft jetzt' : r.status === 'played' ? 'gespielt' : where };
}

const els = new Map(); // id -> {el, badgeBox}
function render() {
  if (!state) return;
  const now = Date.now();
  const byId = new Map();
  for (const r of [...state.recent, ...state.pending]) byId.set(r.id, r);
  const feed = [...byId.values()].filter((r) => r.status !== 'removed').sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  for (const r of feed) {
    if (seen.get(r.id) !== r.status) { if (seen.has(r.id) || r.status === 'pending') flashUntil.set(r.id, now + 5000); seen.set(r.id, r.status); }
  }
  clear(statBox).append(stat('Offen', state.counts.pending, state.counts.pending > 0), stat('Angenommen', state.counts.approved + state.counts.played), stat('Abgelehnt', state.counts.denied));
  // vorhandene Eintraege nur aktualisieren (Animation spielt nur beim ersten Erscheinen)
  const ids = new Set(feed.map((r) => r.id));
  for (const [id, e] of els) if (!ids.has(id)) { e.el.remove(); els.delete(id); }
  list.querySelector('.tk-empty')?.remove();
  if (!feed.length) list.append(h('div', { class: 'card tk-empty', style: 'padding:48px;text-align:center' }, h('div', { class: 'muted' }, 'Noch keine Wünsche – sobald jemand etwas wünscht, erscheint es hier.')));
  let ref = list.firstChild;
  for (const r of feed) {
    const s = stateOf(r);
    let e = els.get(r.id);
    if (!e) {
      e = { el: h('div', {}), info: h('div', { style: 'min-width:0' }), state: h('div', { class: 'tk-state' }) };
      e.el.append(cover(r.title, 'lg'), e.info, e.state);
      els.set(r.id, e);
    }
    e.el.className = `tk-item ${s.cls} ${flashUntil.get(r.id) > now ? 'flash' : ''}`;
    const sig = `${r.status}|${r.votes}|${r.reason}|${r.player}|${r.prioritized}`;
    if (e.sig !== sig) {
      e.sig = sig;
      clear(e.info).append(h('div', { class: 't' }, r.title), h('div', { class: 'a' }, `${r.artist}${r.votes > 1 ? ` · +${r.votes - 1}` : ''}`));
      e.state.replaceChildren(...[s.badge, s.sub ? h('div', { class: 'sub' }, s.sub) : null].filter(Boolean));
    }
    // Reihenfolge abgleichen: nur verschieben, was nicht schon an der richtigen Stelle steht
    // (Umhaengen startet sonst die Einblend-Animation neu)
    if (ref === e.el) ref = ref.nextSibling; else list.insertBefore(e.el, ref);
  }
  const np = state.nowPlayingTitle;
  clear(nowBox).append(np ? h('div', { class: 'row' }, eq(true), h('span', { class: 'eyebrow' }, 'Jetzt läuft'), h('strong', {}, `${np.title} – ${np.artist}`)) : h('span', { class: 'muted small' }, 'Gerade läuft nichts.'));
}

app.append(top, h('div', { class: 'wrap' }, statBox, list, nowBox));
connect({ ping: true, onStatus: (ok) => top.setLive(ok), onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
setInterval(render, 4000);
