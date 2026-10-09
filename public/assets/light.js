import { h, connect, clear, fmtTime, BRAND, $ } from '/assets/app.js';
import { animOn } from '/assets/motion.js';

// Licht-Ansicht (nur lesen): aktueller Song, Countdown bis zum Uebergang, die naechsten Songs mit Genre und Zeiten.
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }
const app = $('#app');
let state = null, got = 0, lastCur = '';
const clock = h('div', { class: 'lt-clock mono' });
const nowBox = h('div', { class: 'lt-now' });
const nextBox = h('div', { class: 'lt-next' });
const live = h('span', { class: 'pill off' }, h('i', { class: 'dot' }), 'Verbinde …');
const pad = (n) => String(n).padStart(2, '0');
const hhmmss = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const chips = (genres, families) => h('div', { class: 'lt-chips' },
  ...(families || []).map((f) => h('span', { class: `lt-fam ${f === 'Unbekannt' ? 'unk' : ''}` }, f)),
  ...((genres || []).slice(0, 4).map((g) => h('span', { class: 'lt-gen' }, g))));

// Details zum laufenden Song: passender Eintrag aus den zuletzt gespielten (Titel + Interpret)
const cur0 = (st) => {
  const c = [1, 2].map((n) => ({ n, p: st.players[n] })).find((x) => x.p.playing && x.n === st.current) || [1, 2].map((n) => ({ n, p: st.players[n] })).find((x) => x.p.playing);
  return c ? (st.playedNow || []).find((r) => r.title === c.p.title && r.artist === c.p.artist) || null : null;
};

