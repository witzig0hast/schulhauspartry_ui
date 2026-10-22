import { h, api, clear, modal, toast, BASE } from '/assets/app.js';
import { autoHelp } from '/assets/help.js';

// Pegel-Fenster: zuerst Fader und Lautstaerken einstellen. Jede Aenderung geht sofort ans Pult bzw. an Spotify,
// damit man direkt hoert, wie es klingt. "Abbrechen" stellt die Werte von vorher wieder her.
//   openLevels({ base, later }) -> Promise<'confirmed' | 'cancelled' | 'later'>

// gleiche Umrechnung wie im Server (Amplitude -> X32-Fader, 0.75 = 0 dB)
function ampToFader(amp) {
  const db = amp <= 0.00003 ? -90 : 20 * Math.log10(amp);
  const f = db < -60 ? (db + 90) / 480 : db < -30 ? (db + 70) / 160 : db < -10 ? (db + 50) / 80 : (db + 30) / 40;
  return Math.max(0, Math.min(1, f));
}
const dbText = (db) => `${db > 0 ? '+' : db < 0 ? '−' : '±'}${Math.abs(db).toFixed(1).replace('.', ',')} dB`;
const faderPct = (db) => Math.round(ampToFader(Math.pow(10, db / 20)) * 100);
const HELP = {
  'Player-Fader am X32 (Stellung bei voller Lautstärke)': 'So weit steht der Fader des Players am Pult, wenn die App „volle Lautstärke“ spielt. Fades, Crossfades und Ducking rechnen von hier aus nach unten. 0 dB = Fader auf der 0-Markierung.',
  'Spotify-Lautstärke (am Wiedergabegerät)': 'Lautstärke von Spotify selbst auf dem Rechner/Streamer. Am besten hoch lassen (90–100 %) und mit dem Fader einpegeln – so bleibt das Signal sauber.',
  'Mikrofone': 'Zeigt, ob die App jedes Mikrofon hört. Mit dem Haken setzt die App auch die Mic-Fader am Pult – sonst stellst du sie wie gewohnt am X32.',
  'Mic-Fader von der App setzen': 'An: die Werte unten gehen an die Mic-Kanäle am X32. Aus: die App fasst die Mic-Fader nicht an.',
  'Sicherheit & Übergänge': 'Gilt sofort für den ganzen Abend.',
  'Fader-Obergrenze': 'Bezogen auf den Grundpegel oben: höher geht ein Player nie – auch nicht mit dem Lautstärke-Merker. Schützt Anlage und Ohren.',
  'Ducking (Musik leiser beim Sprechen)': 'So weit wird die Musik abgesenkt, solange ein Mikrofon offen ist und spricht.',
  'Crossfade-Dauer': 'Länge des automatischen Übergangs zwischen zwei Songs.',
};
const chText = (list) => (list?.length ? `Kanal ${list.join('/')}` : 'kein Kanal');

function meterBar() { const i = h('i'); const el = h('div', { class: 'bar meter' }, i); el.set = (v) => { i.style.width = `${Math.round(Math.max(0, Math.min(1, v || 0)) * 100)}%`; }; return el; }

