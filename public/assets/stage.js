import { h, connect, clear, cover, eq, fmtTime, BRAND, $ } from '/assets/app.js';
import { bar } from '/assets/staff-ui.js';

// Buehnen-Ansicht fuer die Leute am Mikro: gross, ruhig, nur das Wichtige
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }
const app = $('#app');
const clock = h('div', { class: 'stage-clock mono' });
const now = h('div', { class: 'stage-now' });
const next = h('div', { class: 'stage-next' });
const sched = h('div', { class: 'stage-sched' });
const mics = h('div', { class: 'row', style: 'gap:10px;justify-content:center' });
const tick = () => { clock.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); };
tick(); setInterval(tick, 5000);
function render(s) {
  const pl = [1, 2].map((n) => ({ n, p: s.players[n] }));
  const cur = pl.find((x) => x.p.playing && x.n === s.current) || pl.find((x) => x.p.playing);
  clear(now).append(cur ? h('div', {}, h('div', { class: 'row', style: 'gap:10px;justify-content:center' }, eq(true), h('span', { class: 'eyebrow' }, 'Jetzt läuft')), h('div', { class: 'bm-title', style: 'text-align:center' }, cur.p.title), h('div', { class: 'bm-artist', style: 'text-align:center' }, cur.p.artist),
    bar(cur.p.durationMs ? cur.p.positionMs / cur.p.durationMs : 0), h('div', { class: 'mono muted', style: 'text-align:center;margin-top:6px' }, `-${fmtTime(cur.p.remainingMs)}`)) : h('div', { class: 'bm-artist', style: 'text-align:center' }, s.pauseMode ? '⏸ Pause' : 'Gerade läuft nichts'));
  const up = s.upcoming[0];
  clear(next).append(up ? h('div', { class: 'row', style: 'gap:14px;justify-content:center' }, cover(up.title, 'sm'), h('div', {}, h('div', { class: 'eyebrow' }, 'Als Nächstes'), h('b', {}, up.title), h('span', { class: 'muted' }, ` – ${up.artist}`))) : h('div', { class: 'muted', style: 'text-align:center' }, 'Warteschlange leer'));
  const nowM = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  const items = (s.schedule || []).filter((i) => !i.done).slice(0, 4);
  clear(sched).append(...items.map((i) => { const [a, b] = i.at.split(':').map(Number); const diff = a * 60 + b - nowM; return h('div', { class: 'row between' }, h('span', {}, h('b', { class: 'mono' }, i.at), `  ${i.title}`), h('span', { class: 'badge' }, diff <= 0 ? 'jetzt' : `in ${diff} Min.`)); }));
  clear(mics).append(...(s.mics || []).map((m) => h('span', { class: `badge ${m.open ? 'ok' : ''}` }, `${m.name}: ${m.open ? 'offen' : 'stumm'}`)));
}
app.append(h('div', { class: 'stage' }, h('div', { class: 'row between' }, h('span', { class: 'eyebrow' }, BRAND.name), clock), now, next, sched, mics));
connect({ onState: render });
