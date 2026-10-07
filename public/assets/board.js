import { h, api, connect, topbar, clear, safe, toast, cover, eq, fmtTime, $ } from '/assets/app.js';
import { pendingList, upcomingList, recentList, playerSummary, ampel, bar, kpi, empty } from '/assets/staff-ui.js';

// ============================================================
// Modulares Board: Bausteine (Widgets) an-/abwaehlen, sortieren, Groesse waehlen.
// Layouts werden pro Geraet gespeichert (localStorage) und als eigene Ansichten benannt.
// ============================================================
const app = $('#app');
const KEY = 'board.v1';
const ALL = ['admin', 'tech', 'mod', 'orga', 'display'];
let state = null;
let assignMode = 'auto';
let editing = false;
let store = { layout: null, saved: [] };
let role = null;
const mounted = new Map();

const post = (path, body = {}) => safe(async () => { await api(path, { method: 'POST', body }); })();
const can = {
  moderate: () => ['admin', 'tech', 'mod'].includes(role),
};
const memos = new WeakMap();
const memo = (box, key, build) => { if (memos.get(box) === key) return; memos.set(box, key); clear(box).append(build()); };

// ---------------- Bausteine ----------------
const WIDGETS = {
  now: {
    title: 'Jetzt läuft', desc: 'Der aktuelle Song mit Fortschritt', roles: ALL, size: 'wide',
    make() {
      const box = h('div');
      return { el: box, update(s) {
        const list = [1, 2].map((n) => ({ n, p: s.players[n] }));
        const now = list.find((x) => x.p.playing && x.n === s.current) || list.find((x) => x.p.playing);
        const pct = now && now.p.durationMs ? now.p.positionMs / now.p.durationMs : 0;
        clear(box).append(now
          ? h('div', { class: 'hero' }, cover(now.p.title, 'lg'), h('div', { class: 'meta' },
              h('div', { class: 'row', style: 'gap:8px' }, eq(true), h('span', { class: 'eyebrow' }, `Player ${now.n}`)),
              h('div', { class: 't' }, now.p.title), h('div', { class: 'a' }, now.p.artist),
              h('div', { style: 'margin-top:10px' }, bar(pct, `p${now.n}`), h('div', { class: 'time' }, h('span', {}, fmtTime(now.p.positionMs)), h('span', {}, `−${fmtTime(now.p.remainingMs)}`)))))
          : empty('Gerade läuft nichts.', 'note'));
      } };
    },
  },
  p1: { title: 'Player 1', desc: 'Player 1 mit Fortschritt', roles: ALL, make: () => playerWidget(1) },
  p2: { title: 'Player 2', desc: 'Player 2 mit Fortschritt', roles: ALL, make: () => playerWidget(2) },
  queue: {
    title: 'Als Nächstes', desc: 'Warteschlange (Priorisieren / Entfernen für Berechtigte)', roles: ALL, size: 'wide',
    make() { const box = h('div'); return { el: box, update(s) { const c = can.moderate(); memo(box, JSON.stringify([s.upcoming.map((u) => [u.id, u.player, u.prioritized, u.votes]), c]), () => upcomingList(s, { canAct: c })); } }; },
  },
  pending: {
    title: 'Offene Wünsche', desc: 'Annehmen / Ablehnen', roles: ['admin', 'tech', 'mod', 'orga'], size: 'wide',
    make() {
      const box = h('div');
      const sel = h('select', { onchange: (e) => { assignMode = e.target.value; } }, h('option', { value: 'auto' }, 'Auto (ausgeglichen)'), h('option', { value: '1' }, 'Player 1'), h('option', { value: '2' }, 'Player 2'));
      const head = h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Annehmen auf'), sel);
      return { el: h('div', { class: 'stack' }, head, box), update(s) {
        const c = can.moderate(); head.classList.toggle('hidden', !c);
        memo(box, JSON.stringify([s.pending.map((p) => [p.id, p.votes]), c, s.settings.rejectReasons]), () => pendingList(s, { canAct: c, assign: () => assignMode }));
      } };
    },
  },
  recent: {
    title: 'Zuletzt entschieden', desc: 'Letzte Entscheidungen der Moderation', roles: ['admin', 'tech', 'mod', 'orga'],
    make() { const box = h('div'); return { el: box, update(s) { memo(box, JSON.stringify(s.recent.map((r) => [r.id, r.status])), () => recentList(s)); } }; },
  },
  kpis: {
    title: 'Zahlen', desc: 'Offen, in Queue, gespielt, abgelehnt', roles: ALL,
    make() { const box = h('div', { class: 'grid', style: 'grid-template-columns:repeat(2,minmax(0,1fr))' }); return { el: box, update(s) { clear(box).append(kpi('Offen', s.counts.pending, { hot: s.counts.pending > 0 }), kpi('In Queue', s.counts.approved), kpi('Gespielt', s.counts.played), kpi('Abgelehnt', s.counts.denied)); } }; },
  },
  meters: {
    title: 'Pegel', desc: 'Pegel und Fader beider Player', roles: ['admin', 'tech', 'orga', 'display'],
    make() { const box = h('div', { class: 'stack' }); return { el: box, update(s) { clear(box).append(...[1, 2].map((n) => h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'row between small' }, h('strong', {}, `Player ${n}`), h('span', { class: 'muted mono' }, `Fader ${Math.round((s.players[n].level ?? 0) * 100)} %`)), bar(s.players[n].meter ?? 0, 'meter')))); } }; },
  },
  mics: {
    title: 'Mikrofone', desc: 'Mic-Status und Pegel', roles: ['admin', 'tech', 'display'],
    make() { const box = h('div', { class: 'stack' }); return { el: box, update(s) { clear(box).append(...(s.mics || []).map((m) => h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'row between small' }, h('strong', {}, m.name), h('span', { class: `badge ${m.open ? 'ok' : ''}` }, m.open ? 'offen' : 'stumm')), bar(m.level, 'meter')))); } }; },
  },
  transition: {
    title: 'Übergang', desc: 'Crossfade-Knopf, Auto-Crossfade, Ducking', roles: ['admin', 'tech'],
    make() {
      let sec = 8;
      const next = h('div', { class: 'small' }); const seg = h('div', { class: 'seg' });
      const auto = h('input', { type: 'checkbox', onchange: () => post('/settings/tech', { auto: { enabled: auto.checked } }) });
      const duck = h('input', { type: 'checkbox', onchange: () => post('/settings/tech', { ducking: { enabled: duck.checked } }) });
      const btn = h('button', { class: 'primary', style: 'height:52px', onclick: () => post('/control/crossfade', { sec }) }, '⇄  Crossfade zum nächsten Song');
      const info = h('div', { class: 'small muted' });
      let key = '';
      return { el: h('div', { class: 'stack' }, next, btn, h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Dauer'), seg), info,
        h('label', { class: 'check' }, auto, 'Auto-Crossfade'), h('label', { class: 'check' }, duck, 'Ducking')),
      update(s) {
        const n = s.upcoming[0];
        next.textContent = n ? `Als Nächstes: ${n.title} – ${n.artist}` : 'Die Warteschlange ist leer.';
        const k = JSON.stringify(s.settings.fadePresets) + sec;
        if (k !== key) { key = k; clear(seg).append(...s.settings.fadePresets.map((p) => h('button', { class: p.sec === sec ? 'on' : '', onclick: () => { sec = p.sec; key = ''; } }, `${p.name} · ${p.sec}s`))); }
        info.textContent = s.crossfade ? `Crossfade läuft: Player ${s.crossfade.from} → ${s.crossfade.to}` : '';
        if (document.activeElement !== auto) auto.checked = !!s.auto?.enabled;
        if (document.activeElement !== duck) duck.checked = !!s.ducking?.enabled;
      } };
    },
  },
  wishmode: {
    title: 'Wunschmodus', desc: 'Wünsche der Gäste öffnen / pausieren / schließen', roles: ['admin', 'tech'],
    make() {
      const btns = ['open', 'paused', 'closed'].map((m) => { const b = h('button', { onclick: () => post('/control/wishmode', { mode: m }) }, { open: 'Offen', paused: 'Pausiert', closed: 'Geschlossen' }[m]); b.dataset.m = m; return b; });
      return { el: h('div', { class: 'seg', style: 'justify-self:start' }, ...btns), update(s) { btns.forEach((b) => { b.className = b.dataset.m === s.wishMode ? 'on' : ''; }); } };
    },
  },
  panic: {
    title: 'Not-Aus', desc: 'Zweimal drücken: stoppt beide Player sofort', roles: ['admin', 'tech'],
    make() {
      let nonce = null, timer = null;
      const reset = () => { clearTimeout(timer); nonce = null; btn.textContent = '⛔  NOT-AUS'; btn.classList.remove('panic-armed'); };
      const btn = h('button', { class: 'bad', style: 'height:56px;font-size:1.05rem', onclick: async () => {
        if (!nonce) {
          const out = await api('/control/panic-arm', { method: 'POST', body: {} }).catch((e) => toast(e.message, true));
          if (!out) return;
          nonce = out.nonce; btn.textContent = '⛔  NOCHMAL DRÜCKEN!'; btn.classList.add('panic-armed'); timer = setTimeout(reset, 4500); return;
        }
        const n = nonce; reset(); await post('/control/panic', { nonce: n });
      } }, '⛔  NOT-AUS');
      const clearBtn = h('button', { class: 'hidden', onclick: () => post('/control/panic-clear') }, 'Not-Aus aufheben');
      const endBtn = h('button', { onclick: async () => { if (state.ended) return post('/control/end-clear'); if (confirm('Ende-Modus starten? Musik wird ausgeblendet, Wünsche werden geschlossen.')) await post('/control/end', { sec: 10 }); } }, '🏁 Ende-Modus');
      return { el: h('div', { class: 'stack' }, btn, clearBtn, endBtn), update(s) { clearBtn.classList.toggle('hidden', !s.panic); endBtn.textContent = s.ended ? '↩ Ende-Modus aufheben' : '🏁 Ende-Modus'; } };
    },
  },
  status: {
    title: 'Verbindungen', desc: 'Server, X32, Pi, Spotify, Player', roles: ['admin', 'tech', 'display'],
    make() { const box = h('div'); return { el: box, update(s) { if (s.connections) clear(box).append(ampel(s.connections)); } }; },
  },
  clock: {
    title: 'Uhr & Ende', desc: 'Uhrzeit und Restzeit bis zu einer Endzeit', roles: ALL,
    make() {
      const time = h('div', { class: 'big mono' }); const left = h('div', { class: 'muted small' });
      const end = h('input', { type: 'time', 'aria-label': 'Endzeit', style: 'width:130px', onchange: () => { try { localStorage.setItem('board.end', end.value); } catch { /* egal */ } } });
      try { end.value = localStorage.getItem('board.end') || ''; } catch { /* egal */ }
      return { el: h('div', { class: 'stack' }, time, left, h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Ende um'), end)), update() {
        const d = new Date(); time.textContent = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        if (end.value) { const [hh, mm] = end.value.split(':').map(Number); const t = new Date(d); t.setHours(hh, mm, 0, 0); if (t < d) t.setDate(t.getDate() + 1); const m = Math.round((t - d) / 60000); left.textContent = `Noch ${Math.floor(m / 60)} h ${m % 60} min`; } else left.textContent = 'Keine Endzeit gesetzt';
      } };
    },
  },
  stats: {
    title: 'Statistik live', desc: 'Wünsche der letzten 2 Stunden, meistgewünscht', roles: ALL, size: 'wide',
    make() {
      const box = h('div', { class: 'stack' });
      let last = 0;
      const load = safe(async () => {
        const s = await api('/stats');
        const max = Math.max(1, ...s.series.map((x) => x.count));
        clear(box).append(
          h('div', { class: 'grid', style: 'grid-template-columns:repeat(4,minmax(0,1fr))' }, kpi('Wünsche', s.total), kpi('Angenommen', s.approvalRate == null ? '–' : `${s.approvalRate} %`), kpi('Geräte', s.devices), kpi('Gespielt', s.plays)),
          h('div', { class: 'eyebrow' }, 'Wünsche pro 10 Minuten'),
          h('div', { class: 'spark' }, ...s.series.map((x) => h('i', { class: x.count ? '' : 'z', title: `${new Date(x.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}: ${x.count}`, style: `height:${Math.max(3, Math.round((x.count / max) * 100))}%` }))),
          h('div', { class: 'eyebrow' }, 'Meistgewünscht'),
          s.top.length ? h('div', {}, ...s.top.map((t, i) => h('div', { class: 'q-row' }, h('div', { class: 'idx' }, String(i + 1)), h('div', { class: 'grow' }, h('div', { class: 't' }, t.title), h('div', { class: 'a' }, t.artist)), h('span', { class: 'badge' }, `${t.votes}×`)))) : h('div', { class: 'muted small' }, 'Noch keine Wünsche.'));
      });
      return { el: box, update() { if (Date.now() - last > 10000) { last = Date.now(); load(); } } };
    },
  },
};

