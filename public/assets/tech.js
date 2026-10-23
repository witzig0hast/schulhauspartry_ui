import { h, api, connect, topbar, clear, safe, toast, $, fmtTime, eq, feat, coverOnce } from '/assets/app.js';
import { pendingList, upcomingList, bar, playerName, chatPanel, isPressing, onRelease, connectionDot, addSongBox } from '/assets/staff-ui.js';
import { openLevels } from '/assets/levels.js';
import { aiCard } from '/assets/ai-ui.js';

// Technik-Ansicht. Aufbau nach dem, was man am Pult zuerst braucht:
//   Statusleiste (Verbindungen, Automatik, Mics) → Player mit Pegel und Fader → Uebergang & Betrieb → KI → Wuensche
//   und unten immer sichtbar: Crossfade und Not-Aus.
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }   // am Pult ist es dunkel
const app = $('#app');
let state = null, got = 0;
let assignMode = 'auto';
const refs = {};
const memo = {};

const setVal = (input, v) => { if (document.activeElement !== input && String(input.value) !== String(v)) input.value = v; };
const post = (path, body = {}) => safe(async () => { await api(path, { method: 'POST', body }); })();
const pad = (n) => String(n).padStart(2, '0');
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const swap = (slot, key, build) => { if (slot.dataset.k === key) return; slot.dataset.k = key; clear(slot).append(build()); };

function numInput(value, { min = 0.5, max = 120, step = 0.5, onchange } = {}) {
  const i = h('input', { class: 'num', type: 'number', min, max, step, value });
  if (onchange) i.addEventListener('change', () => onchange(Number(i.value)));
  return i;
}
function presetRow(target) {
  const row = h('div', { class: 'row' });
  (refs.presetRows ||= []).push({ row, target });
  return row;
}
function fillPresets() {
  for (const { row, target } of refs.presetRows || []) {
    const key = JSON.stringify(state.settings.fadePresets);
    if (row.dataset.k === key) continue;
    row.dataset.k = key;
    clear(row).append(...state.settings.fadePresets.map((p) => h('button', { class: 'small', onclick: () => { target.value = p.sec; target.dispatchEvent(new Event('change')); } }, `${p.name} ${p.sec}s`)));
  }
}

// ---------- Statusleiste ----------
function statusStrip() {
  refs.conn = h('div', { class: 'row', style: 'gap:6px' });
  refs.autoBtn = h('button', { class: 'tog', title: 'Auto-Crossfade: wechselt am Songende von selbst', onclick: () => post('/settings/tech', { auto: { enabled: !state.auto.enabled } }) }, 'Auto-Crossfade');
  refs.duckBtn = h('button', { class: 'tog', title: 'Ducking: Musik leiser, solange ein Mikrofon offen ist', onclick: () => post('/settings/tech', { ducking: { enabled: !state.ducking.enabled } }) }, 'Ducking');
  refs.micChips = h('div', { class: 'row', style: 'gap:6px' });
  refs.wishChip = h('span', { class: 'badge' });
  return h('div', { class: 'tstrip' }, refs.conn, h('div', { class: 'grow' }), refs.wishChip, refs.micChips, refs.autoBtn, refs.duckBtn);
}
function updateStrip() {
  const c = state.connections;
  if (c) swap(refs.conn, JSON.stringify(['x32', 'spotify', 'player1', 'player2'].map((k) => [c[k]?.ok, c[k]?.detail])), () => h('div', { class: 'row', style: 'gap:6px' },
    ...[['Spotify', c.spotify], ['P1', c.player1], ['P2', c.player2], ['X32', c.x32]].map(([n, x]) => h('span', { class: 'pill small', title: x?.detail || '' }, connectionDot(x || {}), n)),
    c.mode !== 'echte Verbindungen' ? h('span', { class: 'badge' }, 'simuliert') : null));
  refs.autoBtn.className = `tog ${state.auto.enabled ? 'on' : ''}`;
  refs.autoBtn.textContent = `Auto-Crossfade ${state.auto.enabled ? 'an' : 'aus'}`;
  refs.duckBtn.className = `tog ${state.ducking.enabled ? 'on' : ''} ${state.ducking.active ? 'hot' : ''}`;
  refs.duckBtn.textContent = state.ducking.active ? 'Ducking aktiv' : `Ducking ${state.ducking.enabled ? 'an' : 'aus'}`;
  const wm = { open: ['ok', 'Wünsche offen'], paused: ['warn', 'Wünsche pausiert'], closed: ['bad', 'Wünsche zu'] }[state.wishMode] || ['', ''];
  refs.wishChip.className = `badge ${wm[0]}`; refs.wishChip.textContent = wm[1];
  swap(refs.micChips, (state.mics || []).map((m) => `${m.name}${m.open}`).join(), () => h('div', { class: 'row', style: 'gap:6px' }, ...(state.mics || []).map((m) => h('span', { class: `badge ${m.open ? 'warn' : ''}` }, `${m.name}${m.open ? ' offen' : ''}`))));
}

