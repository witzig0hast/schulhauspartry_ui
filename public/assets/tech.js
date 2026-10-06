import { h, api, connect, topbar, clear, logout, safe, toast, $, fmtTime } from '/assets/app.js';
import { pendingList, upcomingList, ampel, bar, playerName } from '/assets/staff-ui.js';

const app = $('#app');
let state = null;
let assignMode = 'auto';
const refs = {};
const memo = {};

const setVal = (input, v) => { if (document.activeElement !== input && String(input.value) !== String(v)) input.value = v; };
const setCheck = (input, v) => { if (document.activeElement !== input) input.checked = !!v; };
const post = (path, body = {}) => safe(async () => { await api(path, { method: 'POST', body }); })();

function numInput(value, { min = 0.5, max = 120, step = 0.5, onchange } = {}) {
  const i = h('input', { class: 'num', type: 'number', min, max, step, value });
  if (onchange) i.addEventListener('change', () => onchange(Number(i.value)));
  return i;
}

function presetRow(target) {
  const row = h('div', { class: 'row' });
  refs.presetRows ||= [];
  refs.presetRows.push({ row, target });
  return row;
}
function fillPresets() {
  for (const { row, target } of refs.presetRows || []) {
    const key = JSON.stringify(state.settings.fadePresets);
    if (row.dataset.k === key) continue;
    row.dataset.k = key;
    clear(row).append(...state.settings.fadePresets.map((p) => h('button', { class: 'small ghost', onclick: () => { target.value = p.sec; target.dispatchEvent(new Event('change')); } }, `${p.name} ${p.sec}s`)));
  }
}

// ---------- Player ----------
function playerCard(n) {
  const r = refs[`p${n}`] = {};
  r.title = h('div', { class: 'title' }, '—'); r.artist = h('div', { class: 'muted small' });
  r.status = h('span', { class: 'badge' }); r.pos = h('span', {}); r.rem = h('span', {});
  r.prog = bar(0, `p${n}`); r.meter = bar(0, 'meter');
  r.fader = h('input', { type: 'range', min: 0, max: 100, value: 100, 'aria-label': `Fader Player ${n}` });
  let t = 0;
  r.fader.addEventListener('input', () => { const now = Date.now(); if (now - t > 80) { t = now; api('/control/gain', { method: 'POST', body: { player: n, value: r.fader.value / 100 } }).catch(() => {}); } });
  r.fader.addEventListener('change', () => api('/control/gain', { method: 'POST', body: { player: n, value: r.fader.value / 100 } }).catch(() => {}));
  r.faderVal = h('span', { class: 'small muted' });
  r.fadeSec = numInput(5);
  return h('div', { class: `card stack player ${n === 2 ? 'p2' : ''}` },
    h('div', { class: 'row between' }, h('h2', {}, playerName(n)), r.status),
    r.title, r.artist, r.prog, h('div', { class: 'row between tiny muted' }, r.pos, r.rem),
    h('div', { class: 'tiny muted' }, 'Pegel'), r.meter,
    h('div', { class: 'row between small' }, h('span', {}, 'Fader'), r.faderVal), r.fader,
    h('div', { class: 'row' },
      h('button', { onclick: () => post('/control/play', { player: n }) }, '▶ Play'),
      h('button', { onclick: () => post('/control/pause', { player: n }) }, '⏸ Pause')),
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Fade-Zeit'), r.fadeSec, h('span', { class: 'small muted' }, 's')),
    presetRow(r.fadeSec),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => post('/control/fade-in', { player: n, sec: Number(r.fadeSec.value) }) }, '↗ Fade-In'),
      h('button', { onclick: () => post('/control/fade-out', { player: n, sec: Number(r.fadeSec.value) }) }, '↘ Fade-Out')));
}