function playerWidget(n) {
  const box = h('div');
  return { el: box, update(s) { clear(box).append(playerSummary(n, s.players[n], { onAir: s.current === n && s.players[n].playing })); } };
}

// ---------------- Voreinstellungen ----------------
const PRESETS = {
  'Übersicht': ['now', 'queue', 'kpis', 'clock'],
  'Bühne': ['now', 'p1', 'p2', 'queue', 'mics', 'meters', 'panic'],
  'Moderation': ['now', 'pending', 'queue', 'recent'],
  'Technik': ['p1', 'p2', 'transition', 'mics', 'wishmode', 'panic', 'status'],
  'Zahlen': ['kpis', 'stats', 'clock', 'recent'],
  'Alles': Object.keys(WIDGETS),
};
const defaultPreset = () => ({ admin: 'Bühne', tech: 'Technik', mod: 'Moderation', orga: 'Übersicht', display: 'Übersicht' }[role] || 'Übersicht');
const available = () => Object.keys(WIDGETS).filter((id) => WIDGETS[id].roles.includes(role));
const fromIds = (ids) => ids.filter((id) => available().includes(id)).map((id) => ({ id, size: WIDGETS[id].size || 'normal' }));

function load() { try { const j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (j) store = { layout: j.layout || null, saved: j.saved || [] }; } catch { /* egal */ } }
function persist() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* egal */ } }