// ---------- Player ----------
function playerCard(n) {
  const r = refs[`p${n}`] = {};
  r.cov = h('div');
  r.title = h('div', { class: 'dt', style: 'font-size:1.3rem' }, '—'); r.artist = h('div', { class: 'muted small' });
  r.status = h('span', { class: 'badge' }); r.eq = eq(false); r.pos = h('span', {}); r.rem = h('span', {});
  r.prog = bar(0, `p${n}`); r.meter = bar(0, 'meter dmeter');
  r.fader = h('input', { type: 'range', min: 0, max: 100, value: 100, 'aria-label': `Fader Player ${n}` });
  let t = 0;
  r.fader.addEventListener('input', () => { const now = Date.now(); if (now - t > 80) { t = now; api('/control/gain', { method: 'POST', body: { player: n, value: r.fader.value / 100 } }).catch(() => {}); } });
  r.fader.addEventListener('change', () => api('/control/gain', { method: 'POST', body: { player: n, value: r.fader.value / 100 } }).catch(() => {}));
  r.faderVal = h('span', { class: 'small mono' });
  r.fadeSec = numInput(5, { onchange: () => { r.fadeTouched = true; } });   // startet mit der Standard-Fade-Zeit
  r.root = h('section', { class: `card stack player ${n === 2 ? 'p2' : ''}` },
    h('div', { class: 'row between' }, h('h2', {}, playerName(n)), h('div', { class: 'row', style: 'gap:8px' }, r.eq, r.status)),
    h('div', { class: 'dplayer-main' }, r.cov, h('div', { class: 'grow', style: 'min-width:0' }, r.title, r.artist)),
    r.prog, h('div', { class: 'row between tiny muted mono' }, r.pos, r.rem),
    h('div', { class: 'row between small' }, h('span', { class: 'muted' }, 'Pegel am Pult'), r.faderVal), r.meter, r.fader,
    h('div', { class: 'row' },
      h('button', { onclick: () => post('/control/play', { player: n }) }, 'Play'),
      h('button', { onclick: () => post('/control/pause', { player: n }) }, 'Pause'),
      h('button', { onclick: () => post('/control/fade-in', { player: n, sec: Number(r.fadeSec.value) }) }, 'Einblenden'),
      h('button', { onclick: () => post('/control/fade-out', { player: n, sec: Number(r.fadeSec.value) }) }, 'Ausblenden')),
    h('details', { class: 'more' }, h('summary', {}, 'Fade-Zeit & Lautstärke-Merker'),
      h('div', { class: 'stack', style: 'margin-top:10px' },
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Fade-Zeit'), r.fadeSec, h('span', { class: 'small muted' }, 's')), presetRow(r.fadeSec),
        feat('gainMemory') ? h('button', { title: 'Der nächste Start dieses Songs nutzt diese Lautstärke', onclick: () => safe(async () => { const o = await api('/control/gain-remember', { method: 'POST', body: { player: n } }); toast(`Lautstärke gemerkt (${Math.round(o.gain * 100)} %)`); })() }, 'Lautstärke für diesen Song merken') : null)));
  return r.root;
}
function updatePlayer(n) {
  const p = state.players[n], r = refs[`p${n}`];
  const onAir = state.current === n && p.playing;
  r.root.classList.toggle('onair', onAir);
  swap(r.cov, `${p.trackId}|${p.title}`, () => (p.title ? coverOnce(p.title, 'lg', p.trackId) : h('div', { class: 'cover lg', style: '--h:0;background:var(--bg-2);color:var(--faint)' }, '–')));
  r.title.textContent = p.title || 'Kein Song'; r.artist.textContent = p.artist || 'Bereit';
  r.status.textContent = p.fading ? 'Fade' : onAir ? 'ON AIR' : p.playing ? 'spielt' : p.muted ? 'gestoppt · Kanal stumm' : 'gestoppt';
  r.status.className = `badge ${onAir ? 'ink' : p.playing ? 'ok' : ''}`;
  r.eq.classList.toggle('off', !p.playing);
  const age = p.playing ? Date.now() - got : 0;
  r.pos.textContent = fmtTime(Math.min(p.durationMs, p.positionMs + age)); r.rem.textContent = `−${fmtTime(Math.max(0, p.remainingMs - age))}`;
  r.prog.firstChild.style.width = `${(p.durationMs ? Math.min(1, (p.positionMs + age) / p.durationMs) : 0) * 100}%`;
  r.meter.firstChild.style.width = `${Math.min(1, p.meter || 0) * 100}%`;
  r.faderVal.textContent = `Fader ${Math.round((p.gain ?? 1) * 100)} % · Ausgang ${Math.round((p.level ?? 1) * 100)} %`;
  if (document.activeElement !== r.fader) r.fader.value = Math.round((p.gain ?? 1) * 100);
}

