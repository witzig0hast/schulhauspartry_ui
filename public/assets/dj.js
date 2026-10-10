import { h, api, connect, topbar, clear, safe, toast, fmtClock, cover, $ } from '/assets/app.js';
import { pendingList, empty, isPressing, onRelease, banMenu } from '/assets/staff-ui.js';

// DJ-Ansicht: angenommene Wuensche als Arbeitsliste. "Laeuft jetzt" / "Gespielt" von Hand markieren.
// Im Wunschlisten-Modus spielt der DJ selbst; im normalen Modus ist die Ansicht nur zum Mitlesen.
const app = $('#app');
let state = null;
const memos = new WeakMap();
const update = (box, key, build) => { if (memos.get(box) === key || isPressing()) return; memos.set(box, key); clear(box).append(build()); };
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const post = (path, id) => safe(async () => { await api(path, { method: 'POST', body: { id } }); })();

const bar = topbar('DJ', { nav: true });
const modeBadge = h('span', { class: 'badge' });
const nowBox = h('div', { class: 'card' });
const listBox = h('div', { class: 'card stack' });
const pendBox = h('div', { class: 'card stack' });
const doneBox = h('div', { class: 'card stack' });

const chips = (r) => h('div', { class: 'lt-chips' }, ...(r.families || []).map((f) => h('span', { class: `lt-fam ${f === 'Unbekannt' ? 'unk' : ''}` }, f)), ...(r.genres || []).slice(0, 3).map((g) => h('span', { class: 'lt-gen' }, g)));
const facts = (r) => h('div', { class: 'lt-facts' }, r.year ? h('span', {}, String(r.year)) : null, r.durationMs ? h('span', {}, mmss(r.durationMs)) : null,
  r.explicit ? h('span', { class: 'badge warn' }, 'Explicit') : null, r.votes > 1 ? h('span', { class: 'badge ink' }, `${r.votes}× gewünscht`) : null, r.prioritized ? h('span', { class: 'badge bad' }, '★ Prio') : null);

function render() {
  if (!state) return;
  const wl = state.mode === 'wishlist';
  modeBadge.textContent = wl ? 'Wunschlisten-Modus' : 'Normalbetrieb (App spielt)'; modeBadge.className = `badge ${wl ? 'ok' : ''}`;
  const playing = (state.history || []).find((r) => r.status === 'playing');
  const canMark = wl;   // markieren nur, wenn die App nicht selbst abspielt
  update(nowBox, JSON.stringify([playing?.id, wl]), () => h('div', { class: 'stack' }, h('div', { class: 'eyebrow' }, 'Läuft jetzt'),
    playing ? h('div', { class: 'row between' }, h('div', {}, h('div', { class: 'lt-title', style: 'font-size:2rem' }, playing.title), h('div', { class: 'lt-artist' }, playing.artist), chips(playing), facts(playing)),
      canMark ? h('button', { class: 'ok', onclick: () => post('/dj/played', playing.id) }, '✓ Gespielt') : null)
      : h('div', { class: 'muted' }, wl ? 'Noch nichts markiert. Tippe bei einem Song auf „▶ Läuft jetzt“, sobald du ihn spielst.' : 'Die App spielt selbst – hier siehst du die Wünsche.')));
  const up = state.upcoming || [];
  update(listBox, JSON.stringify([up.map((u) => [u.id, u.prioritized, u.votes]), wl]), () => h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('h2', {}, `Angenommen · ${up.length}`), h('span', { class: 'small muted' }, wl ? 'Reihenfolge = Annahme; ★ Prio rückt Songs nach vorn' : '')),
    up.length ? h('div', { class: 'list' }, ...up.map((u, i) => h('div', { class: `item row between nowrap ${u.prioritized ? 'prio' : ''}` },
      h('div', { class: 'row nowrap', style: 'gap:12px;align-items:flex-start' }, h('div', { class: 'idx' }, String(i + 1)), cover(u.title, 'sm'),
        h('div', {}, h('div', { class: 't' }, u.title), h('div', { class: 'a' }, u.artist), chips(u), facts(u))),
      h('div', { class: 'row' },
        canMark ? h('button', { class: 'small', onclick: () => post('/dj/now', u.id) }, '▶ Läuft jetzt') : null,
        canMark ? h('button', { class: 'small ok', onclick: () => post('/dj/played', u.id) }, '✓ Gespielt') : null,
        h('button', { class: 'small ghost', title: 'Nach vorn (Priorität)', onclick: safe(async () => { await api('/mod/prioritize', { method: 'POST', body: { id: u.id } }); }) }, '★'),
        h('button', { class: 'small ghost', title: 'Entfernen', onclick: safe(async () => { await api('/mod/remove', { method: 'POST', body: { id: u.id } }); }) }, '✕'))))) : empty('Noch nichts angenommen.', 'note')));
  update(pendBox, JSON.stringify([(state.pending || []).map((p) => [p.id, p.votes]), state.settings?.rejectReasons]), () => h('div', { class: 'stack' }, h('h2', {}, `Offene Wünsche · ${(state.pending || []).length}`), pendingList(state, { canAct: true, assign: () => 'auto', me: state.me })));
  const done = (state.history || []).filter((r) => r.status === 'played').slice(0, 15);
  update(doneBox, JSON.stringify(done.map((r) => [r.id, wl])), () => h('div', { class: 'stack' }, h('h2', {}, 'Zuletzt gespielt'),
    done.length ? h('div', { class: 'list' }, ...done.map((r) => h('div', { class: 'item row between nowrap' }, h('div', {}, h('div', { class: 't' }, r.title), h('div', { class: 'a' }, `${r.artist}${r.playedAt ? ` · ${fmtClock(r.playedAt)}` : ''}`)),
      canMark ? h('button', { class: 'small ghost', title: 'Versehentlich? Zurück in die Liste', onclick: () => post('/dj/undo', r.id) }, '↩') : null))) : h('div', { class: 'muted small' }, 'Noch nichts.')));
}
void banMenu;

app.append(bar, h('div', { class: 'wrap' }, h('div', { class: 'row between' }, modeBadge, h('span', { class: 'small muted' }, 'Setlist und Bericht enthalten die hier markierten Songs.')), nowBox, listBox, pendBox, doneBox));
onRelease(() => { if (state) render(); });
connect({ onStatus: (ok) => bar.setLive(ok), onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