// ---------------- Darstellung ----------------
const grid = h('div', { class: 'board' });
const editPanel = h('div', { class: 'card stack hidden' });
const toolbar = h('div', { class: 'row between' });

function ensureWidget(id) {
  if (!mounted.has(id)) mounted.set(id, WIDGETS[id].make());
  return mounted.get(id);
}

function renderLayout() {
  const layout = store.layout.filter((l) => WIDGETS[l.id] && available().includes(l.id));
  clear(grid);
  layout.forEach((l, i) => {
    const w = WIDGETS[l.id]; const m = ensureWidget(l.id);
    const ctl = h('div', { class: 'wctl' },
      h('button', { class: 'small icon ghost', title: 'Nach vorne', disabled: i === 0, onclick: () => move(i, -1) }, '←'),
      h('button', { class: 'small icon ghost', title: 'Nach hinten', disabled: i === layout.length - 1, onclick: () => move(i, 1) }, '→'),
      h('button', { class: 'small ghost', title: 'Größe ändern', onclick: () => resize(i) }, { normal: 'Klein', wide: 'Breit', full: 'Voll' }[l.size] || 'Klein'),
      h('button', { class: 'small icon ghost', title: 'Entfernen', onclick: () => toggle(l.id, false) }, '✕'));
    grid.append(h('section', { class: `card w ${l.size === 'wide' ? 'wide' : l.size === 'full' ? 'full' : ''} ${editing ? 'editing' : ''}` },
      h('div', { class: 'row between w-head' }, h('h2', {}, w.title), editing ? ctl : null), m.el));
  });
  if (!layout.length) grid.append(h('div', { class: 'card', style: 'grid-column:1/-1' }, empty('Noch keine Bausteine. Klicke auf „Bearbeiten“ und wähle welche aus.')));
  if (state) for (const l of layout) mounted.get(l.id).update(state);
}

