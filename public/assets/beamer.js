import { h, api, connect, clear, cover, eq, qrElement, BASE, BRAND, $ } from '/assets/app.js';

// Beamer-/Bildschirmansicht fuer die Gaeste: Jetzt laeuft + QR-Code. Oeffentlich, zeigt nichts Internes.
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }

const app = $('#app');
const url = `${location.origin}${BASE}/`;
const nowBox = h('div', { class: 'bm-now' });
const msgBox = h('div', { class: 'bm-msg hidden' });
const qrBox = h('div', { class: 'bm-qr' });
let state = null;

qrElement(url, { size: 300, cls: 'qr' }).then((el) => { clear(qrBox).append(el, h('div', { class: 'bm-url' }, url.replace(/^https?:\/\//, ''))); });

function render() {
  if (!state) return;
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
  h('div', { class: 'bm-left' }, nowBox, msgBox),
  h('div', { class: 'bm-right' }, h('div', { class: 'bm-cta' }, h('div', { class: 'eyebrow' }, 'Mach mit'), h('h1', { class: 'bm-h' }, BRAND.tagline || 'Wünsch dir was!'), h('p', { class: 'bm-sub' }, `${BRAND.name} · QR-Code scannen, Song suchen, wünschen.`)), qrBox)));
connect({ onGuest: (g) => { state = g; render(); } });
api('/guest/state').then((g) => { state = g; render(); }).catch(() => {});