// ---------- Uebergang ----------
function crossfadeCard() {
  refs.cfSec = numInput(8);
  refs.cfBar = bar(0); refs.cfInfo = h('div', { class: 'small muted' });
  refs.cfNext = h('div');
  refs.cfSeg = h('div', { class: 'seg' });
  refs.cfCount = h('div', { class: 'tcount' });
  refs.cfAi = h('div', { class: 'small muted' });
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h2', {}, 'Übergang'), refs.cfCount),
    refs.cfNext, refs.cfAi,
    h('button', { class: 'primary', style: 'height:56px;font-size:1.05rem', onclick: () => post('/control/crossfade', { sec: Number(refs.cfSec.value) }) }, '⇄  Crossfade zum nächsten Song'),
    h('div', { class: 'row between' }, h('span', { class: 'small muted' }, 'Dauer'), refs.cfSeg),
    refs.cfBar, refs.cfInfo);
}
function updateNext() {
  const n = state.upcoming[0];
  swap(refs.cfNext, n ? `${n.id}|${n.player}` : 'none', () => (n ? h('div', { class: 'q-row', style: 'padding:6px 0' }, coverOnce(n.title, 'sm', n.trackId),
    h('div', { class: 'grow' }, h('div', { class: 'eyebrow' }, 'Als Nächstes'), h('div', { class: 't' }, n.title), h('div', { class: 'a' }, n.artist)),
    n.introMs > 15000 ? h('span', { class: 'badge warn', title: 'Langes, oft leises Intro' }, `${Math.round(n.introMs / 1000)} s`) : null, h('span', { class: `badge p${n.player}` }, `P${n.player || '–'}`))
    : h('div', { class: 'small muted' }, 'Die Warteschlange ist leer – nimm zuerst Wünsche an.')));
  const key = JSON.stringify(state.settings.fadePresets) + refs.cfSec.value;
  if (refs.cfSeg.dataset.k !== key) {
    refs.cfSeg.dataset.k = key;
    clear(refs.cfSeg).append(...state.settings.fadePresets.map((p) => h('button', { class: Number(refs.cfSec.value) === p.sec ? 'on' : '', onclick: () => { refs.cfSec.value = p.sec; refs.cfSeg.dataset.k = ''; updateNext(); } }, `${p.name} · ${p.sec}s`)));
  }
}
// Countdown bis zum naechsten automatischen Uebergang (laeuft zwischen den Server-Staenden weiter)
function updateCountdown() {
  if (!state) return;
  const cf = state.crossfade, cfi = state.crossfadeIn;
  const to = cfi ? Math.max(0, cfi.inMs - (Date.now() - got)) : null;
  refs.cfCount.className = `tcount ${cf ? 'cf' : to != null && to < 15000 ? 'hot' : ''}`;
  refs.cfCount.textContent = cf ? `läuft ${Math.round(cf.progress * 100)} %` : to != null ? `Auto in ${mmss(to)}` : state.auto?.enabled ? 'Auto bereit' : 'manuell';
  refs.dockNext.textContent = state.upcoming[0] ? `Nächster: ${state.upcoming[0].title}${to != null && !cf ? ` · in ${mmss(to)}` : ''}` : 'Warteschlange leer';
  for (const n of [1, 2]) if (refs[`p${n}`] && state.players[n].playing) updatePlayer(n);
}

