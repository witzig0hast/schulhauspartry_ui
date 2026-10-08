import { h, api, BASE, topbar, clear, safe, toast, modal, qrElement, $, fmtClock } from '/assets/app.js';
import { ampel } from '/assets/staff-ui.js';

const app = $('#app');
let data = null;
const tabs = ['start', 'poster', 'einstellungen', 'codes', 'verbindungen', 'bericht'];
const tabLabels = { start: 'Start & Links', poster: 'QR & Poster', einstellungen: 'Einstellungen', codes: 'Codes', verbindungen: 'Verbindungen', bericht: 'Bericht & Export' };
let tab = tabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'start';
const body = h('div');
const tabBar = h('div', { class: 'tabs' });

const field = (label, input) => h('label', { class: 'field' }, label, input);
const save = (patch, msg = 'Gespeichert') => safe(async () => { await api('/admin/settings', { method: 'POST', body: patch }); toast(msg); await load(); })();
const num = (v, extra = {}) => h('input', { type: 'number', value: v, ...extra });
const origin = () => location.origin;

async function load() {
  data = await api('/admin/settings');
  render();
}

function drawTabs() {
  clear(tabBar).append(...tabs.map((t) => h('button', { class: t === tab ? 'active' : '', onclick: () => { tab = t; location.hash = t; render(); } }, tabLabels[t])));
}

