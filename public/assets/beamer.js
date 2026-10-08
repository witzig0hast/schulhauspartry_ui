import { h, api, connect, clear, cover, eq, qrElement, BASE, BRAND, $, feat } from '/assets/app.js';
import { stagger, flash } from '/assets/motion.js';

// Beamer-/Bildschirmansicht fuer die Gaeste: Jetzt laeuft + QR-Code. Oeffentlich, zeigt nichts Internes.
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }

const app = $('#app');
const url = `${location.origin}${BASE}/`;
const nowBox = h('div', { class: 'bm-now' });
const msgBox = h('div', { class: 'bm-msg hidden' });
const qrBox = h('div', { class: 'bm-qr' });
let state = null;
let pub = null;
const extraBox = h('div', { class: 'bm-extra' });

qrElement(url, { size: 300, cls: 'qr' }).then((el) => { clear(qrBox).append(el, h('div', { class: 'bm-url' }, url.replace(/^https?:\/\//, ''))); });

function renderExtra() {
  const parts = [];
  if (pub?.pause) parts.push(h('div', { class: 'bm-pause' }, h('div', { class: 'bm-pause-ic' }, '⏸'), h('div', { class: 'bm-msgtext' }, pub.pause)));
  const p = pub?.poll;
  if (p) parts.push(h('div', { class: 'bm-poll' }, h('div', { class: 'eyebrow' }, p.status === 'open' ? 'Abstimmen am Handy' : 'Ergebnis'), h('div', { class: 'bm-msgtext' }, p.question),
    ...p.options.map((o, i) => { const pct = p.total ? Math.round(100 * p.counts[i] / p.total) : 0; return h('div', { class: 'bm-bar' }, h('i', { style: `width:${pct}%` }), h('span', {}, o), h('b', {}, `${pct} %`)); })));
  const next = (pub?.schedule || [])[0];
  if (next && !p && !pub?.pause) parts.push(h('div', { class: 'bm-next' }, h('span', { class: 'eyebrow' }, 'Gleich'), h('b', {}, `${next.at} · ${next.title}`)));
  const key = JSON.stringify(parts.length ? [pub?.pause, p, next] : null);
  if (extraBox.dataset.k === key) return;
  extraBox.dataset.k = key; clear(extraBox).append(...parts); flash(extraBox, 'flash');
}

function render() {
  if (!state) return;
  renderExtra();
  const np = state.nowPlaying;
  clear(nowBox).append(np
    ? h('div', { class: 'bm-hero' }, cover(np.title, 'xl'), h('div', {}, h('div', { class: 'row', style: 'gap:10px' }, eq(true), h('span', { class: 'eyebrow' }, 'Jetzt läuft')), h('div', { class: 'bm-title' }, np.title), h('div', { class: 'bm-artist' }, np.artist)))
    : h('div', { class: 'bm-hero idle' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Gleich geht’s weiter'), h('div', { class: 'bm-title' }, 'Musikwünsche?'))));
  const notice = state.notice;
  const text = state.wishMode !== 'open' ? state.message : notice;
  msgBox.classList.toggle('hidden', !text);
  if (text) { clear(msgBox).append(h('div', { class: 'eyebrow' }, state.wishMode !== 'open' ? 'Hinweis' : 'Nachricht der Organisatoren'), h('div', { class: 'bm-msgtext' }, text)); }
}

app.append(h('div', { class: 'beamer' },
  h('div', { class: 'bm-left' }, nowBox, extraBox, msgBox),
  h('div', { class: 'bm-right' }, h('div', { class: 'bm-cta' }, h('div', { class: 'eyebrow' }, 'Mach mit'), h('h1', { class: 'bm-h' }, BRAND.tagline || 'Wünsch dir was!'), h('p', { class: 'bm-sub' }, `${BRAND.name} · QR-Code scannen, Song suchen, wünschen.`)), qrBox)));
const loadPub = () => api('/guest/public').then((d) => { pub = d; render(); }).catch(() => {});
connect({ onGuest: (g) => { state = g; render(); loadPub(); } });
setInterval(loadPub, 20000);
if (feat('beamerFx')) document.body.classList.add('fx-aurora');
api('/guest/state').then((g) => { state = g; render(); loadPub(); }).catch(() => {});