function move(i, d) { const a = store.layout; [a[i], a[i + d]] = [a[i + d], a[i]]; persist(); renderLayout(); }
function resize(i) { const order = ['normal', 'wide', 'full']; const l = store.layout[i]; l.size = order[(order.indexOf(l.size) + 1) % 3]; persist(); renderLayout(); }
function toggle(id, on) {
  const has = store.layout.some((l) => l.id === id);
  if (on && !has) store.layout.push({ id, size: WIDGETS[id].size || 'normal' });
  if (!on && has) store.layout = store.layout.filter((l) => l.id !== id);
  persist(); renderLayout(); renderEdit();
}
function setLayout(layout) { store.layout = layout; persist(); renderLayout(); renderEdit(); }

function renderEdit() {
  editPanel.classList.toggle('hidden', !editing);
  if (!editing) return;
  const on = new Set(store.layout.map((l) => l.id));
  const presetSel = h('select', { 'aria-label': 'Ansicht wählen', onchange: (e) => {
    const v = e.target.value; if (!v) return;
    const [kind, name] = [v.slice(0, 1), v.slice(2)];
    if (kind === 'p') setLayout(fromIds(PRESETS[name]));
    if (kind === 's') { const s = store.saved.find((x) => x.name === name); if (s) setLayout(fromIds(s.layout.map((l) => l.id)).map((l) => ({ ...l, size: s.layout.find((x) => x.id === l.id)?.size || l.size }))); }
  } }, h('option', { value: '' }, 'Ansicht laden …'),
    h('optgroup', { label: 'Vorlagen' }, ...Object.keys(PRESETS).map((n) => h('option', { value: `p:${n}` }, n))),
    store.saved.length ? h('optgroup', { label: 'Meine Ansichten' }, ...store.saved.map((s) => h('option', { value: `s:${s.name}` }, s.name))) : null);
  clear(editPanel).append(
    h('div', { class: 'row between' }, h('h2', {}, 'Bausteine'), h('div', { class: 'row' }, presetSel,
      h('button', { class: 'small', onclick: () => { const name = (prompt('Name für diese Ansicht:') || '').trim().slice(0, 30); if (!name) return; store.saved = store.saved.filter((s) => s.name !== name).concat({ name, layout: store.layout }); persist(); renderEdit(); toast('Ansicht gespeichert'); } }, 'Als Ansicht speichern'),
      store.saved.length ? h('button', { class: 'small ghost', onclick: () => { const name = prompt(`Welche gespeicherte Ansicht löschen?\n${store.saved.map((s) => s.name).join(', ')}`); if (name) { store.saved = store.saved.filter((s) => s.name !== name); persist(); renderEdit(); } } }, 'Löschen …') : null)),
    h('p', { class: 'small muted' }, 'Tippe einen Baustein an, um ihn ein- oder auszublenden. Reihenfolge und Größe änderst du direkt am Baustein.'),
    h('div', { class: 'chips' }, ...available().map((id) => h('button', { class: `chip ${on.has(id) ? 'on' : ''}`, title: WIDGETS[id].desc, onclick: () => toggle(id, !on.has(id)) }, (on.has(id) ? '✓ ' : '+ ') + WIDGETS[id].title))));
}