function render() {
  if (!state) return;
  const age = Date.now() - got;                         // seit dem letzten Stand vergangene Zeit (fuer weiches Zaehlen)
  const cur = [1, 2].map((n) => ({ n, p: state.players[n] })).find((x) => x.p.playing && x.n === state.current) || [1, 2].map((n) => ({ n, p: state.players[n] })).find((x) => x.p.playing);
  const nowReq = cur0(state);
  const queue = state.upcoming || [];
  const cf = state.crossfade;
  const cfi = state.crossfadeIn;
  const left = cur ? Math.max(0, cur.p.remainingMs - age) : 0;
  const toCf = cfi ? Math.max(0, cfi.inMs - age) : null;
  const next = queue[0];

  // --- aktueller Song ---
  const curKey = cur ? `${cur.p.title}|${cur.p.artist}` : '';
  const changed = curKey !== lastCur; lastCur = curKey;
  const hot = !cf && toCf != null && toCf < 10000;
  const countdown = cf ? h('div', { class: 'lt-cd cf' }, h('div', { class: 'lt-cd-l' }, 'Übergang läuft'), h('div', { class: 'lt-cd-v' }, `${Math.round(cf.progress * 100)} %`), h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(cf.progress * 100)}%` })),
      h('div', { class: 'lt-cd-s' }, `Player ${cf.from} → Player ${cf.to} · ${Math.round(cf.durSec)} s`))
    : toCf != null ? h('div', { class: `lt-cd ${hot ? 'hot' : ''}` }, h('div', { class: 'lt-cd-l' }, cfi.braked ? 'Song-Bremse – Übergang jetzt' : 'Übergang in'), h('div', { class: 'lt-cd-v mono' }, mmss(toCf)),
      h('div', { class: 'lt-cd-s' }, `ca. ${hhmmss(Date.now() + toCf)} · dann ${Math.round(cfi.crossfadeSec)} s Überblendung`))
    : h('div', { class: 'lt-cd' }, h('div', { class: 'lt-cd-l' }, 'Übergang'), h('div', { class: 'lt-cd-v small' }, state.auto?.enabled ? '–' : 'manuell'), h('div', { class: 'lt-cd-s' }, state.auto?.enabled ? 'wartet auf Song' : 'Auto-Crossfade ist aus – die Technik entscheidet'));
  const meta = nowReq;
  clear(nowBox).append(cur ? h('div', { class: `lt-hero ${changed && animOn() ? 'pop-in' : ''}` },
    h('div', { class: 'lt-main' },
      h('div', { class: 'eyebrow' }, `Jetzt läuft · Player ${cur.n}${meta?.auto ? ' · Auto-Lückenfüller' : meta ? ' · Gästewunsch' : ''}`),
      h('div', { class: 'lt-title' }, cur.p.title), h('div', { class: 'lt-artist' }, cur.p.artist),
      meta ? chips(meta.genres, meta.families) : null,
      h('div', { class: 'lt-facts' }, meta?.year ? h('span', {}, `${meta.year}`) : null, h('span', {}, `Länge ${mmss(cur.p.durationMs)}`), h('span', {}, `noch ${mmss(left)}`), meta?.explicit ? h('span', { class: 'badge warn' }, 'Explicit') : null),
      h('div', { class: 'bar lt-bar' }, h('i', { style: `width:${Math.round(100 * (cur.p.durationMs ? 1 - left / cur.p.durationMs : 0))}%` }))),
    countdown) : h('div', { class: 'lt-hero idle' }, h('div', { class: 'lt-title' }, state.pauseMode ? '⏸ Pause' : 'Gerade läuft nichts'), h('div', { class: 'lt-artist' }, next ? `Als Nächstes: ${next.title}` : 'Warteschlange leer')));

  // --- naechste Songs ---
  const micOpen = (state.mics || []).filter((m) => m.open);
  const prevFam = (i) => (i === 0 ? (meta?.families || [])[0] : queue[i - 1].families?.[0]);
  clear(nextBox).append(
    h('div', { class: 'row between' }, h('div', { class: 'eyebrow' }, `Als Nächstes · ${state.upcomingTotal}`), micOpen.length ? h('span', { class: 'badge warn' }, `🎤 ${micOpen.map((m) => m.name).join(', ')} offen`) : null),
    ...(queue.length ? queue.slice(0, 6).map((u, i) => {
      const fam = u.families?.[0], was = prevFam(i);
      const change = fam && was && fam !== was && fam !== 'Unbekannt' && was !== 'Unbekannt';
      const eta = u.etaMs != null ? Math.max(0, u.etaMs - age) : null;
      return h('div', { class: `lt-row ${i === 0 ? 'first' : ''}` },
        h('div', { class: 'lt-time' }, eta != null ? h('div', { class: 'lt-eta mono' }, `in ${mmss(eta)}`) : h('div', { class: 'lt-eta muted' }, i === 0 ? 'als Nächstes' : `+${i}`), eta != null ? h('div', { class: 'tiny muted mono' }, hhmmss(Date.now() + eta)) : null),
        h('div', { class: 'grow' },
          h('div', { class: 'lt-t' }, u.title), h('div', { class: 'lt-a' }, u.artist), chips(u.genres, u.families),
          h('div', { class: 'lt-facts' }, u.year ? h('span', {}, `${u.year}`) : null, u.durationMs ? h('span', {}, `Länge ${mmss(u.durationMs)}`) : null,
            u.introMs > 15000 ? h('span', { class: 'badge', title: 'Langes ruhiges Intro' }, `♪ Intro ${Math.round(u.introMs / 1000)} s`) : null,
            u.prioritized ? h('span', { class: 'badge bad' }, '★ Prio') : null, u.auto ? h('span', { class: 'badge' }, 'Auto') : h('span', { class: 'badge ok' }, `Wunsch${u.votes > 1 ? ` · ${u.votes}×` : ''}`),
            u.explicit ? h('span', { class: 'badge warn' }, 'Explicit') : null, change ? h('span', { class: 'badge ink' }, `↻ Genrewechsel: ${was} → ${fam}`) : null)),
        h('span', { class: `badge p${u.player}` }, `P${u.player}`));
    }) : [h('div', { class: 'muted', style: 'padding:18px 0' }, 'Warteschlange leer – es kommen noch Songs.')]));
  clock.textContent = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

app.append(h('div', { class: 'lt' }, h('div', { class: 'row between' }, h('span', { class: 'eyebrow' }, `${BRAND.name} · Licht`), h('div', { class: 'row' }, live, clock)), nowBox, nextBox));
connect({
  onStatus: (ok) => { live.className = `pill ${ok ? 'live' : 'off'}`; live.lastChild.textContent = ok ? 'Live' : 'Getrennt'; },
  onState: (s) => { state = s; got = Date.now(); render(); },
});
setInterval(render, 500);   // Countdowns zaehlen auch zwischen den Server-Staenden weiter