function updatePlayer(n) {
  const p = state.players[n], r = refs[`p${n}`];
  r.title.textContent = p.title || '—'; r.artist.textContent = p.artist || '';
  r.status.textContent = p.fading ? '〰 Fade' : p.playing ? '▶ spielt' : '⏸ gestoppt';
  r.status.className = `badge ${p.playing ? 'ok' : ''}`;
  r.pos.textContent = fmtTime(p.positionMs); r.rem.textContent = `-${fmtTime(p.remainingMs)}`;
  r.prog.firstChild.style.width = `${(p.durationMs ? p.positionMs / p.durationMs : 0) * 100}%`;
  r.meter.firstChild.style.width = `${Math.min(1, p.meter || 0) * 100}%`;
  r.faderVal.textContent = `${Math.round((p.gain ?? 1) * 100)} % (Ausgang ${Math.round((p.level ?? 1) * 100)} %)`;
  if (document.activeElement !== r.fader) r.fader.value = Math.round((p.gain ?? 1) * 100);
}

// ---------- Crossfade / Auto ----------
function crossfadeCard() {
  refs.cfSec = numInput(8);
  refs.cfBar = bar(0); refs.cfInfo = h('div', { class: 'small muted' });
  refs.autoOn = h('input', { type: 'checkbox' });
  refs.autoSec = numInput(8, { onchange: (v) => post('/settings/tech', { auto: { crossfadeSec: v } }) });
  refs.before1 = numInput(20, { min: 1, max: 180, step: 1, onchange: (v) => post('/settings/tech', { auto: { startBeforeEndSec: { 1: v } } }) });
  refs.before2 = numInput(20, { min: 1, max: 180, step: 1, onchange: (v) => post('/settings/tech', { auto: { startBeforeEndSec: { 2: v } } }) });
  refs.curve = h('select', { onchange: (e) => post('/settings/tech', { auto: { curve: e.target.value } }) }, h('option', { value: 'equalPower' }, 'Gleiche Lautheit (empfohlen)'), h('option', { value: 'linear' }, 'Linear'));
  refs.autoOn.addEventListener('change', () => post('/settings/tech', { auto: { enabled: refs.autoOn.checked } }));
  return h('div', { class: 'card stack' },
    h('h2', {}, 'Crossfade'),
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Manuell, Dauer'), refs.cfSec, h('span', { class: 'small muted' }, 's')),
    presetRow(refs.cfSec),
    h('button', { class: 'primary', onclick: () => post('/control/crossfade', { sec: Number(refs.cfSec.value) }) }, '⇄ Crossfade zum nächsten Song'),
    refs.cfBar, refs.cfInfo,
    h('hr', { style: 'border:0;border-top:1px solid var(--line);width:100%' }),
    h('label', { class: 'check' }, refs.autoOn, h('strong', {}, 'Auto-Crossfade')),
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Dauer'), refs.autoSec, h('span', { class: 'small muted' }, 's')),
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Start vor Songende: Player 1'), refs.before1, h('span', { class: 'small muted' }, 'Player 2'), refs.before2, h('span', { class: 'small muted' }, 's')),
    h('label', { class: 'field' }, 'Kurve', refs.curve));
}

function ducking() {
  refs.duckOn = h('input', { type: 'checkbox' });
  refs.duckDb = numInput(-12, { min: -40, max: -1, step: 1, onchange: (v) => post('/settings/tech', { ducking: { db: v } }) });
  refs.duckOn.addEventListener('change', () => post('/settings/tech', { ducking: { enabled: refs.duckOn.checked } }));
  refs.duckState = h('span', { class: 'badge' });
  refs.micBox = h('div', { class: 'stack' });
  return h('div', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h2', {}, 'Mikrofone & Ducking'), refs.duckState),
    h('label', { class: 'check' }, refs.duckOn, h('strong', {}, 'Ducking (Musik leiser bei offenem Mic)')),
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Absenkung'), refs.duckDb, h('span', { class: 'small muted' }, 'dB')),
    refs.micBox);
}

