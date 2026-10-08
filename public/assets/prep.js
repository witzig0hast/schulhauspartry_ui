import { h, api, connect, topbar, clear, safe, toast, BASE, $ } from '/assets/app.js';
import { bar } from '/assets/staff-ui.js';

// Vorbereitung: alles auf einen Blick pruefen, verbinden und durchtesten -- vor der Party.
const app = $('#app');
let data = null, live = null;
const top = topbar('Vorbereitung', { nav: true });
const banner = h('div', { class: 'ready' });
const groupsBox = h('div', { class: 'stack', style: 'gap:16px' });
const liveBox = h('div', { class: 'card stack' });

const ICON = { ok: '✓', warn: '!', fail: '✕', info: 'i' };
const GROUP_LINK = { Grundlagen: '/admin#codes', Spotify: '/admin#verbindungen', Technik: '/admin#verbindungen', Ablauf: '/admin#start' };

async function run(id) {
  try {
    const out = await api('/prep/action', { method: 'POST', body: { id } });
    toast(out.info || 'Erledigt');
  } catch (e) { toast(e.message, true); }
  load();
}

function renderChecks() {
  const { fail, warn } = data;
  banner.className = `ready ${fail ? 'fail' : warn ? 'warn' : 'ok'}`;
  clear(banner).append(h('div', { style: 'font-size:2.2rem' }, fail ? '🛑' : warn ? '⚠️' : '✅'),
    h('div', {}, h('div', { class: 'big' }, fail ? `${fail} Punkt${fail > 1 ? 'e' : ''} nicht in Ordnung` : warn ? `Fast bereit – ${warn} Hinweis${warn > 1 ? 'e' : ''}` : 'Alles bereit für die Party!'),
      h('div', { class: 'small muted' }, fail ? 'Rote Punkte zuerst beheben.' : warn ? 'Gelbe Punkte prüfen – müssen aber nicht blockieren.' : 'Alle Prüfungen bestanden.')),
    h('div', { style: 'margin-left:auto' }, h('button', { onclick: () => load() }, '↻ Neu prüfen')));
  const groups = [...new Set(data.checks.map((c) => c.group))];
  clear(groupsBox).append(...groups.map((g) => h('div', { class: 'card' },
    h('div', { class: 'row between' }, h('h2', {}, g), h('a', { class: 'small', href: BASE + GROUP_LINK[g] }, 'Einstellungen →')),
    h('div', { class: 'prep-grp' }, ...data.checks.filter((c) => c.group === g).map((c) => h('div', { class: 'prep-row' },
      h('div', { class: `prep-ic ${c.status}` }, ICON[c.status]),
      h('div', {}, h('div', { style: 'font-weight:620' }, c.label), h('div', { class: 'small muted' }, c.detail)),
      c.action ? h('button', { class: 'small', onclick: () => run(c.action.id) }, c.action.label) : null))))));
}

function renderLive() {
  if (!live) return;
  clear(liveBox).append(h('h2', {}, 'Live-Pegel (zum Durchtesten)'),
    h('p', { class: 'small muted' }, 'Sprich in jedes Mikrofon: der Balken muss ausschlagen. Mit „Fader-Test“ fahren beide Player-Fader kurz herunter und zurück.'),
    ...(live.mics || []).map((m) => h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'row between small' }, h('strong', {}, m.name), h('span', { class: `badge ${m.open ? 'ok' : ''}` }, m.open ? 'offen' : 'stumm')), bar(m.level, 'meter'))),
    ...(live.mics?.length ? [] : [h('div', { class: 'muted small' }, 'Keine Mic-Daten.')]),
    ...[1, 2].map((n) => h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'row between small' }, h('strong', {}, `Player ${n}`), h('span', { class: 'muted' }, live.players[n].playing ? `spielt: ${live.players[n].title}` : 'gestoppt')), bar(live.players[n].meter ?? 0, 'meter'))));
}

const load = safe(async () => { data = await api('/prep/status'); renderChecks(); });

app.append(top, h('div', { class: 'wrap' }, banner, h('div', { class: 'grid main' }, groupsBox, liveBox)));
connect({ ping: true, onStatus: (ok) => top.setLive(ok), onState: (s) => { live = s; renderLive(); } });
load();
setInterval(load, 6000);
