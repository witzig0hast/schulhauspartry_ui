import { h, connect, clear, coverOnce, BRAND, $ } from '/assets/app.js';
import { kpi, chatPanel } from '/assets/staff-ui.js';
import { deptBar } from '/assets/dept.js';

// Dashboard Orga / Einlass (nur lesen): Uhr, Zeitplan mit Countdown, Zahlen und Gaeste online, Stand der Wuensche,
// Hinweise, Team und Chat. Fuer Leute, die nicht an der Technik sitzen, aber wissen muessen, was laeuft.
try { if (!localStorage.getItem('theme')) document.documentElement.dataset.theme = 'dark'; } catch { /* egal */ }
const app = $('#app');
let state = null, got = 0;
const pad = (n) => String(n).padStart(2, '0');
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}`; };
const swap = (slot, key, build) => { if (slot.dataset.k === key) return; slot.dataset.k = key; clear(slot).append(build()); };
const CAN_CHAT = ['admin', 'tech', 'mod', 'dj'];

const clock = h('div', { class: 'dclock mono' });
const date = h('div', { class: 'muted' });
const live = h('span', { class: 'pill off' }, h('i', { class: 'dot' }), 'Verbinde …');
const deptSlot = h('div');
const nowBox = h('div'), schedBox = h('div'), kpiBox = h('div'), wishBox = h('div', { class: 'stack' }), teamBox = h('div', { class: 'stack' }), chatBox = h('div');
const chatCard = h('section', { class: 'dcard' }, h('h2', {}, 'Team-Chat'), chatBox);

function render() {
  if (!state) return;
  const s = state, age = Date.now() - got, d = new Date();
  swap(deptSlot, s.role, () => deptBar('orga', s.role));
  clock.textContent = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  date.textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' });

  // Jetzt & gleich
  const pl = [1, 2].map((n) => ({ n, p: s.players[n] }));
  const cur = s.mode === 'wishlist' ? (s.nowPlayingTitle ? { p: { ...s.nowPlayingTitle, playing: true } } : null) : pl.find((x) => x.p.playing && x.n === s.current) || pl.find((x) => x.p.playing);
  const next = (s.upcoming || []).slice(0, 3);
  swap(nowBox, JSON.stringify([cur?.p.title, cur?.p.trackId, next.map((u) => u.id), Math.round((cur?.p.remainingMs ?? 0) / 10000)]), () => h('div', { class: 'stack' },
    cur ? h('div', { class: 'dplayer-main' }, coverOnce(cur.p.title, 'lg', cur.p.trackId), h('div', { class: 'grow', style: 'min-width:0' }, h('div', { class: 'eyebrow' }, 'Jetzt läuft'), h('div', { class: 'dt' }, cur.p.title), h('div', { class: 'da' }, cur.p.artist),
      cur.p.remainingMs ? h('div', { class: 'small muted mono' }, `noch ca. ${mmss(Math.max(0, cur.p.remainingMs - age))}`) : null))
      : h('div', { class: 'dt muted' }, s.pauseMode ? 'Pause' : 'Gerade läuft nichts'),
    next.length ? h('div', {}, h('div', { class: 'eyebrow', style: 'margin-top:8px' }, 'Gleich danach'), ...next.map((u) => h('div', { class: 'q-row' }, coverOnce(u.title, 'sm', u.trackId), h('div', { class: 'grow' }, h('div', { class: 't' }, u.title), h('div', { class: 'a' }, u.artist))))) : null));

  // Zeitplan
  const nowM = d.getHours() * 60 + d.getMinutes();
  const items = (s.schedule || []).filter((i) => !i.done).slice(0, 6);
  swap(schedBox, JSON.stringify([items.map((i) => [i.id, i.at, i.title]), nowM]), () => (items.length ? h('div', {}, ...items.map((i, k) => {
    const [a, b] = String(i.at).split(':').map(Number); const diff = a * 60 + b - nowM;
    return h('div', { class: `q-row ${k === 0 ? 'prio' : ''}` }, h('b', { class: 'mono', style: 'min-width:5ch' }, i.at), h('div', { class: 'grow' }, h('div', { class: 't' }, i.title), i.note ? h('div', { class: 'a' }, i.note) : null),
      h('span', { class: `badge ${diff <= 0 ? 'warn' : diff <= 15 ? 'ink' : ''}` }, diff <= 0 ? 'jetzt' : diff < 60 ? `in ${diff} Min.` : `in ${Math.floor(diff / 60)} h ${diff % 60} Min.`));
  })) : h('div', { class: 'muted small' }, 'Keine offenen Programmpunkte (Zeitplan in der Technik/Admin pflegen).')));

  // Zahlen
  const c = s.counts || {};
  swap(kpiBox, JSON.stringify([s.guestsOnline, c]), () => h('div', { class: 'kpis', style: 'grid-column:1/-1' },
    kpi('Gäste online', s.guestsOnline ?? '–'), kpi('Wünsche offen', c.pending ?? 0, { hot: (c.pending ?? 0) > 0 }), kpi('In der Warteschlange', c.approved ?? 0), kpi('Gespielt', c.played ?? 0)));

  // Wuensche & Hinweise
  const mode = { open: ['ok', 'Wünsche offen'], paused: ['warn', 'Wünsche pausiert'], closed: ['bad', 'Wünsche geschlossen'] }[s.wishMode] || ['', s.wishMode];
  const opens = s.opening?.awaiting && s.opening?.opensAt ? new Date(s.opening.opensAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : null;
  swap(wishBox, JSON.stringify([s.wishMode, opens, s.opening?.awaiting, s.ended, s.pauseMode, s.notice, s.handover?.ts, s.poll?.id, s.poll?.counts]), () => h('div', { class: 'stack' },
    h('div', { class: 'row' }, h('span', { class: `badge big ${mode[0]}` }, mode[1]), s.ended ? h('span', { class: 'badge big warn' }, 'Ende-Modus') : null, s.pauseMode ? h('span', { class: 'badge big warn' }, 'Pause') : null),
    s.opening?.awaiting ? h('div', { class: 'small' }, opens ? `Freischaltung um ${opens} Uhr` : 'Warten auf Freischaltung durch die Technik') : null,
    s.notice?.enabled && s.notice.text ? h('div', { class: 'banner-pause' }, `${s.notice.text}`) : null,
    s.handover?.text ? h('div', { class: 'small' }, h('b', {}, 'Übergabe-Notiz: '), s.handover.text) : null,
    s.poll ? h('div', { class: 'small' }, h('b', {}, `Umfrage: ${s.poll.question} `), s.poll.options.map((o, i) => `${o}: ${s.poll.counts[i]}`).join(' · ')) : null));

  // Team
  swap(teamBox, JSON.stringify(s.online || null), () => (s.online ? h('div', { class: 'row' }, ...(s.online.length ? s.online.map((n) => h('span', { class: 'badge ok' }, n)) : [h('span', { class: 'muted small' }, 'Niemand angemeldet.')])) : h('div', { class: 'muted small' }, 'Für diese Rolle nicht sichtbar.')));
  chatCard.classList.toggle('hidden', !s.chat);
  if (s.chat) swap(chatBox, JSON.stringify(s.chat.map((m) => m.id)), () => chatPanel(s, { canWrite: CAN_CHAT.includes(s.role) }));
}

app.append(h('div', { class: 'dash' },
  h('div', { class: 'row between' }, h('div', { class: 'row' }, h('span', { class: 'eyebrow' }, `${BRAND.name} · Orga`), deptSlot), live),
  h('div', { class: 'row between', style: 'align-items:flex-end' }, h('div', {}, clock, date)),
  kpiBox,
  h('div', { class: 'dgrid two' }, h('section', { class: 'dcard' }, h('h2', {}, 'Musik'), nowBox), h('section', { class: 'dcard' }, h('h2', {}, 'Zeitplan'), schedBox)),
  h('div', { class: 'dgrid two' }, h('section', { class: 'dcard' }, h('h2', {}, 'Wünsche & Hinweise'), wishBox), h('section', { class: 'dcard' }, h('h2', {}, 'Team online'), teamBox)),
  chatCard));
connect({
  ping: true,
  onStatus: (ok) => { live.className = `pill ${ok ? 'live' : 'off'}`; live.lastChild.textContent = ok ? 'Live' : 'Getrennt'; },
  onState: (s) => { state = s; got = Date.now(); render(); },
});
setInterval(render, 1000);
