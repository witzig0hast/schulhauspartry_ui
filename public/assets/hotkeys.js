import { h, modal, clear } from '/assets/app.js';

// Frei einstellbare Tastenkuerzel (pro Geraet gespeichert). Standardwerte siehe ACTIONS.
export const ACTIONS = [
  { id: 'approve', label: 'Annehmen', def: 'a' },
  { id: 'deny', label: 'Ablehnen (Gründe öffnen)', def: 'd' },
  { id: 'later', label: 'Später entscheiden', def: 'l' },
  { id: 'ban', label: 'Song sperren', def: 'b' },
  { id: 'back', label: 'Zurück / Abbrechen', def: 'escape' },
  { id: 'fullscreen', label: 'Vollbild', def: 'f' },
  { id: 'noreason', label: 'Ablehnen ohne Grund', def: '0' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `reason${n}`, label: `Grund ${n}`, def: String(n) })),
];
const KEY = 'hotkeys.v1';

export function getHotkeys() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* egal */ }
  return Object.fromEntries(ACTIONS.map((a) => [a.id, typeof saved[a.id] === 'string' ? saved[a.id] : a.def]));
}
const save = (map) => { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* egal */ } };
const norm = (e) => (e.key === ' ' ? 'space' : e.key.toLowerCase());
const pretty = (k) => ({ ' ': 'Leertaste', space: 'Leertaste', escape: 'Esc', enter: 'Enter', backspace: '⌫', '': '–' }[k] ?? k.toUpperCase());

// Welche Aktion gehoert zu dieser Taste? (null, wenn keine / in Eingabefeldern)
export function actionFor(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target?.closest?.('input,textarea,select,[contenteditable]')) return null;
  const k = norm(e), map = getHotkeys();
  return ACTIONS.find((a) => map[a.id] === k)?.id ?? null;
}

// Dialog zum Ansehen und Aendern der Kuerzel: Zeile anklicken, dann die neue Taste druecken
export function openHotkeyEditor() {
  let map = getHotkeys(), waiting = null;
  const list = h('div', { class: 'stack', style: 'gap:6px;max-height:55vh;overflow:auto' });
  const info = h('p', { class: 'small muted' }, 'Auf eine Zeile klicken und dann die gewünschte Taste drücken. Gespeichert wird nur auf diesem Gerät.');
  const paint = () => clear(list).append(...ACTIONS.map((a) => h('button', { class: `row between ${waiting === a.id ? 'primary' : ''}`, style: 'width:100%;justify-content:space-between', onclick: () => { waiting = a.id; paint(); } },
    h('span', {}, a.label), h('kbd', { class: 'kbd' }, waiting === a.id ? 'Taste drücken …' : pretty(map[a.id])))));
  const onKey = (e) => {
    if (!waiting) return;
    e.preventDefault(); e.stopPropagation();
    const k = norm(e);
    if (['shift', 'control', 'alt', 'meta'].includes(k)) return;
    for (const a of ACTIONS) if (map[a.id] === k && a.id !== waiting) map[a.id] = ''; // Doppelbelegung vermeiden
    map[waiting] = k; waiting = null; save(map); paint();
  };
  addEventListener('keydown', onKey, true);
  paint();
  const close = modal([h('h2', {}, '⌨ Tastenkürzel'), info, list,
    h('div', { class: 'row between' }, h('button', { class: 'small ghost', onclick: () => { map = Object.fromEntries(ACTIONS.map((a) => [a.id, a.def])); save(map); waiting = null; paint(); } }, 'Auf Standard zurücksetzen'),
      h('button', { class: 'primary', onclick: () => { removeEventListener('keydown', onKey, true); close(); } }, 'Fertig'))]);
  return close;
}