// ---------- Betrieb ----------
function operationsCard() {
  refs.wishBtns = ['open', 'paused', 'closed'].map((m) => {
    const b = h('button', { onclick: () => post('/control/wishmode', { mode: m }) }, { open: 'Offen', paused: 'Pausiert', closed: 'Geschlossen' }[m]);
    b.dataset.mode = m; return b;
  });
  refs.endBtn = h('button', { onclick: onEnd }, 'Ende-Modus');
  refs.emBtn = h('button', { class: 'outline-bad', onclick: onEmergency }, 'Notfall-Playlist');
  refs.openBtn = h('button', { class: 'primary hidden', onclick: () => post('/control/open-wishes') }, 'Wünsche jetzt freischalten');
  refs.startBtn = feat('startPlaylist') ? h('button', { class: 'hidden', onclick: () => post('/control/start-evening') }, 'Start-Playlist starten') : null;
  refs.pauseBtn = feat('pauseMode') ? h('button', { onclick: () => post('/control/pause-mode', { on: !state?.pauseMode }) }, 'Pausen-Modus') : null;
  const pq = h('input', { placeholder: 'Frage an die Gäste (z. B. Nächster Stil?)', maxlength: 120 });
  const pOpts = [h('input', { placeholder: 'Antwort 1', maxlength: 40 }), h('input', { placeholder: 'Antwort 2', maxlength: 40 }), h('input', { placeholder: 'Antwort 3 (optional)', maxlength: 40 })];
  refs.pollInfo = h('div', { class: 'small muted' });
  const pollCard = feat('polls') ? h('details', { class: 'more' }, h('summary', {}, 'Live-Umfrage'), h('div', { class: 'stack', style: 'margin-top:10px' }, pq, ...pOpts,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => safe(async () => { await api('/poll', { method: 'POST', body: { question: pq.value, options: pOpts.map((i) => i.value) } }); toast('Umfrage gestartet'); })() }, 'Starten'),
      h('button', { onclick: () => post('/poll/close') }, 'Beenden')), refs.pollInfo)) : null;
  return h('section', { class: 'card stack' },
    h('h2', {}, 'Betrieb'),
    h('div', { class: 'eyebrow' }, 'Wünsche der Gäste'), h('div', { class: 'seg', style: 'justify-self:start' }, ...refs.wishBtns),
    refs.openBtn, refs.startBtn,
    h('div', { class: 'grid two', style: 'gap:8px' }, refs.pauseBtn || h('span'), refs.endBtn, refs.emBtn),
    pollCard);
}

let panicTimer = null;
async function onPanic() {
  if (!refs.panicNonce) {
    const out = await api('/control/panic-arm', { method: 'POST', body: {} }).catch((e) => { toast(e.message, true); });
    if (!out) return;
    refs.panicNonce = out.nonce;
    refs.panic.textContent = 'NOCHMAL DRÜCKEN!'; refs.panic.classList.add('panic-armed');
    panicTimer = setTimeout(resetPanic, 4500);
    return;
  }
  const nonce = refs.panicNonce; resetPanic();
  await post('/control/panic', { nonce });
}
function resetPanic() { clearTimeout(panicTimer); refs.panicNonce = null; refs.panic.textContent = 'NOT-AUS'; refs.panic.classList.remove('panic-armed'); }
async function onEmergency() {
  if (state.emergency) { await post('/control/emergency-clear'); return; }
  if (!confirm('Notfall-Playlist starten? Alles andere wird gestoppt, die Notfall-Playlist läuft gemischt.')) return;
  await post('/control/emergency');
}
async function onEnd() {
  if (state.ended) { await post('/control/end-clear'); return; }
  if (!confirm('Ende-Modus starten? Musik wird ausgeblendet und Wünsche werden geschlossen.')) return;
  await post('/control/end', { sec: 10 });
}

