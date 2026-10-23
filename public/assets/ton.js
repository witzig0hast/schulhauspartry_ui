import { h, connect, clear, coverOnce, BRAND, $ } from '/assets/app.js';
import { ampel } from '/assets/staff-ui.js';
import { deptBar } from '/assets/dept.js';
import { aiStatus, openHelpModal } from '/assets/ai-ui.js';

// Dashboard Ton (nur lesen): beide Player mit Pegel und Fader, Uebergang-Countdown, Mikrofone & Ducking,
// die naechsten Songs mit Hinweisen (leises Intro, Explicit), Verbindungen und Fehler.
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }
const app = $('#app');
let state = null, got = 0;
const pad = (n) => String(n).padStart(2, '0');
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const dB = (amp) => (amp > 0.0001 ? `${(20 * Math.log10(amp)).toFixed(1).replace('.', ',').replace('-', '−')} dB` : '−∞ dB');
const hhmmss = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const width = (el, v) => { el.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, v || 0)) * 100)}%`; };
const swap = (slot, key, build) => { if (slot.dataset.k === key) return; slot.dataset.k = key; clear(slot).append(build()); };
const meterBar = (cls = '') => h('div', { class: `bar meter ${cls}` }, h('i'));

function playerCard(n) {
  const r = {};
  r.root = h('section', { class: 'dcard dplayer' },
    h('div', { class: 'row between' }, h('span', { class: 'eyebrow' }, `Player ${n}`), r.badge = h('span', { class: 'badge' })),
    h('div', { class: 'dplayer-main' }, r.cov = h('div'), h('div', { class: 'grow', style: 'min-width:0' }, r.t = h('div', { class: 'dt' }), r.a = h('div', { class: 'da' }))),
    r.prog = h('div', { class: `bar p${n}` }, h('i')), r.time = h('div', { class: 'row between small mono muted' }),
    h('div', { class: 'row between small', style: 'margin-top:6px' }, h('span', { class: 'muted' }, 'Pegel am Pult'), r.fader = h('span', { class: 'mono' })),
    r.meter = meterBar('dmeter'), r.extra = h('div', { class: 'row small muted' }));
  return {
    el: r.root,
    update(s, age) {
      const p = s.players[n];
      const onAir = s.current === n && p.playing;
      r.root.classList.toggle('onair', onAir);
      r.badge.textContent = p.fading ? 'blendet' : onAir ? 'ON AIR' : p.playing ? 'spielt' : 'gestoppt';
      r.badge.className = `badge ${onAir ? 'ink' : p.fading ? 'warn' : p.playing ? 'ok' : ''}`;
      swap(r.cov, `${p.trackId}|${p.title}`, () => (p.title ? coverOnce(p.title, 'lg', p.trackId) : h('div', { class: 'cover lg', style: '--h:0;background:var(--bg-2);color:var(--faint)' }, '–')));
      r.t.textContent = p.title || 'Kein Song'; r.a.textContent = p.artist || 'Bereit';
      const left = p.playing ? Math.max(0, p.remainingMs - age) : p.remainingMs;
      width(r.prog, p.durationMs ? 1 - left / p.durationMs : 0);
      r.time.replaceChildren(h('span', {}, mmss((p.durationMs || 0) - left)), h('span', {}, `−${mmss(left)}`));
      r.fader.textContent = p.level != null ? `Fader ${Math.round(p.level * 100)} % · ${dB(p.level)}` : '';
      width(r.meter, p.meter);
      r.extra.replaceChildren(...[
        s.levels ? h('span', {}, `Grundpegel ${String(s.levels.playerDb[n]).replace('.', ',')} dB`) : null,
        s.levels ? h('span', {}, `Spotify ${s.levels.spotifyVol[n]} %`) : null,
        s.maxGain != null && s.maxGain < 1 ? h('span', {}, `Obergrenze ${Math.round(s.maxGain * 100)} %`) : null,
      ].filter(Boolean));
    },
  };
}

const alerts = h('div', { class: 'row' });
const clock = h('div', { class: 'lt-clock mono' });
const live = h('span', { class: 'pill off' }, h('i', { class: 'dot' }), 'Verbinde …');
const deptSlot = h('div');
const players = [playerCard(1), playerCard(2)];
const cfBox = h('div', { class: 'stack' });
const micBox = h('div', { class: 'stack' });
const nextBox = h('div');
const statusBox = h('div', { class: 'stack' });

function render() {
  if (!state) return;
  const s = state, age = Date.now() - got;
  swap(deptSlot, s.role, () => deptBar('ton', s.role));
  clock.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  // Warnungen ganz oben
  const a = [];
  if (s.panic) a.push(['bad', 'NOT-AUS']);
  if (s.emergency) a.push(['bad', 'Notfall-Playlist']);
  if (s.ended) a.push(['warn', 'Ende-Modus']);
  if (s.pauseMode) a.push(['warn', 'Pause']);
  if (s.ducking?.active) a.push(['warn', `Ducking aktiv (${Math.round((s.ducking.mul ?? 1) * 100)} %)`]);
  if (s.mode === 'wishlist') a.push(['', 'Wunschlisten-Modus: die App spielt nicht']);
  swap(alerts, JSON.stringify(a), () => h('div', { class: 'row' }, ...a.map(([c, t]) => h('span', { class: `badge big ${c}` }, t))));
  for (const p of players) p.update(s, age);

  // Uebergang
  const cf = s.crossfade, cfi = s.crossfadeIn;
  const toCf = cfi ? Math.max(0, cfi.inMs - age) : null;
  clear(cfBox).append(cf
    ? h('div', { class: 'lt-cd cf' }, h('div', { class: 'lt-cd-l' }, 'Crossfade läuft'), h('div', { class: 'lt-cd-v' }, `${Math.round(cf.progress * 100)} %`), h('div', { class: 'lt-cd-s' }, `Player ${cf.from} → ${cf.to} · ${Math.round(cf.durSec)} s`))
    : toCf != null ? h('div', { class: `lt-cd ${toCf < 10000 ? 'hot' : ''}` }, h('div', { class: 'lt-cd-l' }, cfi.braked ? 'Song-Bremse' : 'Nächster Übergang in'), h('div', { class: 'lt-cd-v mono' }, mmss(toCf)), h('div', { class: 'lt-cd-s' }, `ca. ${hhmmss(Date.now() + toCf)} · ${String(cfi.crossfadeSec).replace('.', ',')} s Überblendung`))
      : h('div', { class: 'lt-cd' }, h('div', { class: 'lt-cd-l' }, 'Übergang'), h('div', { class: 'lt-cd-v small' }, s.auto?.enabled ? '–' : 'manuell'), h('div', { class: 'lt-cd-s' }, s.auto?.enabled ? 'wartet auf den nächsten Song' : 'Auto-Crossfade ist aus')),
  h('div', { class: 'row small muted' }, h('span', {}, `Auto-Crossfade ${s.auto?.enabled ? 'an' : 'aus'}`), s.auto ? h('span', {}, `Kurve ${s.auto.curve === 'linear' ? 'linear' : 'Equal Power'}`) : null));

  // Mikrofone & Ducking
  const mics = s.mics || [];
  swap(micBox, mics.length ? String(mics.length) : 'none', () => (!mics.length ? h('div', { class: 'muted small' }, 'Keine Mikrofon-Daten.') : h('div', { class: 'stack' }, ...mics.map((m, i) => h('div', { class: 'stack', style: 'gap:4px', 'data-mic': i },
    h('div', { class: 'row between' }, h('strong', {}, m.name), h('span', { class: 'badge' })), meterBar())))));
  micBox.querySelectorAll('[data-mic]').forEach((row) => {
    const m = mics[Number(row.dataset.mic)]; if (!m) return;
    const b = row.querySelector('.badge'); b.textContent = m.open ? 'offen' : 'stumm'; b.className = `badge ${m.open ? 'ok' : ''}`;
    width(row.querySelector('.bar'), m.level);
  });
  duck.textContent = s.ducking ? (s.ducking.enabled ? `Ducking an: ${String(s.ducking.db).replace('-', '−')} dB beim Sprechen` : 'Ducking aus') : '';

  // Naechste Songs
  const up = (s.upcoming || []).slice(0, 5);
  swap(nextBox, JSON.stringify(up.map((u) => [u.id, u.player, Math.round((u.etaMs ?? -1) / 5000)])), () => (up.length ? h('div', {}, ...up.map((u, i) => {
    const eta = u.etaMs != null ? Math.max(0, u.etaMs - age) : null;
    return h('div', { class: 'q-row' }, coverOnce(u.title, 'sm', u.trackId),
      h('div', { class: 'grow' }, h('div', { class: 't' }, u.title), h('div', { class: 'a' }, u.artist),
        h('div', { class: 'row small', style: 'gap:6px;margin-top:4px' },
          u.introMs > 15000 ? h('span', { class: 'badge warn', title: 'Langes, oft leises Intro – nicht zu früh hochziehen' }, `Intro ${Math.round(u.introMs / 1000)} s`) : null,
          u.explicit ? h('span', { class: 'badge warn' }, 'Explicit') : null,
          u.durationMs ? h('span', { class: 'muted' }, `Länge ${mmss(u.durationMs)}`) : null)),
      h('div', { style: 'text-align:right' }, h('span', { class: `badge p${u.player}` }, `P${u.player || '–'}`), h('div', { class: 'tiny muted mono' }, eta != null ? `in ${mmss(eta)}` : i === 0 ? 'als Nächstes' : `+${i}`)));
  })) : h('div', { class: 'muted small' }, 'Warteschlange leer.')));

  // Verbindungen & Fehler
  swap(statusBox, JSON.stringify([s.connections && Object.values(s.connections).map((c) => c?.ok), (s.errors || []).map((e) => e.ts)]), () => h('div', { class: 'stack' },
    s.connections ? ampel(s.connections) : h('div', { class: 'muted small' }, 'Keine Verbindungsdaten für diese Rolle.'),
    ...(s.errors || []).slice(0, 4).map((e) => h('div', { class: 'tiny muted' }, `${new Date(e.ts).toLocaleTimeString('de-DE')} ${e.msg}`))));
}

const duck = h('div', { class: 'small muted' });
const helpSlot = h('span');
app.append(h('div', { class: 'dash' },
  h('div', { class: 'row between' }, h('div', { class: 'row' }, h('span', { class: 'eyebrow' }, `${BRAND.name} · Ton`), deptSlot), h('div', { class: 'row' }, live, clock)),
  alerts,
  h('div', { class: 'dgrid two' }, players[0].el, players[1].el),
  h('div', { class: 'dgrid three' },
    h('section', { class: 'dcard' }, h('h2', {}, 'Übergang'), cfBox),
    h('section', { class: 'dcard' }, h('h2', {}, 'Mikrofone'), micBox, duck),
    h('section', { class: 'dcard' }, h('div', { class: 'row between' }, h('h2', {}, 'Verbindungen'), helpSlot), statusBox)),
  h('section', { class: 'dcard' }, h('h2', {}, 'Als Nächstes'), nextBox)));
connect({
  ping: true,
  onStatus: (ok) => { live.className = `pill ${ok ? 'live' : 'off'}`; live.lastChild.textContent = ok ? 'Live' : 'Getrennt'; },
  onState: (s) => { state = s; got = Date.now(); render(); },
});
setInterval(render, 500);   // Countdowns laufen zwischen den Server-Staenden weiter
// Fehler-Assistent fuer Technik/Admin (der Server prueft die Rolle)
aiStatus().then((s) => { if (s?.ready && s.features.help) helpSlot.replaceWith(h('button', { class: 'small', onclick: openHelpModal }, 'Was ist los?')); });
