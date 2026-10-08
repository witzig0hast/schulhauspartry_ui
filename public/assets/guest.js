import { h, api, connect, topbar, clear, modal, toast, icon, cover, eq, $ } from '/assets/app.js';

const app = $('#app');
let state = null;
let searchTimer = null;
let searchSeq = 0;

const input = h('input', { type: 'search', placeholder: 'Song oder Interpret suchen …', maxlength: 80, autocomplete: 'off', 'aria-label': 'Song suchen' });
const searchbox = h('div', { class: 'searchbox' }, icon('search'), input);
const results = h('div', { class: 'list' });
const nowEl = h('div', { class: 'np hidden' });
const dots = h('div', { class: 'meter-dots' });
const limitEl = h('div', { class: 'small muted' });
const msgEl = h('div', { class: 'card hidden' });
const mine = h('div', { class: 'list' });
const mineWrap = h('div', { class: 'card stack hidden' }, h('h2', {}, 'Deine Wünsche'), mine);

const NOTICE_KEY = 'noticeSeen';
function maybeShowNotice() {
  const text = state?.notice;
  if (!text) return;
  let seen = null; try { seen = sessionStorage.getItem(NOTICE_KEY); } catch { /* egal */ }
  if (seen === text) return;
  const close = modal([
    h('h2', {}, 'Nachricht von den Organisatoren'),
    h('p', { class: 'big', style: 'font-size:1.2rem' }, text),
    h('button', { class: 'primary', onclick: () => { try { sessionStorage.setItem(NOTICE_KEY, text); } catch { /* egal */ } close(); } }, 'Alles klar'),
  ]);
}

function statusBadge(r) {
  if (r.status === 'pending') return h('span', { class: 'badge warn' }, 'Wartet');
  if (r.status === 'approved') return h('span', { class: 'badge ok' }, 'Angenommen');
  if (r.status === 'playing') return h('span', { class: 'badge ok' }, 'Läuft jetzt!');
  if (r.status === 'played') return h('span', { class: 'badge' }, 'Gespielt');
  if (r.status === 'denied') return h('span', { class: 'badge bad' }, 'Abgelehnt');
  return h('span', { class: 'badge' }, 'Entfernt');
}

function render() {
  if (!state) return;
  if (state.nowPlaying) {
    nowEl.classList.remove('hidden');
    clear(nowEl).append(h('div', { class: 'hero' }, cover(state.nowPlaying.title), h('div', { class: 'meta' },
      h('div', { class: 'row', style: 'gap:8px' }, eq(true), h('span', { class: 'eyebrow' }, 'Jetzt läuft')),
      h('div', { class: 'title', style: 'font-size:1.05rem;font-weight:700;letter-spacing:-.02em' }, state.nowPlaying.title), h('div', { class: 'a muted small' }, state.nowPlaying.artist))));
  } else nowEl.classList.add('hidden');

  const open = state.wishMode === 'open';
  msgEl.classList.toggle('hidden', open);
  if (!open) clear(msgEl).append(h('strong', {}, state.message || 'Wünsche sind gerade nicht möglich.'));
  input.disabled = !open;
  if (!open) clear(results);

  const l = state.limit;
  limitEl.textContent = l.remaining > 0 ? `Noch ${l.remaining} von ${l.max} Wünschen frei · alle ${l.windowMin} Min.` : `Limit erreicht – in ca. ${Math.ceil(l.retryAfterMs / 60000)} Min. geht es weiter.`;
  clear(dots).append(...Array.from({ length: Math.min(l.max, 10) }, (_, i) => h('i', { class: i < l.used ? 'used' : '' })));

  mineWrap.classList.toggle('hidden', !state.requests.length);
  clear(mine);
  for (const r of state.requests) {
    const extra = [];
    if ((r.status === 'pending' || r.status === 'approved') && r.ahead != null) extra.push(h('div', { class: 'small muted' }, r.status === 'pending'
      ? (r.ahead > 0 ? `Wartet auf Freigabe – bis zu ${r.ahead} ${r.ahead === 1 ? 'Lied' : 'Lieder'} vor dir` : 'Wartet auf Freigabe')
      : (r.ahead === 0 ? 'Du bist als Nächstes dran!' : `Noch ${r.ahead} ${r.ahead === 1 ? 'Lied' : 'Lieder'} vor dir`)));
    if (r.status === 'denied' && r.reason) extra.push(h('div', { class: 'small muted' }, `Grund: ${r.reason}`));
    if (r.votes > 1) extra.push(h('div', { class: 'small muted' }, `+${r.votes - 1} weitere wünschen sich das auch`));
    mine.append(h('div', { class: 'item' + (r.status === 'denied' ? ' denied' : '') },
      h('div', { class: 'row between nowrap' }, h('div', { class: 'req-main grow' }, cover(r.title, 'sm'), h('div', { class: 'grow' }, h('div', { class: 't' }, r.title), h('div', { class: 'a' }, r.artist))), statusBadge(r)), ...extra));
  }
}

