import { h, api, clear, fmtClock, BRAND, $ } from '/assets/app.js';
import { countTo, stagger, confetti } from '/assets/motion.js';

const app = $('#app');
const token = location.pathname.split('/').pop();
const stat = (label, v) => { const b = h('b', { class: 'recap-n' }, '0'); setTimeout(() => countTo(b, v), 150); return h('div', { class: 'card recap-stat' }, b, h('span', {}, label)); };
api(`/recap/${encodeURIComponent(token)}`).then((d) => {
  const top = h('div', { class: 'list' }, ...d.topWished.map((r, i) => h('div', { class: 'item row between' }, h('span', {}, `${i + 1}. ${r.title} – ${r.artist}`), h('b', {}, `${r.votes}×`))));
  const played = h('div', { class: 'list' }, ...d.played.map((r) => h('div', { class: 'item row between' }, h('span', {}, `${r.title} – ${r.artist}`), h('span', { class: 'tiny muted' }, fmtClock(r.ts)))));
  app.append(h('div', { class: 'wrap narrow-wide', style: 'padding-top:6vh' },
    h('div', { class: 'eyebrow' }, BRAND.name), h('h1', { class: 'bm-h', style: 'text-align:left' }, 'Das war die Party! 🎉'),
    h('div', { class: 'grid three' }, stat('Songs gespielt', d.plays), stat('Wünsche', d.wishes), stat('Mitmachende Geräte', d.guests)),
    h('div', { class: 'card stack' }, h('h2', {}, 'Die meistgewünschten Songs'), d.topWished.length ? top : h('div', { class: 'muted' }, '–')),
    h('div', { class: 'card stack' }, h('h2', {}, 'Zuletzt gespielt'), d.played.length ? played : h('div', { class: 'muted' }, '–'))));
  stagger(app.firstChild, 80); setTimeout(() => confetti({ y: 0.2, count: 140 }), 500);
}).catch(() => { clear(app).append(h('div', { class: 'wrap' }, h('p', { class: 'muted' }, 'Dieser Link ist nicht (mehr) gültig.'))); });