// ---------- Einstellungen ----------
function viewSettings() {
  const s = data.settings;
  const count = num(s.limit.count, { min: 1, max: 100 }), win = num(s.limit.windowMin, { min: 1, max: 600 });
  const explicit = h('select', {}, ...[['off', 'Aus – Explicit-Songs ganz normal'], ['mark', 'Markieren – "E" im Dashboard'], ['block', 'Blocken – Gäste können sie nicht wünschen']].map(([v, l]) => h('option', { value: v, selected: s.explicitMode === v }, l)));
  const reasons = h('textarea', { rows: 5 }); reasons.value = s.rejectReasons.join('\n');
  const noticeOn = h('input', { type: 'checkbox', checked: s.notice.enabled }), noticeText = h('textarea', { rows: 2, maxlength: 400 }); noticeText.value = s.notice.text;
  const msgs = Object.fromEntries(['paused', 'closed', 'ended'].map((k) => { const i = h('input', { value: s.wishMessages[k], maxlength: 200 }); return [k, i]; }));
  const prio = num(s.priorityWithin, { min: 1, max: 10 });
  const replayMode = h('select', {}, ...[['allow', 'Erlauben – Songs dürfen beliebig oft gewünscht werden'], ['cooldown', 'Pause – erst nach einer Wartezeit wieder wünschbar'], ['block', 'Sperren – schon gespielte Songs sind nicht mehr wünschbar']].map(([v, l]) => h('option', { value: v, selected: s.replay.mode === v }, l)));
  const replayMin = num(s.replay.cooldownMin, { min: 1, max: 1440 });
  const presets = s.fadePresets.map((p) => ({ name: h('input', { value: p.name, maxlength: 20 }), sec: num(p.sec, { min: 0.5, max: 60, step: 0.5 }) }));
  return h('div', { class: 'grid two' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Wunsch-Limit pro Gerät'),
      h('div', { class: 'row' }, count, h('span', {}, 'Wünsche pro'), win, h('span', {}, 'Minuten')),
      h('p', { class: 'small muted' }, 'Gilt pro Gerät (Cookie/Token), nicht pro IP. Ein "+1" auf einen schon vorgeschlagenen Song zählt ebenfalls.'),
      field('Explicit-Filter', explicit)),
    h('div', { class: 'card stack' }, h('h2', {}, 'Texte'),
      h('label', { class: 'check' }, noticeOn, 'Organisatoren-Hinweis anzeigen'), noticeText,
      field('Wenn Wünsche pausiert sind', msgs.paused), field('Wenn Wünsche geschlossen sind', msgs.closed), field('Ende-Modus', msgs.ended)),
    h('div', { class: 'card stack' }, h('h2', {}, 'Schon gespielte Songs'),
      h('p', { class: 'small muted' }, 'Gilt für Wünsche der Gäste. Die Moderation kann gespielte Songs jederzeit manuell wieder einreihen oder sperren.'),
      field('Regel', replayMode), h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Wartezeit bei „Pause“:'), replayMin, h('span', { class: 'small muted' }, 'Minuten'))),
    h('div', { class: 'card stack' }, h('h2', {}, 'Moderation'),
      field('Ablehnungsgründe (eine pro Zeile)', reasons),
      field('Priorisierte Songs kommen innerhalb der nächsten … Songs', prio)),
    h('div', { class: 'card stack' }, h('h2', {}, 'Fade-Presets'),
      ...presets.map((p) => h('div', { class: 'row' }, p.name, p.sec, h('span', {}, 's')))),
    h('div', { class: 'row', style: 'grid-column:1/-1' }, h('button', { class: 'primary', onclick: () => save({
      limit: { count: Number(count.value), windowMin: Number(win.value) }, explicitMode: explicit.value,
      replay: { mode: replayMode.value, cooldownMin: Number(replayMin.value) },
      rejectReasons: reasons.value.split('\n'), notice: { enabled: noticeOn.checked, text: noticeText.value },
      wishMessages: Object.fromEntries(Object.entries(msgs).map(([k, i]) => [k, i.value])), priorityWithin: Number(prio.value),
      fadePresets: presets.map((p) => ({ name: p.name.value, sec: Number(p.sec.value) })),
    }) }, 'Speichern')));
}

// ---------- Codes ----------
function viewCodes() {
  const role = h('select', {}, ...data.roles.map((r) => h('option', { value: r.id }, r.label)));
  const label = h('input', { placeholder: 'Bezeichnung (z. B. Mod Lisa)', maxlength: 40 });
  const table = h('div', { class: 'card', style: 'overflow-x:auto' });
  async function refresh() {
    const { accounts } = await api('/admin/accounts');
    clear(table).append(h('table', {},
      h('thead', {}, h('tr', {}, ...['Bezeichnung', 'Rolle', 'Angenommen', 'Abgelehnt', 'Priorisiert', 'Zuletzt', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...accounts.map((a) => h('tr', {},
        h('td', {}, h('strong', {}, a.label), a.revoked ? h('span', { class: 'badge bad', style: 'margin-left:6px' }, 'gesperrt') : null),
        h('td', {}, a.roleLabel), h('td', {}, a.approved), h('td', {}, a.denied), h('td', {}, a.prioritized), h('td', {}, a.last_seen ? fmtClock(a.last_seen) : '–'),
        h('td', {}, h('div', { class: 'row' },
          h('button', { class: 'small', onclick: safe(async () => { const { decisions } = await api(`/admin/accounts/${a.id}/decisions`); showDecisions(a, decisions); }) }, 'Entscheidungen'),
          !a.revoked ? h('button', { class: 'small', onclick: safe(async () => { await api(`/admin/accounts/${a.id}/revoke`, { method: 'POST', body: {} }); refresh(); }) }, 'Sperren') : null,
          h('button', { class: 'small bad', onclick: safe(async () => { if (!confirm(`Code "${a.label}" endgültig löschen?`)) return; await api(`/admin/accounts/${a.id}`, { method: 'DELETE' }); refresh(); }) }, 'Löschen'))))))));
  }
  refresh();
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Neuen Code erstellen'),
      h('div', { class: 'row' }, role, label, h('button', { class: 'primary', onclick: safe(async () => {
        const out = await api('/admin/accounts', { method: 'POST', body: { role: role.value, label: label.value } });
        label.value = '';
        const close = modal([h('h2', {}, 'Neuer Code'), h('p', { class: 'big', style: 'letter-spacing:.06em;user-select:all' }, out.code), h('p', { class: 'small muted' }, 'Wird nur jetzt angezeigt und kann später nicht mehr eingesehen werden.'), h('button', { class: 'primary', onclick: () => close() }, 'Notiert')]);
        refresh();
      }) }, 'Erstellen'))),
    table);
}
function showDecisions(a, decisions) {
  const close = modal([h('h2', {}, `Entscheidungen: ${a.label}`), decisions.length ? h('div', { class: 'list', style: 'max-height:50vh;overflow:auto' }, ...decisions.map((d) => h('div', { class: 'item row between' }, h('div', {}, h('div', { class: 'title small' }, d.title), h('div', { class: 'tiny muted' }, `${d.artist} · ${fmtClock(d.decided_at)}`)), h('span', { class: `badge ${d.status === 'denied' ? 'bad' : 'ok'}` }, d.status === 'denied' ? 'abgelehnt' : 'angenommen')))) : h('p', { class: 'muted' }, 'Keine Entscheidungen (in dieser Umgebung).'), h('button', { onclick: () => close() }, 'Schließen')]);
}

// ---------- Verbindungen ----------
function viewConnections() {
  const s = data.settings;
  const apiInfo = data.connections.live.api || data.connections.test.api;
  const budget = num(s.spotify.apiBudget, { min: 20, max: 300 });
  const cid = h('input', { value: s.spotify.clientId, placeholder: 'Client ID', autocomplete: 'off' });
  const csec = h('input', { type: 'password', placeholder: s.spotify.clientSecret ? '(gesetzt – leer lassen zum Behalten)' : 'Client Secret', autocomplete: 'new-password' });
  const playerBox = (n) => {
    const p = s.spotify.players[n];
    const devSel = h('select', {}, h('option', { value: p.deviceId }, p.deviceName || (p.deviceId ? p.deviceId : 'Aktives Gerät (automatisch)')));
    return h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, `Player ${n}`), h('span', { class: `badge ${p.connected ? 'ok' : ''}` }, p.connected ? `verbunden: ${p.user || ''}` : 'nicht verbunden')),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: safe(async () => { const { url } = await api('/admin/spotify/connect', { method: 'POST', body: { player: n } }); location.href = url; }) }, p.connected ? 'Neu verbinden' : 'Mit Spotify verbinden'),
        p.connected ? h('button', { onclick: safe(async () => { if (confirm('Verbindung trennen?')) save({ spotify: { players: { [n]: { disconnect: true } } } }, 'Getrennt'); }) }, 'Trennen') : null),
      p.connected ? h('div', { class: 'stack' }, h('div', { class: 'small muted' }, 'Wiedergabegerät (Spotify Connect, z. B. der Rechner/Streamer am X32)'), devSel,
        h('div', { class: 'row' }, h('button', { class: 'small', onclick: safe(async () => {
          const { devices } = await api(`/admin/spotify/devices/${n}`);
          clear(devSel).append(h('option', { value: '' }, 'Aktives Gerät (automatisch)'), ...devices.map((d) => h('option', { value: d.id, 'data-name': d.name, selected: d.id === p.deviceId }, `${d.name} (${d.type})${d.active ? ' • aktiv' : ''}`)));
        }) }, 'Geräte laden'), h('button', { class: 'small primary', onclick: () => { const o = devSel.selectedOptions[0]; save({ spotify: { players: { [n]: { deviceId: devSel.value, deviceName: o?.dataset.name || '' } } } }); } }, 'Gerät speichern'))) : null);
  };
  const adapter = h('select', {}, h('option', { value: 'mock', selected: s.x32.adapter === 'mock' }, 'Simuliert (kein Pi nötig)'), h('option', { value: 'http', selected: s.x32.adapter === 'http' }, 'Pi 5 / X32 über HTTP-Relay'));
  const piUrl = h('input', { value: s.x32.piUrl, placeholder: 'http://10.8.0.2:8080' });
  const piToken = h('input', { type: 'password', placeholder: s.x32.piToken ? '(gesetzt)' : 'Token', autocomplete: 'new-password' });
  const ch = s.x32.channels;
  const chIn = (v, i) => num(v[i], { min: 1, max: 32, class: 'num' });
  const p1 = [chIn(ch.p1, 0), chIn(ch.p1, 1)], p2 = [chIn(ch.p2, 0), chIn(ch.p2, 1)], mics = [0, 1, 2].map((i) => chIn(ch.mics, i));
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Status'),
      ...Object.entries(data.connections).map(([env, c]) => h('div', { class: 'stack' }, h('strong', {}, env === 'live' ? 'Live' : 'Testmodus'), ampel(c)))),
    h('div', { class: 'card stack' }, h('h2', {}, 'Spotify-App (Developer Dashboard)'),
      h('p', { class: 'small muted' }, 'Redirect-URI im Spotify-Dashboard eintragen: ', h('code', {}, data.redirectUri)),
      field('Client ID', cid), field('Client Secret', csec),
      h('button', { class: 'primary', onclick: () => save({ spotify: { clientId: cid.value, clientSecret: csec.value } }) }, 'Speichern')),
    h('div', { class: 'card stack' }, h('h2', {}, 'Spotify-API-Auslastung'),
      h('p', { class: 'small muted' }, 'Spotify begrenzt Anfragen pro App (gleitendes 30-Sekunden-Fenster) und lässt sich nicht abschalten. Die App bleibt deshalb weit darunter: Suchergebnisse werden gemerkt, gleiche Anfragen zusammengefasst, der Player-Status nur bei Bedarf abgefragt. Steuerbefehle haben Vorrang. Meldet Spotify doch ein Limit, pausiert die App automatisch und der Cache übernimmt.'),
      apiInfo ? h('div', { class: 'stack', style: 'gap:8px' },
        h('div', { class: 'row between small' }, h('span', {}, `${apiInfo.used} von ${apiInfo.budget} Anfragen in den letzten ${apiInfo.windowSec} s`), apiInfo.pausedSec ? h('span', { class: 'badge warn' }, `Limit – Pause ${apiInfo.pausedSec} s`) : h('span', { class: 'badge ok' }, 'in Ordnung')),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, Math.round(100 * apiInfo.used / apiInfo.budget))}%` })),
        h('div', { class: 'small muted' }, `Seit Start: ${apiInfo.total} Anfragen · ${apiInfo.cacheHits} aus dem Cache · ${apiInfo.coalesced} zusammengefasst · ${apiInfo.rate429} × Limit von Spotify`))
        : h('div', { class: 'small muted' }, 'Sobald echte Spotify-Verbindungen aktiv sind, erscheint hier die Auslastung.'),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Eigenes Budget'), budget, h('span', { class: 'small muted' }, 'Anfragen pro 30 s (Standard 60)'),
        h('button', { class: 'small', onclick: () => save({ spotify: { apiBudget: Number(budget.value) } }) }, 'Speichern'))),
    h('div', { class: 'grid two' }, playerBox(1), playerBox(2)),
    h('div', { class: 'card stack' }, h('h2', {}, 'X32 / Pi 5'),
      field('Anbindung', adapter), field('Pi-URL (Relay)', piUrl), field('Token', piToken),
      h('div', { class: 'grid three' }, field('Player 1 (L/R)', h('div', { class: 'row' }, ...p1)), field('Player 2 (L/R)', h('div', { class: 'row' }, ...p2)), field('Mic-Kanäle', h('div', { class: 'row' }, ...mics))),
      h('button', { class: 'primary', onclick: () => save({ x32: { adapter: adapter.value, piUrl: piUrl.value, piToken: piToken.value, channels: { p1: p1.map((i) => Number(i.value)), p2: p2.map((i) => Number(i.value)), mics: mics.map((i) => Number(i.value)) } } }) }, 'Speichern'),
      h('p', { class: 'small muted' }, 'Echte Verbindungen (Spotify, Pi) nutzt immer nur die unter "Start & Links → Testmodus-Optionen" gewählte Umgebung; die andere läuft simuliert.')));
}

// ---------- Start: Links, Testmodus, Zuruecksetzen ----------
const PAGES = [
  ['Gäste-Seite', '/', 'Dahin kommt der QR-Code'],
  ['Anmeldung', '/login', 'Für alle Mitarbeitenden'],
  ['Technik', '/tech', 'Fader, Crossfade, Not-Aus'],
  ['Moderation', '/mod', 'Wünsche annehmen / ablehnen'],
  ['Anzeige', '/foh', 'Nur ansehen (FOH-Bildschirm)'],
  ['Fokus-Modus', '/focus', 'Schwarz, bis ein Wunsch kommt (Annehmen/Ablehnen)'],
  ['Live-Wünsche', '/ticker', 'Live-Anzeige aller Wünsche und Entscheidungen'],
  ['Analytics', '/analytics', 'Genres, Interpreten, Zeitverlauf …'],
  ['Board', '/board', 'Eigene Ansicht aus Bausteinen'],
  ['Beamer', '/beamer', 'Großer Bildschirm für die Gäste (öffentlich)'],
  ['Admin', '/admin', 'Diese Seite'],
];

function linkTable(prefix) {
  return h('div', {}, ...PAGES.map(([label, path, hint]) => {
    const url = `${origin()}${prefix}${path === '/' ? '/' : path}`;
    return h('div', { class: 'linkrow' },
      h('div', { class: 'lbl' }, label),
      h('div', { class: 'url', title: hint }, url),
      h('button', { class: 'small', onclick: safe(async () => { try { await navigator.clipboard.writeText(url); toast('Link kopiert'); } catch { toast(url); } }) }, 'Kopieren'),
      h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener', style: 'height:32px;padding:0 12px;font-size:.82rem;border-radius:9px' }, 'Öffnen'));
  }));
}

function viewStart() {
  const t = data.settings.test;
  const speed = num(t.mockSpeed, { min: 1, max: 60, step: 1 });
  const real = h('select', {}, h('option', { value: 'live', selected: t.realEnv === 'live' }, 'Live (Party)'), h('option', { value: 'test', selected: t.realEnv === 'test' }, 'Testmodus'));
  const resetTest = () => { if (confirm('Alle Testdaten löschen (Wünsche, Queue, Setlist) und die Test-Wiedergabe stoppen?')) safe(async () => { await api('/admin/reset', { method: 'POST', body: { env: 'test' } }); toast('Testmodus zurückgesetzt'); await load(); })(); };
  const resetLive = () => {
    const typed = prompt('ACHTUNG: Das löscht ALLE Live-Wünsche, die Warteschlange und die Setlist und stoppt die Wiedergabe.\nCodes und Einstellungen bleiben.\n\nZur Bestätigung tippe: ZURÜCKSETZEN');
    if (typed === 'ZURÜCKSETZEN') safe(async () => { await api('/admin/reset', { method: 'POST', body: { env: 'live', confirm: 'ZURÜCKSETZEN' } }); toast('Live-Daten zurückgesetzt'); await load(); })();
    else if (typed != null) toast('Nicht bestätigt – nichts gelöscht', true);
  };
  const c = data.counts;
  return h('div', { class: 'stack', style: 'gap:16px' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Links – Live'), h('p', { class: 'small muted' }, 'Diese Adressen sind die echte Party. Zugang bekommt man mit einem Code (außer die Gäste-Seite).'), linkTable('')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h2', {}, 'Links – Testmodus'), h('span', { class: `badge ${t.enabled ? 'ok' : ''}` }, t.enabled ? 'AN' : 'AUS')),
      h('p', { class: 'small muted' }, 'Gleiche Seiten wie live, aber mit eigenen Testdaten und rotem Banner. Mitarbeitende nutzen dieselben Codes wie live.'),
      t.enabled ? linkTable(`/${t.prefix}`) : h('div', { class: 'empty' }, h('div', { class: 'small' }, 'Der Testmodus ist ausgeschaltet – die Test-Adressen sind gesperrt.')),
      h('div', { class: 'row' },
        h('button', { class: t.enabled ? '' : 'primary', onclick: () => save({ test: { enabled: !t.enabled } }) }, t.enabled ? 'Testmodus ausschalten' : 'Testmodus einschalten'),
        t.enabled ? h('button', { onclick: () => { if (confirm('Neue Test-Adresse erzeugen? Die alte funktioniert dann nicht mehr.')) save({ test: { regeneratePrefix: true } }); } }, 'Test-Adresse erneuern') : null)),
    h('div', { class: 'card stack danger' },
      h('h2', {}, 'Zurücksetzen'),
      h('p', { class: 'small muted' }, 'Löscht Wünsche, Warteschlange, Setlist und Zähler und stoppt die Wiedergabe. Codes und Einstellungen bleiben erhalten.'),
      h('div', { class: 'row between' }, h('div', {}, h('strong', {}, 'Testmodus'), h('div', { class: 'small muted' }, `${c.test.pending} offen · ${c.test.approved} in Queue · ${c.test.played} gespielt`)), h('button', { class: 'outline-bad', onclick: resetTest }, 'Testmodus zurücksetzen')),
      h('hr'),
      h('div', { class: 'row between' }, h('div', {}, h('strong', {}, 'Live'), h('div', { class: 'small muted' }, `${c.live.pending} offen · ${c.live.approved} in Queue · ${c.live.played} gespielt`)), h('button', { class: 'bad', onclick: resetLive }, 'Live zurücksetzen …'))),
    h('details', { class: 'card more' }, h('summary', {}, 'Testmodus-Optionen'),
      h('div', { class: 'stack', style: 'margin-top:12px' },
        field('Echte Verbindungen (Spotify/Pi) nutzt', real),
        field('Simulations-Tempo im Testmodus (Faktor)', speed),
        h('button', { class: 'primary', onclick: () => save({ test: { realEnv: real.value, mockSpeed: Number(speed.value) } }) }, 'Speichern'))));
}

// ---------- QR & Poster ----------
function viewPoster() {
  const t = data.settings.test;
  const target = h('select', {}, h('option', { value: 'live' }, 'Live – Gäste-Seite'), t.enabled ? h('option', { value: 'test' }, 'Testmodus – Gäste-Seite') : null);
  const head = h('input', { value: 'Wünsch dir was!', maxlength: 40 });
  const sub = h('input', { value: 'Scanne den Code und such dir deinen Song aus.', maxlength: 90 });
  const out = h('div', { class: 'poster' });
  const urlOf = () => `${origin()}${target.value === 'test' ? `/${t.prefix}` : ''}/`;
  async function paint() {
    const url = urlOf();
    const qr = await qrElement(url, { size: 340 });
    clear(out).append(h('h2', {}, head.value), h('p', { class: 'p-sub' }, sub.value), qr,
      h('div', { class: 'steps' }, h('div', {}, h('b', {}, '1'), 'QR-Code scannen'), h('div', {}, h('b', {}, '2'), 'Song suchen & antippen'), h('div', {}, h('b', {}, '3'), 'Wünschen – wir spielen ihn bald!')),
      h('div', { class: 'p-url' }, url.replace(/^https?:\/\//, '')));
  }
  [target, head, sub].forEach((el) => el.addEventListener('input', () => paint().catch(() => {})));
  paint().catch((e) => toast(e.message, true));
  return h('div', { class: 'stack', style: 'gap:16px' },
    h('div', { class: 'card stack no-print' }, h('h2', {}, 'QR-Code & Poster'), h('p', { class: 'small muted' }, 'Zum Ausdrucken (A4). Der Code führt auf die Gäste-Seite.'),
      h('div', { class: 'grid two' }, h('label', { class: 'field' }, 'Ziel', target), h('label', { class: 'field' }, 'Überschrift', head)),
      h('label', { class: 'field' }, 'Untertitel', sub),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => window.print() }, '🖨  Drucken / als PDF speichern'), h('a', { class: 'btn', href: `${BASE}/beamer`, target: '_blank', rel: 'noopener' }, 'Beamer-Ansicht öffnen'))),
    out);
}

// ---------- Bericht ----------
function viewReport() {
  const envSel = h('select', {}, h('option', { value: 'live' }, 'Live'), h('option', { value: 'test' }, 'Testmodus'));
  const out = h('div', { class: 'stack' });
  const csv = h('a', { class: 'btn', href: `${BASE}/api/admin/setlist.csv?env=live` }, '⬇ Setlist als CSV');
  async function run() {
    csv.href = `${BASE}/api/admin/setlist.csv?env=${envSel.value}`;
    const r = await api(`/admin/report?env=${envSel.value}`);
    const t = r.totals;
    const stat = (k, v) => h('div', { class: 'card' }, h('div', { class: 'muted tiny' }, k), h('div', { class: 'big' }, String(v ?? '–')));
    clear(out).append(
      h('div', { class: 'grid three' }, stat('Wünsche gesamt', t.requests), stat('Angenommen', t.approved), stat('Abgelehnt', t.denied), stat('Quote angenommen', t.approvalRate == null ? '–' : `${t.approvalRate} %`),
        stat('Gespielte Songs', r.plays.count), stat('Priorisiert', t.prioritized), stat('Geräte (Gäste)', t.guestDevices), stat('Not-Aus / Fehler', `${r.panics} / ${r.errors}`)),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('h2', {}, 'Meistgewünscht'), h('table', {}, h('tbody', {}, ...r.top.map((x) => h('tr', {}, h('td', {}, `${x.title} – ${x.artist}`), h('td', {}, `${x.votes}×`)))))),
        h('div', { class: 'card' }, h('h2', {}, 'Stoßzeiten (15-Min-Fenster)'), h('table', {}, h('tbody', {}, ...r.peaks.map((x) => h('tr', {}, h('td', {}, fmtClock(x.from)), h('td', {}, `${x.count} Wünsche`))))))),
      h('div', { class: 'card' }, h('h2', {}, 'Entscheidungen pro Code'), h('table', {}, h('thead', {}, h('tr', {}, ...['Code', 'Rolle', 'Angenommen', 'Abgelehnt'].map((x) => h('th', {}, x)))), h('tbody', {}, ...r.perCode.map((c) => h('tr', {}, h('td', {}, c.label), h('td', {}, c.role), h('td', {}, c.approved), h('td', {}, c.denied)))))));
  }
  envSel.addEventListener('change', safe(run));
  run().catch((e) => toast(e.message, true));
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, envSel, csv), out);
}

function render() {
  drawTabs();
  clear(body).append({ start: viewStart, poster: viewPoster, einstellungen: viewSettings, codes: viewCodes, verbindungen: viewConnections, bericht: viewReport }[tab]());
}

app.append(topbar('Admin', { live: false, nav: true }), h('div', { class: 'wrap' }, tabBar, body));
load().catch((e) => toast(e.message, true));