export async function openLevels({ base = BASE, later = false, intro } = {}) {
  let st = await api('/state', { base });
  if (!st.levels) throw new Error('Keine Berechtigung für das Pegel-Fenster.');
  const orig = { levels: structuredClone(st.levels), maxGain: st.maxGain, duckDb: st.ducking?.db, crossfadeSec: st.auto?.crossfadeSec };
  const cur = structuredClone(orig);
  const openedAt = Date.now();
  const post = (body) => api('/control/levels', { method: 'POST', body, base });

  // Schieberegler senden gedrosselt (Pult) bzw. erst beim Loslassen (Spotify spart Anfragen)
  let timer = null, pendingBody = null;
  const send = (body, now = false) => {
    pendingBody = { ...(pendingBody || {}), ...body, levels: { ...(pendingBody?.levels || {}), ...(body.levels || {}) } };
    clearTimeout(timer);
    const go = () => { const b = pendingBody; pendingBody = null; post(b).catch((e) => toast(e.message, true)); };
    if (now) go(); else timer = setTimeout(go, 160);
  };

  const slider = ({ min, max, step, value, label, fmt, onInput, onChange, aria }) => {
    const out = h('span', { class: 'lv-val' }, fmt(value));
    const input = h('input', { type: 'range', min, max, step, value, 'aria-label': aria || label });
    input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); onInput?.(Number(input.value)); });
    input.addEventListener('change', () => onChange?.(Number(input.value)));
    return { input, out, row: (extra) => h('div', { class: 'lv-row' }, h('div', { class: 'lv-l help-host' }, label), input, out, extra || h('span')) };
  };

  // --- Testmusik ---
  const testInfo = h('span', { class: 'small muted' }, '');
  const testBtn = (n) => h('button', { class: 'small', onclick: async () => {
    try { const t = await api('/control/level-test', { method: 'POST', body: { player: n }, base }); testInfo.textContent = `Player ${n} spielt: ${t.title} – ${t.artist}`; }
    catch (e) { toast(e.message, true); }
  } }, `▶ Testmusik Player ${n}`);
  const stopBtn = h('button', { class: 'small', onclick: async () => { await api('/control/level-test', { method: 'POST', body: { stop: true }, base }).catch(() => {}); testInfo.textContent = ''; } }, '■ Stopp');

  // --- Player-Fader am X32 ---
  const meters = { 1: meterBar(), 2: meterBar() };
  const pFader = [1, 2].map((n) => slider({ min: -40, max: 6, step: 0.5, value: cur.levels.playerDb[n], label: `Player ${n} · ${chText(st.channels?.[`p${n}`])}`,
    fmt: (v) => `${dbText(v)} · Fader ${faderPct(v)} %`, onInput: (v) => { cur.levels.playerDb[n] = v; send({ levels: { playerDb: { [n]: v } } }); } }));
  // --- Spotify-Lautstaerke ---
  const pVol = [1, 2].map((n) => slider({ min: 0, max: 100, step: 1, value: cur.levels.spotifyVol[n], label: `Player ${n}`,
    fmt: (v) => `${v} %`, onChange: (v) => { cur.levels.spotifyVol[n] = v; send({ levels: { spotifyVol: { [n]: v } } }, true); } }));
  // --- Mikrofone ---
  const micOn = h('input', { type: 'checkbox', checked: !!cur.levels.micControl });
  const micMeters = [0, 1, 2].map(() => meterBar());
  const micBadges = [0, 1, 2].map(() => h('span', { class: 'badge' }, 'stumm'));
  const micCh = st.channels?.mics || [];
  const mFader = micCh.map((ch, i) => slider({ min: -60, max: 10, step: 0.5, value: cur.levels.micDb[i] ?? 0, label: `${st.channels?.names?.[i] || `Mic ${i + 1}`} · Kanal ${ch}`,
    fmt: (v) => `${dbText(v)} · Fader ${faderPct(v)} %`, onInput: (v) => { cur.levels.micDb[i] = v; if (micOn.checked) send({ levels: { micDb: cur.levels.micDb } }); } }));
  const micBox = h('div', { class: 'stack', style: 'gap:6px' });
  const drawMics = () => {
    for (const f of mFader) f.input.disabled = !micOn.checked;
    clear(micBox).append(...mFader.map((f, i) => h('div', { class: 'stack', style: 'gap:2px' }, f.row(micBadges[i]), micMeters[i])));
  };
  micOn.addEventListener('change', () => { cur.levels.micControl = micOn.checked; drawMics(); send({ levels: { micControl: micOn.checked, micDb: cur.levels.micDb } }, true); });
  drawMics();
  // --- Sicherheit & Uebergaenge ---
  const maxGain = slider({ min: 30, max: 100, step: 1, value: Math.round((cur.maxGain ?? 1) * 100), label: 'Fader-Obergrenze', fmt: (v) => `${v} %`, onInput: (v) => { cur.maxGain = v / 100; send({ maxGain: v / 100 }); } });
  const duck = slider({ min: -40, max: -1, step: 1, value: cur.duckDb ?? -12, label: 'Ducking (Musik leiser beim Sprechen)', fmt: (v) => dbText(v), onChange: (v) => { cur.duckDb = v; send({ duckDb: v }, true); } });
  const xfade = slider({ min: 1, max: 30, step: 0.5, value: cur.crossfadeSec ?? 8, label: 'Crossfade-Dauer', fmt: (v) => `${String(v).replace('.', ',')} s`, onChange: (v) => { cur.crossfadeSec = v; send({ crossfadeSec: v }, true); } });

  const errBox = h('div', { class: 'small', style: 'color:var(--bad)' });
  const levelNow = { 1: h('span', { class: 'tiny muted' }), 2: h('span', { class: 'tiny muted' }) };

  return new Promise((resolve) => {
    let done = false;
    const finish = async (how) => {
      if (done) return; done = true;
      clearInterval(poll); clearTimeout(timer);
      if (pendingBody) await post(pendingBody).catch(() => {});
      if (how === 'cancelled') await post({ levels: orig.levels, maxGain: orig.maxGain, duckDb: orig.duckDb, crossfadeSec: orig.crossfadeSec }).catch((e) => toast(e.message, true));
      if (how === 'confirmed') await post({ levels: { confirm: true } }).then(() => toast('Pegel übernommen')).catch((e) => toast(e.message, true));
      await api('/control/level-test', { method: 'POST', body: { stop: true }, base }).catch(() => {});
      close();
      resolve(how);
    };
    const close = modal([
      h('h2', {}, '🎚 Pegel einrichten'),
      h('p', { class: 'small muted' }, intro || 'Stell zuerst Fader und Lautstärken ein. Jede Änderung geht sofort ans Pult und an Spotify – starte Testmusik und hör direkt, wie es klingt.'),
      st.mode === 'wishlist' ? h('p', { class: 'small', style: 'color:var(--warn)' }, 'Wunschlisten-Modus: Die App spielt keine Musik, Testmusik ist aus.') : null,
      h('div', { class: 'row', style: 'flex-wrap:wrap' }, testBtn(1), testBtn(2), stopBtn, testInfo),
      h('div', { class: 'eyebrow help-host' }, 'Player-Fader am X32 (Stellung bei voller Lautstärke)'),
      ...[1, 2].map((n) => h('div', { class: 'stack', style: 'gap:2px' }, pFader[n - 1].row(levelNow[n]), meters[n])),
      h('div', { class: 'eyebrow help-host' }, 'Spotify-Lautstärke (am Wiedergabegerät)'),
      ...pVol.map((v) => v.row()),
      h('div', { class: 'eyebrow help-host' }, 'Mikrofone'),
      micCh.length ? h('label', { class: 'check' }, micOn, 'Mic-Fader von der App setzen') : h('p', { class: 'small muted' }, 'Keine Mikrofon-Kanäle eingetragen (Admin → Verbindungen).'),
      micBox,
      h('div', { class: 'eyebrow help-host' }, 'Sicherheit & Übergänge'),
      maxGain.row(), duck.row(), xfade.row(),
      errBox,
      h('div', { class: 'row between', style: 'flex-wrap:wrap' },
        h('div', { class: 'row' }, h('button', { onclick: () => finish('cancelled') }, 'Abbrechen'), later ? h('button', { onclick: () => finish('later') }, 'Später') : null),
        h('button', { class: 'primary', onclick: () => finish('confirmed') }, '✓ Übernehmen & fertig')),
    ], { wide: true, sticky: true });
    autoHelp([...document.querySelectorAll('.modal.wide')].pop(), HELP);

    // Live-Anzeige: Pegel, Mics und Fehler (z. B. Gerät erlaubt keine Lautstaerke-Steuerung)
    const poll = setInterval(async () => {
      try { st = await api('/state', { base }); } catch { return; }
      for (const n of [1, 2]) { meters[n].set(st.players?.[n]?.meter); levelNow[n].textContent = st.players?.[n]?.playing ? `spielt · Pegel ${Math.round((st.players[n].level || 0) * 100)} %` : ''; }
      (st.mics || []).forEach((m, i) => { micMeters[i]?.set(m.level); if (micBadges[i]) { micBadges[i].textContent = m.open ? 'offen' : 'stumm'; micBadges[i].className = `badge ${m.open ? 'ok' : ''}`; } });
      const err = (st.errors || []).find((e) => e.ts >= openedAt && /lautstaerke|mic-fader|x32/.test(e.msg));
      errBox.textContent = err ? `⚠ ${err.msg.replace(/^[\w-]+: /, '')}` : '';
      if (!st.levelTest && testInfo.textContent) testInfo.textContent = '';
    }, 500);
  });
}