async function search() {
  const q = input.value.trim();
  const seq = ++searchSeq;
  if (q.length < 2) { clear(results); return; }
  try {
    const out = await api(`/guest/search?q=${encodeURIComponent(q)}`);
    if (seq !== searchSeq) return;
    clear(results);
    if (!out.tracks.length) results.append(h('div', { class: 'muted' }, 'Nichts gefunden. Probier es mit einem anderen Suchwort.'));
    for (const t of out.tracks) {
      results.append(h('div', { class: 'item row between nowrap' },
        h('div', { class: 'req-main grow' }, cover(t.title, 'sm'), h('div', { class: 'grow' }, h('div', { class: 't' }, t.title), h('div', { class: 'a' }, t.artist))),
        t.blocked ? h('span', { class: 'badge' }, 'nicht möglich') : h('button', { class: 'primary small', onclick: () => send(t) }, 'Wünschen')));
    }
  } catch (e) {
    if (seq !== searchSeq) return;
    clear(results).append(h('div', { class: 'muted' }, e.message));
    // Spotify-Limit: kurz warten und die Suche von selbst wiederholen
    if (e.status === 503 && e.data?.retryAfterSec) setTimeout(() => { if (input.value.trim() === q) search(); }, Math.min(20, e.data.retryAfterSec) * 1000 + 300);
  }
}

async function send(t) {
  try {
    const out = await api('/guest/request', { method: 'POST', body: { trackId: t.id } });
    state = out.state; render();
    input.value = ''; clear(results);
    if (out.duplicate) {
      const close = modal([h('h2', {}, 'Schon vorgeschlagen'), h('p', {}, out.info), out.alreadyVoted ? h('p', { class: 'small muted' }, 'Du hast diesen Song schon unterstützt.') : h('p', { class: 'small muted' }, 'Wir haben deinen Wunsch dazugezählt (+1).'), h('button', { class: 'primary', onclick: () => close() }, 'OK')]);
    } else toast(out.info);
  } catch (e) {
    if (e.data?.state) { state = e.data.state; render(); }
    toast(e.message, true);
  }
}

input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(search, 300); });

const bar = topbar('Musikwunsch');
app.append(
  bar,
  h('div', { class: 'wrap narrow' },
    h('div', { class: 'guest-hero' }, h('div', { class: 'eyebrow' }, 'Mach mit'), h('h2', {}, 'Wünsch dir was!')),
    nowEl, msgEl,
    h('div', { class: 'card stack' }, searchbox, h('div', { class: 'row between' }, limitEl, dots), results),
    mineWrap),
);

// Erst den State holen (setzt das Geraete-Cookie), dann den WebSocket oeffnen
api('/guest/state').then((s) => { state = s; render(); maybeShowNotice(); }).catch(() => {}).finally(() => {
  connect({ onStatus: (ok) => bar.setLive(ok), onGuest: (g) => { state = g; render(); } });
});