function renderToolbar() {
  clear(toolbar).append(h('div', {}, h('h2', { style: 'font-size:1.2rem' }, 'Mein Board'), h('div', { class: 'small muted' }, 'Stell dir deine eigene Ansicht zusammen.')),
    h('div', { class: 'row' }, h('button', { class: editing ? 'primary' : '', onclick: () => { editing = !editing; renderToolbar(); renderEdit(); renderLayout(); } }, editing ? '✓ Fertig' : '✎ Bearbeiten')));
}

const top = topbar('Board', { nav: true });
app.append(top, h('div', { class: 'wrap' }, toolbar, editPanel, grid));

function init(s) {
  role = s.role; load();
  if (!store.layout) store.layout = fromIds(PRESETS[defaultPreset()]);
  renderToolbar(); renderLayout();
}
function onState(s) {
  const first = !state; state = s;
  if (first) init(s);
  else for (const l of store.layout) if (mounted.has(l.id) && available().includes(l.id)) mounted.get(l.id).update(s);
}
connect({ ping: true, onStatus: (ok) => top.setLive(ok), onState });
api('/state').then((s) => { if (!state) onState(s); }).catch(() => {});
setInterval(() => { if (state) for (const l of store.layout) if (WIDGETS[l.id]?.roles.includes(role) && ['clock', 'stats'].includes(l.id)) mounted.get(l.id)?.update(state); }, 1000);
