import { h, api, connect, topbar, clear, fmtClock, $ } from '/assets/app.js';
import { stagger } from '/assets/motion.js';

const app = $('#app');
const list = h('div', { class: 'tl' });
const ICON = { wish: '✉️', approve: '✅', deny: '❌', play: '🎵', sys: '⚙️' };
let key = '';
async function load() {
  const { events } = await api('/activity');
  const k = events.map((e) => `${e.ts}${e.kind}`).join(',');
  if (k === key) return; const first = !key; key = k;
  clear(list).append(...events.map((e) => h('div', { class: `tl-row act-${e.kind}` }, h('span', { class: 'tiny muted mono' }, fmtClock(e.ts)), h('span', {}, ICON[e.kind] || '•'), h('div', { class: 'grow' }, e.text))));
  if (first) stagger(list, 15);
}
const bar = topbar('Verlauf', { nav: true });
app.append(bar, h('div', { class: 'wrap' }, h('div', { class: 'card stack' }, h('h2', {}, 'Was ist heute passiert?'), h('p', { class: 'small muted' }, 'Anonym – ohne Geräte, nur die Ereignisse.'), list)));
load(); setInterval(() => load().catch(() => {}), 6000);
let last = 0;
connect({ onStatus: (ok) => bar.setLive(ok), onState: () => { if (Date.now() - last > 3000) { last = Date.now(); load().catch(() => {}); } } });