function updateMics() {
  const key = (state.mics || []).map((m) => m.open).join() + (state.connections?.x32.detail || '');
  const sim = (state.connections?.x32.detail || '').includes('simuliert');
  if (refs.micKey !== key) {
    refs.micKey = key; refs.micBars = [];
    clear(refs.micBox).append(...(state.mics || []).map((m, i) => {
      const b = bar(0, 'meter'); refs.micBars.push(b);
      return h('div', { class: 'stack' }, h('div', { class: 'row between small' }, h('span', {}, m.name), h('span', { class: 'row' },
        h('span', { class: `badge ${m.open ? 'ok' : ''}` }, m.open ? 'offen' : 'stumm'),
        sim ? h('button', { class: 'small ghost', onclick: () => post('/control/mic-sim', { index: i, open: !m.open }) }, m.open ? 'Sim: zu' : 'Sim: auf') : null)), b);
    }));
  }
  (state.mics || []).forEach((m, i) => { if (refs.micBars[i]) refs.micBars[i].firstChild.style.width = `${Math.min(1, m.level) * 100}%`; });
}

// ---------- Betrieb ----------
function operationsCard() {
  refs.wishBtns = ['open', 'paused', 'closed'].map((m) => {
    const b = h('button', { onclick: () => post('/control/wishmode', { mode: m }) }, { open: 'Offen', paused: 'Pausiert', closed: 'Geschlossen' }[m]);
    b.dataset.mode = m; return b;
  });
  refs.noticeOn = h('input', { type: 'checkbox' });
  refs.noticeText = h('textarea', { rows: 2, maxlength: 400, placeholder: 'z. B. Macht Stimmung! 🎉' });
  refs.noticeSave = h('button', { class: 'small', onclick: () => post('/settings/tech', { notice: { enabled: refs.noticeOn.checked, text: refs.noticeText.value } }).then(() => toast('Hinweis gespeichert')) }, 'Hinweis speichern');
  refs.endBtn = h('button', { onclick: onEnd }, '🏁 Ende-Modus');
  refs.panic = h('button', { class: 'bad', style: 'font-size:1.1rem;padding:14px', onclick: onPanic }, '⛔ NOT-AUS');
  refs.panicClear = h('button', { class: 'hidden', onclick: () => post('/control/panic-clear') }, 'Not-Aus aufheben');
  refs.endInfo = h('div', { class: 'small muted' });
  return h('div', { class: 'card stack' },
    h('h2', {}, 'Betrieb'),
    h('div', { class: 'small muted' }, 'Wunschmodus'), h('div', { class: 'row' }, ...refs.wishBtns),
    h('div', { class: 'small muted' }, 'Hinweis für Gäste (Pop-up vor dem Wunsch)'),
    refs.noticeText, h('div', { class: 'row' }, h('label', { class: 'check' }, refs.noticeOn, 'anzeigen'), refs.noticeSave),
    h('hr', { style: 'border:0;border-top:1px solid var(--line);width:100%' }),
    h('div', { class: 'row' }, refs.endBtn, refs.endInfo),
    h('div', { class: 'row' }, refs.panic, refs.panicClear));
}

let panicTimer = null;
async function onPanic() {
  if (!refs.panicNonce) {
    const out = await api('/control/panic-arm', { method: 'POST', body: {} }).catch((e) => { toast(e.message, true); });
    if (!out) return;
    refs.panicNonce = out.nonce;
    refs.panic.textContent = '⛔ NOCHMAL DRÜCKEN!'; refs.panic.classList.add('panic-armed');
    panicTimer = setTimeout(resetPanic, 4500);
    return;
  }
  const nonce = refs.panicNonce; resetPanic();
  await post('/control/panic', { nonce });
}
function resetPanic() { clearTimeout(panicTimer); refs.panicNonce = null; refs.panic.textContent = '⛔ NOT-AUS'; refs.panic.classList.remove('panic-armed'); }

async function onEnd() {
  if (state.ended) { await post('/control/end-clear'); return; }
  if (!confirm('Ende-Modus starten? Musik wird ausgeblendet und Wünsche werden geschlossen.')) return;
  await post('/control/end', { sec: 10 });
}

