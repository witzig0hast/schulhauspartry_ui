import { h, api, connect, clear, cover, toast, BASE, $ } from '/assets/app.js';
import { ban } from '/assets/staff-ui.js';

// Fokus-Modus: komplett schwarz, bis ein neuer Wunsch kommt. Dann ein grosser Vorschlag mit Annehmen / Ablehnen.
document.documentElement.classList.add('fx');
const app = $('#app');
let state = null;
let current = null;       // aktuell gezeigter Wunsch
let denying = false;      // Ablehnungsgruende sichtbar
let busy = false;
let lastKey = '';
let sound = true;
try { sound = localStorage.getItem('fx.sound') !== '0'; } catch { /* egal */ }

const stage = h('div', { class: 'fx-wrap' });
const dot = h('div', { class: 'fx-dot off' });
const soundBtn = h('button', { title: 'Ton bei neuem Wunsch', onclick: () => { sound = !sound; try { localStorage.setItem('fx.sound', sound ? '1' : '0'); } catch { /* egal */ } paintCorner(); if (sound) beep(); } });
const fsBtn = h('button', { title: 'Vollbild (F)', onclick: toggleFs }, '⛶');
const corner = h('div', { class: 'fx-corner' }, soundBtn, fsBtn, h('a', { href: `${BASE}/mod`, title: 'Zurück zur Moderation' }, '✕'));
function paintCorner() { soundBtn.textContent = sound ? '🔔 Ton an' : '🔕 Ton aus'; }
paintCorner();
function toggleFs() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); }

let ctx;
function beep() {
  if (!sound) return;
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(880, ctx.currentTime); o.frequency.setValueAtTime(1175, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.36);
  } catch { /* Ton ist optional */ }
}

async function decide(action, reason) {
  if (!current || busy) return;
  busy = true;
  const id = current.id;
  try {
    const body = { id, action, reason };
    const out = await api('/mod/decide', { method: 'POST', body });
    toast(action === 'approve' ? `✓ Player ${out.request.player}` : '✕ Abgelehnt');
  } catch (e) { toast(e.message, true); }
  busy = false; denying = false;
  // optimistisch ausblenden, bis der Server den naechsten Zustand schickt
  state.pending = state.pending.filter((p) => p.id !== id); render();
}

async function banSong(kind, artistName) {
  if (!current || busy) return;
  const r = current; busy = true;
  await ban({ kind, trackId: r.trackId, title: r.title, artist: r.artist, artistName, reason: 'Gesperrt (Fokus)' }, kind === 'artist' ? artistName : `„${r.title}“`);
  busy = false; denying = false;
}

function render() {
  if (!state) return;
  const next = state.pending[0] || null;
  const isNew = next && (!current || current.id !== next.id);
  if (isNew) { denying = false; beep(); }
  current = next;
  const key = JSON.stringify([next?.id, next?.votes, denying, state.pending.length, state.settings.rejectReasons]);
  if (key === lastKey) return; // nicht bei jedem Server-Takt neu aufbauen (sonst flackert die Animation)
  lastKey = key;
  clear(stage);
  if (!current) { stage.append(corner, dot, h('div', { class: 'fx-hint' }, 'Wartet auf neue Wünsche …  ·  F = Vollbild')); return; }
  const r = current;
  const reasons = state.settings.rejectReasons;
  const age = Math.max(0, Math.round((Date.now() - r.createdAt) / 60000));
  stage.append(corner, dot,
    h('div', { class: 'fx-card' },
      cover(r.title, 'xl'),
      h('div', {}, h('div', { class: 'fx-title' }, r.title), h('div', { class: 'fx-artist' }, r.artist)),
      h('div', { class: 'fx-meta' },
        r.explicit ? h('span', { class: 'badge warn' }, 'Explicit') : null,
        r.votes > 1 ? h('span', { class: 'badge' }, `+${r.votes - 1} wünschen sich das auch`) : null,
        r.year ? h('span', { class: 'badge' }, String(r.year)) : null,
        h('span', { class: 'badge' }, age < 1 ? 'gerade eben' : `vor ${age} Min.`)),
      denying
        ? h('div', { class: 'stack', style: 'width:100%;gap:18px' },
            h('div', { class: 'fx-reasons' }, ...reasons.map((x, i) => h('button', { onclick: () => decide('deny', x) }, h('kbd', {}, String(i + 1)), x)), h('button', { onclick: () => decide('deny') }, h('kbd', {}, '0'), 'Ohne Grund')),
            h('div', { class: 'fx-reasons' }, h('button', { class: 'danger-btn', onclick: () => banSong('track') }, h('kbd', {}, 'B'), '⛔ Song sperren'),
              ...(r.artists || []).map((a) => h('button', { class: 'danger-btn', onclick: () => { if (confirm(`Interpret „${a}“ komplett sperren?`)) banSong('artist', a); } }, `⛔ ${a}`)),
              h('button', { onclick: () => { denying = false; render(); } }, h('kbd', {}, 'Esc'), 'Zurück')))
        : h('div', { class: 'fx-btns' }, h('button', { class: 'ok', onclick: () => decide('approve') }, '✓  Annehmen'), h('button', { class: 'bad', onclick: () => { denying = true; render(); } }, '✕  Ablehnen')),
      state.pending.length > 1 ? h('div', { class: 'fx-more' }, `+ ${state.pending.length - 1} weitere warten`) : null));
}

addEventListener('keydown', (e) => {
  if (e.target.closest?.('input,textarea,select')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') toggleFs();
  if (!current) return;
  if (!denying && (k === 'a' || k === 'enter' || k === ' ')) { e.preventDefault(); decide('approve'); }
  else if (!denying && (k === 'd' || k === 'backspace' || k === 'x')) { e.preventDefault(); denying = true; render(); }
  else if (denying && k === 'escape') { denying = false; render(); }
  else if (denying && /^[0-9]$/.test(k)) { const i = Number(k); decide('deny', i === 0 ? undefined : state.settings.rejectReasons[i - 1]); }
  else if (denying && k === 'b') banSong('track');
});
addEventListener('pointerdown', () => { if (sound && !ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* egal */ } } }, { once: true });
navigator.wakeLock?.request('screen').catch(() => {});

app.append(stage);
connect({ onStatus: (ok) => dot.classList.toggle('off', !ok), onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
setInterval(() => { if (state && current && !denying) { lastKey = ''; render(); } }, 30000);
