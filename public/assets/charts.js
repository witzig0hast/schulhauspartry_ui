import { h, api, connect, clear, cover, BRAND, $ } from '/assets/app.js';
import { countTo, stagger } from '/assets/motion.js';

// Oeffentliche Rangliste der meistgewuenschten Songs (fuer einen Bildschirm)
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }
const app = $('#app');
const list = h('div', { class: 'charts' });
let key = '';
async function load() {
  const d = await api('/guest/public');
  const rows = d.charts || [];
  const k = JSON.stringify(rows.map((r) => [r.title, r.votes]));
  if (k === key) return;
  const first = !key; key = k;
  const max = Math.max(1, ...rows.map((r) => r.votes));
  clear(list).append(...(rows.length ? rows.map((r, i) => h('div', { class: 'chart-row' },
    h('div', { class: 'chart-rank' }, String(i + 1)), cover(r.title, 'sm'),
    h('div', { class: 'grow' }, h('div', { class: 't' }, r.title), h('div', { class: 'a' }, r.artist), h('div', { class: 'chart-bar' }, h('i', { style: `width:${Math.round(100 * r.votes / max)}%` }))),
    h('div', { class: 'chart-votes' }, h('b', { 'data-v': '0' }, String(r.votes)), h('span', {}, r.votes === 1 ? 'Stimme' : 'Stimmen')))) : [h('div', { class: 'muted' }, 'Noch keine Wünsche – scannt den QR-Code!')]));
  if (first) stagger(list, 60);
  list.querySelectorAll('.chart-votes b').forEach((b, i) => countTo(b, rows[i].votes));
}
app.append(h('div', { class: 'wrap narrow-wide', style: 'padding-top:5vh' }, h('div', { class: 'eyebrow' }, BRAND.name), h('h1', { class: 'bm-h', style: 'text-align:left' }, 'Wunsch-Charts'), list));
load(); setInterval(() => load().catch(() => {}), 8000);
connect({ onGuest: () => load().catch(() => {}) });