// ---------- Wuensche ----------
function wishesCard() {
  refs.pendingBox = h('div'); refs.upBox = h('div');
  refs.assign = h('select', { onchange: (e) => { assignMode = e.target.value; } }, h('option', { value: 'auto' }, 'Auto-Zuweisung'), h('option', { value: '1' }, 'Player 1'), h('option', { value: '2' }, 'Player 2'));
  refs.pendingTitle = h('summary', { style: 'cursor:pointer;font-weight:600' }, 'Wünsche');
  return h('details', { class: 'card stack', open: true }, refs.pendingTitle,
    h('div', { class: 'stack', style: 'margin-top:10px' }, h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Zuweisung:'), refs.assign),
      refs.pendingBox, h('h3', {}, 'Warteschlange'), refs.upBox));
}

function memoSet(box, key, build) {
  if (memo[box.dataset.m ||= String(Math.random())] === key) return;
  memo[box.dataset.m] = key; clear(box).append(build());
}

function render() {
  if (!state) return;
  updatePlayer(1); updatePlayer(2); fillPresets(); updateMics();
  const cf = state.crossfade;
  refs.cfBar.firstChild.style.width = `${(cf ? cf.progress : 0) * 100}%`;
  refs.cfInfo.textContent = cf ? `Crossfade läuft: Player ${cf.from} → Player ${cf.to}` : `Warteschlange: ${state.upcomingTotal} Song(s)`;
  setCheck(refs.autoOn, state.auto.enabled); setVal(refs.autoSec, state.auto.crossfadeSec);
  setVal(refs.before1, state.auto.startBeforeEndSec[1]); setVal(refs.before2, state.auto.startBeforeEndSec[2]); setVal(refs.curve, state.auto.curve);
  setCheck(refs.duckOn, state.ducking.enabled); setVal(refs.duckDb, state.ducking.db);
  refs.duckState.textContent = state.ducking.active ? 'Ducking aktiv' : 'bereit'; refs.duckState.className = `badge ${state.ducking.active ? 'warn' : ''}`;
  for (const b of refs.wishBtns) b.className = b.dataset.mode === state.wishMode ? 'primary' : '';
  setCheck(refs.noticeOn, state.notice.enabled); setVal(refs.noticeText, state.notice.text);
  refs.endBtn.textContent = state.ended ? '↩ Ende-Modus aufheben' : '🏁 Ende-Modus';
  refs.panicClear.classList.toggle('hidden', !state.panic);
  refs.badges.textContent = ''; 
  if (state.panic) refs.badges.append(h('span', { class: 'badge bad' }, 'NOT-AUS'));
  if (state.ended) refs.badges.append(h('span', { class: 'badge warn' }, 'ENDE'));
  clear(refs.ampel).append(ampel(state.connections));
  clear(refs.errors).append(...state.errors.map((e) => h('div', { class: 'tiny muted' }, `${new Date(e.ts).toLocaleTimeString('de-DE')} ${e.msg}`)));
  refs.pendingTitle.textContent = `Wünsche (${state.pending.length} offen)`;
  memoSet(refs.pendingBox, JSON.stringify(state.pending.map((p) => [p.id, p.votes])), () => pendingList(state, { canAct: true, assign: () => assignMode }));
  memoSet(refs.upBox, JSON.stringify(state.upcoming.map((u) => [u.id, u.player, u.prioritized])), () => upcomingList(state, { canAct: true }));
}

refs.badges = h('span', { class: 'row' });
refs.ampel = h('div'); refs.errors = h('div');
app.append(
  topbar('Technik (FOH)', { right: [refs.badges, h('button', { class: 'ghost small', onclick: logout }, 'Abmelden')] }),
  h('div', { class: 'wrap stack' },
    h('div', { class: 'card' }, refs.ampel, refs.errors),
    h('div', { class: 'grid two' }, playerCard(1), playerCard(2)),
    h('div', { class: 'grid two' }, crossfadeCard(), ducking()),
    h('div', { class: 'grid two' }, wishesCard(), operationsCard())),
);
connect({ ping: true, onState: (s) => { state = s; render(); } });
api('/state').then((s) => { if (!state) { state = s; render(); } }).catch(() => {});