// ---------- Wuensche ----------
function wishesCard() {
  refs.pendingBox = h('div'); refs.upBox = h('div'); refs.addSong = h('div');
  refs.assign = h('select', { onchange: (e) => { assignMode = e.target.value; } }, h('option', { value: 'auto' }, 'Auto-Zuweisung'), h('option', { value: '1' }, 'Player 1'), h('option', { value: '2' }, 'Player 2'));
  refs.pendingTitle = h('span', {}, 'Wünsche');
  return h('details', { class: 'card stack more', open: true }, h('summary', { style: 'cursor:pointer;font-weight:650' }, refs.pendingTitle),
    h('div', { class: 'grid two', style: 'margin-top:10px;align-items:start' },
      h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('h3', {}, 'Offen'), h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Zuweisung'), refs.assign)), refs.pendingBox),
      h('div', { class: 'stack' }, h('h3', {}, 'Warteschlange'), refs.addSong, refs.upBox)));
}

// ---------- Erweitert ----------
function advancedCard() {
  refs.autoSec = numInput(8, { onchange: (v) => post('/settings/tech', { auto: { crossfadeSec: v } }) });
  refs.fadeDef = numInput(5, { onchange: (v) => post('/settings/tech', { auto: { fadeSec: v } }) });
  refs.before1 = numInput(20, { min: 1, max: 180, step: 1, onchange: (v) => post('/settings/tech', { auto: { startBeforeEndSec: { 1: v } } }) });
  refs.before2 = numInput(20, { min: 1, max: 180, step: 1, onchange: (v) => post('/settings/tech', { auto: { startBeforeEndSec: { 2: v } } }) });
  refs.curve = h('select', { onchange: (e) => post('/settings/tech', { auto: { curve: e.target.value } }) }, h('option', { value: 'equalPower' }, 'Gleiche Lautheit (empfohlen)'), h('option', { value: 'linear' }, 'Linear'));
  refs.duckDb = numInput(-12, { min: -40, max: -1, step: 1, onchange: (v) => post('/settings/tech', { ducking: { db: v } }) });
  refs.micBox = h('div', { class: 'stack' });
  refs.noticeOn = h('input', { type: 'checkbox' });
  refs.noticeText = h('textarea', { rows: 2, maxlength: 400, placeholder: 'z. B. Macht Stimmung!' });
  refs.noticeSave = h('button', { class: 'small', onclick: () => post('/settings/tech', { notice: { enabled: refs.noticeOn.checked, text: refs.noticeText.value } }).then(() => toast('Hinweis gespeichert')) }, 'Hinweis speichern');
  refs.errors = h('div');
  return h('details', { class: 'card more' }, h('summary', {}, 'Erweitert: Automatik, Mics, Gäste-Hinweis, Fehler'),
    h('div', { class: 'grid two', style: 'margin-top:14px' },
      h('div', { class: 'stack' }, h('h3', {}, 'Auto-Crossfade'),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Dauer'), refs.autoSec, h('span', { class: 'small muted' }, 's')),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Standard-Fade-Zeit (Ein-/Ausblenden)'), refs.fadeDef, h('span', { class: 'small muted' }, 's')),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Start vor Songende: P1'), refs.before1, h('span', { class: 'small muted' }, 'P2'), refs.before2, h('span', { class: 'small muted' }, 's')),
        h('label', { class: 'field' }, 'Kurve', refs.curve),
        h('label', { class: 'field' }, 'Manuelle Crossfade-Dauer (s)', refs.cfSec)),
      h('div', { class: 'stack' }, h('h3', {}, 'Mikrofone & Ducking'),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Absenkung'), refs.duckDb, h('span', { class: 'small muted' }, 'dB')),
        refs.micBox),
      h('div', { class: 'stack' }, h('h3', {}, 'Hinweis für Gäste'), h('div', { class: 'small muted' }, 'Pop-up vor dem Wunsch'),
        refs.noticeText, h('div', { class: 'row' }, h('label', { class: 'check' }, refs.noticeOn, 'anzeigen'), refs.noticeSave)),
      h('div', { class: 'stack' }, h('h3', {}, 'Letzte Fehler'), refs.errors)));
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

function memoSet(box, key, build) {
  if (memo[box.dataset.m ||= String(Math.random())] === key || isPressing()) return;
  memo[box.dataset.m] = key; clear(box).append(build());
}

