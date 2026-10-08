import { h, api, connect, clear, cover, fmtClock, BRAND, $ } from '/assets/app.js';
import { stagger, flash } from '/assets/motion.js';

// Playlist des Abends: nur was gelaufen ist (nichts Kommendes, nichts Internes)
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }
const app = $('#app');
const list = h('div', { class: 'list' });
let key = '';
async function load() {
  const d = await api('/guest/public');
  const rows = d.wall || [];
  const k = rows.map((r) => r.ts).join(',');
  if (k === key) return;
  const first = !key; key = k;
  clear(list).append(...(rows.length ? rows.map((r) => h('div', { class: 'item row nowrap' }, cover(r.title, 'sm'), h('div', { class: 'grow' }, h('div', { class: 't' }, r.title), h('div', { class: 'a' }, r.artist)), h('span', { class: 'tiny muted' }, fmtClock(r.ts)))) : [h('div', { class: 'muted' }, 'Die Party fängt gleich an …')]));
  if (first) stagger(list, 35); else flash(list.firstChild, 'flash');
}
app.append(h('div', { class: 'wrap narrow-wide', style: 'padding-top:5vh' }, h('div', { class: 'eyebrow' }, BRAND.name), h('h1', { class: 'bm-h', style: 'text-align:left' }, 'Das lief heute Abend'), list));
load(); setInterval(() => load().catch(() => {}), 10000);
connect({ onGuest: () => load().catch(() => {}) });