function render() {
  if (!state) return;
  refs.modeBanner.classList.toggle('hidden', state.mode !== 'wishlist');
  updateStrip(); updatePlayer(1); updatePlayer(2); fillPresets(); updateMics(); updateNext(); updateCountdown();
  const cf = state.crossfade;
  refs.cfBar.firstChild.style.width = `${(cf ? cf.progress : 0) * 100}%`;
  refs.cfInfo.textContent = cf ? `Crossfade läuft: Player ${cf.from} → Player ${cf.to}` : '';
  setVal(refs.autoSec, state.auto.crossfadeSec);
  setVal(refs.fadeDef, state.auto.fadeSec ?? 5);
  for (const n of [1, 2]) { const r = refs[`p${n}`]; if (r?.fadeSec && !r.fadeTouched) setVal(r.fadeSec, state.auto.fadeSec ?? 5); }
  const mx = state.mix, db = (v) => `${v < 0 ? '−' : '±'}${String(Math.abs(v)).replace('.', ',')} dB`;
  refs.cfAi.textContent = !mx ? '' : [
    mx.plan ? `KI-Übergang: ${String(mx.plan.durSec).replace('.', ',')} s, beginnt ${Math.round(mx.plan.leadMs / 1000)} s vor Ende – ${mx.plan.why}${state.auto.enabled ? '' : ' (Auto-Crossfade ist aus)'}` : (state.upcoming[0] ? 'KI-Übergang: Songs werden noch analysiert …' : ''),
    mx.nextTrimDb != null && mx.nextTrimDb < 0 ? `Pegel nächster Song: ${db(mx.nextTrimDb)} (KI)` : '',
  ].filter(Boolean).join(' · ');
  setVal(refs.before1, state.auto.startBeforeEndSec[1]); setVal(refs.before2, state.auto.startBeforeEndSec[2]); setVal(refs.curve, state.auto.curve);
  setVal(refs.duckDb, state.ducking.db);
  for (const b of refs.wishBtns) b.className = b.dataset.mode === state.wishMode ? 'on' : '';
  if (document.activeElement !== refs.noticeOn) refs.noticeOn.checked = !!state.notice.enabled;
  setVal(refs.noticeText, state.notice.text);
  refs.openBtn.classList.toggle('hidden', !state.opening?.awaiting);
  if (refs.startBtn) { refs.startBtn.classList.toggle('hidden', !state.hasStart || state.mode === 'wishlist'); refs.startBtn.textContent = state.opening?.started ? 'Start-Playlist auffüllen' : 'Start-Playlist starten'; }
  if (refs.pauseBtn) refs.pauseBtn.textContent = state.pauseMode ? 'Pause beenden' : 'Pausen-Modus';
  if (refs.pollInfo) refs.pollInfo.textContent = state.poll ? `${state.poll.question} – ${state.poll.options.map((o, i) => `${o}: ${state.poll.counts[i]}`).join(' · ')}${state.poll.status === 'open' ? '' : ' (beendet)'}` : 'Keine Umfrage aktiv.';
  refs.emBtn.textContent = state.emergency ? 'Notfall beenden' : 'Notfall-Playlist';
  refs.endBtn.textContent = state.ended ? 'Ende-Modus aufheben' : 'Ende-Modus';
  refs.panicClear.classList.toggle('hidden', !state.panic);
  refs.dock.classList.toggle('alarm', !!(state.panic || state.emergency));
  swap(refs.badges, JSON.stringify([state.panic, state.ended, state.emergency]), () => h('span', { class: 'row' },
    state.panic ? h('span', { class: 'badge bad' }, 'NOT-AUS') : null, state.ended ? h('span', { class: 'badge warn' }, 'ENDE') : null, state.emergency ? h('span', { class: 'badge bad' }, 'NOTFALL-PLAYLIST') : null));
  const ck = JSON.stringify(state.chat?.map((m) => m.id) || []);
  if (refs.chatKey !== ck) { refs.chatKey = ck; clear(refs.chatBox).append(chatPanel(state, { canWrite: true })); refs.chatSum.textContent = `Team-Chat (${state.chat?.length || 0})`; }
  swap(refs.errors, JSON.stringify(state.errors.map((e) => e.ts)), () => (state.errors.length ? h('div', {}, ...state.errors.map((e) => h('div', { class: 'tiny muted' }, `${new Date(e.ts).toLocaleTimeString('de-DE')} ${e.msg}`))) : h('div', { class: 'tiny muted' }, 'Keine Fehler.')));
  refs.pendingTitle.textContent = `Wünsche · ${state.pending.length} offen · ${state.upcomingTotal} in der Warteschlange`;
  memoSet(refs.pendingBox, JSON.stringify(state.pending.map((p) => [p.id, p.votes])), () => pendingList(state, { canAct: true, assign: () => assignMode }));
  if (state.role === 'admin' && !refs.addSong.firstChild) refs.addSong.append(addSongBox());
  memoSet(refs.upBox, JSON.stringify(state.upcoming.map((u) => [u.id, u.player, u.prioritized])), () => upcomingList(state, { canAct: true }));
}

// ---------- Aufbau ----------
refs.modeBanner = h('div', { class: 'card hidden', style: 'background:var(--warn-bg);border-color:transparent' }, h('b', {}, 'Wunschlisten-Modus: '), 'Die App spielt keine Musik ab und steuert das Pult nicht – der DJ spielt selbst. Fader, Crossfade und Player sind gesperrt. Umschalten: Admin → Start.');
refs.badges = h('span', { class: 'row' });
refs.chatBox = h('div', { style: 'margin-top:12px' }); refs.chatSum = h('summary', {}, 'Team-Chat');
const showLevels = (opts) => openLevels(opts).catch((e) => toast(e.message, true));
refs.levelsBtn = h('button', { class: 'small', title: 'Fader und Lautstärken einstellen', onclick: () => showLevels() }, 'Pegel');
// Einmal pro Abend (bzw. alle 10 Stunden) beim Oeffnen der Technik nach den Grundpegeln fragen
let levelsAsked = false;
function maybeAskLevels() {
  if (levelsAsked || !state?.levels || state.mode === 'wishlist') return;
  levelsAsked = true;
  try { if (sessionStorage.getItem('levelsAsked')) return; sessionStorage.setItem('levelsAsked', '1'); } catch { /* ohne Speicher: trotzdem fragen */ }
  if (state.levels.confirmedAt && Date.now() - state.levels.confirmedAt < 10 * 3600e3) return;
  showLevels({ later: true, intro: 'Bevor es losgeht: einmal Fader und Lautstärken einstellen. Jede Änderung gilt sofort – starte Testmusik und hör direkt, wie es klingt. Später findest du das Fenster oben unter „Pegel“.' });
}
// Immer erreichbar: Crossfade und Not-Aus (auch beim Scrollen durch die Wuensche)
refs.panic = h('button', { class: 'bad', onclick: onPanic }, 'NOT-AUS');
refs.panicClear = h('button', { class: 'hidden', onclick: () => post('/control/panic-clear') }, 'Not-Aus aufheben');
refs.dockNext = h('div', { class: 'small grow', style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' });
const chatCard = h('details', { class: 'card more' }, refs.chatSum, refs.chatBox);
const aiSlot = h('div');
const main = h('div', { class: 'wrap stack tech' }, statusStrip(), refs.modeBanner,
  h('div', { class: 'grid two' }, playerCard(1), playerCard(2)),
  h('div', { class: 'grid two' }, crossfadeCard(), operationsCard()),
  aiSlot, wishesCard(), chatCard, advancedCard());
refs.dock = h('div', { class: 'tdock' }, refs.dockNext,
  h('button', { class: 'primary', onclick: () => post('/control/crossfade', { sec: Number(refs.cfSec.value) }) }, '⇄ Crossfade'), refs.panicClear, refs.panic);
app.append((refs.top = topbar('Technik · FOH', { nav: true, right: [refs.badges, refs.levelsBtn] })), main, refs.dock);
aiCard().then((c) => { if (c) aiSlot.replaceWith(c); }).catch(() => {});
onRelease(() => { if (state) render(); });
connect({ ping: true, onStatus: (ok) => refs.top.setLive(ok), onState: (s) => { state = s; got = Date.now(); render(); maybeAskLevels(); } });
api('/state').then((s) => { if (!state) { state = s; got = Date.now(); render(); } }).catch(() => {});
setInterval(updateCountdown, 500);
