import { h, api, BASE, topbar, clear, safe, toast, modal, qrElement, $, fmtClock, passkeysSupported, passkeyRegister } from '/assets/app.js';
import { ampel } from '/assets/staff-ui.js';

const app = $('#app');
let data = null;
const tabs = ['start', 'funktionen', 'sicherheit', 'vpn', 'automatik', 'design', 'poster', 'einstellungen', 'codes', 'verbindungen', 'bericht'];
const tabLabels = { start: 'Start & Links', funktionen: 'Funktionen', sicherheit: 'Sicherheit', vpn: 'VPN', automatik: 'Automatik', design: 'Design', poster: 'QR & Poster', einstellungen: 'Einstellungen', codes: 'Codes', verbindungen: 'Verbindungen', bericht: 'Bericht & Export' };
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
  const replayMin = num(s.replay.cooldownMin, { min: 1, max: 1440, class: 'num' });
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
  const budget = num(s.spotify.apiBudget, { min: 20, max: 300, class: 'num' });
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
  const piUrl = h('input', { value: s.x32.piUrl, placeholder: 'http://192.168.178.177:8080, http://192.168.178.207:8080' });
  const piToken = h('input', { type: 'password', placeholder: s.x32.piToken ? '(gesetzt)' : 'Token', autocomplete: 'new-password' });
  const ch = s.x32.channels;
  const chIn = (v, i) => num(v[i] ?? '', { min: 1, max: 32, class: 'num', placeholder: '–' });
  const p1 = [chIn(ch.p1, 0), chIn(ch.p1, 1)], p2 = [chIn(ch.p2, 0), chIn(ch.p2, 1)], mics = [0, 1, 2].map((i) => chIn(ch.mics, i));
  const micNames = [0, 1, 2].map((i) => h('input', { value: (s.x32.micNames || [])[i] || `Mic ${i + 1}`, maxlength: 24, 'aria-label': `Name Mikro ${i + 1}` }));
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
      field('Anbindung', adapter), field('Pi-URL(s) des Relays – mehrere durch Komma: zuerst die im LAN, dann die per VPN; die App nimmt automatisch die, die antwortet', piUrl), field('Token', piToken),
      h('div', { class: 'eyebrow' }, 'Kanalzuordnung am X32 (Eingangskanäle 1–32)'),
      h('p', { class: 'small muted' }, 'Hier legst du fest, auf welchen X32-Kanälen die Player und Mikrofone liegen. Das gilt sofort und wird automatisch an den Pi weitergegeben – die Relay-.env musst du dafür nicht ändern. Ein Player hat 1 Kanal (Mono) oder 2 (Stereo links/rechts); leer lassen = nicht benutzt.'),
      h('div', { class: 'grid three' }, field('Player 1 (Kanal L / R)', h('div', { class: 'row' }, ...p1)), field('Player 2 (Kanal L / R)', h('div', { class: 'row' }, ...p2)), field('Mikrofon-Kanäle (bis zu 3)', h('div', { class: 'row' }, ...mics))),
      field('Namen der Mikrofone (so erscheinen sie in Technik und Anzeige)', h('div', { class: 'row' }, ...micNames)),
      h('button', { class: 'primary', onclick: () => save({ x32: { adapter: adapter.value, piUrl: piUrl.value, piToken: piToken.value, micNames: micNames.map((i) => i.value), channels: { p1: p1.map((i) => i.value), p2: p2.map((i) => i.value), mics: mics.map((i) => i.value) } } }) }, 'Speichern'),
      h('p', { class: 'small muted' }, 'Echte Verbindungen (Spotify, Pi) nutzt immer nur die unter "Start & Links → Testmodus-Optionen" gewählte Umgebung; die andere läuft simuliert.')));
}

// ---------- Start: Links, Testmodus, Zuruecksetzen ----------
const PAGES = [
  ['Gäste-Seite', '/', 'Dahin kommt der QR-Code'],
  ['Anmeldung', '/login', 'Für alle Mitarbeitenden'],
  ['Vorbereitung', '/prep', 'Alles vor der Party prüfen & testen'],
  ['Technik', '/tech', 'Fader, Crossfade, Not-Aus'],
  ['Moderation', '/mod', 'Wünsche annehmen / ablehnen'],
  ['Anzeige', '/foh', 'Nur ansehen (FOH-Bildschirm)'],
  ['Fokus-Modus', '/focus', 'Schwarz, bis ein Wunsch kommt (Annehmen/Ablehnen)'],
  ['Live-Wünsche', '/ticker', 'Live-Anzeige aller Wünsche und Entscheidungen'],
  ['Analytics', '/analytics', 'Genres, Interpreten, Zeitverlauf …'],
  ['Board', '/board', 'Eigene Ansicht aus Bausteinen'],
  ['Beamer', '/beamer', 'Großer Bildschirm für die Gäste (öffentlich)'],
  ['Bühne', '/stage', 'Jetzt, Nächster, Uhr, Zeitplan, Mics'],
  ['Licht', '/light', 'Lichttechnik: jetzt, nächste Songs mit Genre, Übergang-Countdown'],
  ['Zeitplan', '/schedule', 'Programmpunkte mit Countdown'],
  ['Verlauf', '/activity', 'Was ist heute passiert?'],
  ['Wunsch-Charts', '/charts', 'Rangliste für einen Bildschirm (öffentlich)'],
  ['Playlist des Abends', '/wall', 'Was bisher lief (öffentlich)'],
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

// ---------- Automatik ----------
const FAMILIES = ['Pop', 'Hip-Hop & Rap', 'Electronic & Dance', 'Rock & Metal', 'R&B & Soul', 'Schlager & Deutsch', 'Latin', 'Funk & Disco', 'Reggae & Dancehall', 'Country & Folk', 'Jazz & Klassik'];
const chk = (checked) => h('input', { type: 'checkbox', checked });

function viewAutomation() {
  const s = data.settings;
  const ao = s.autoOrder, fi = s.filler, em = s.emergency, nt = s.notify, bk = s.backup;
  const aoOn = chk(ao.enabled), moodOn = chk(ao.mood), maxRep = num(ao.maxRepeat, { min: 1, max: 10 }), win = num(ao.window, { min: 2, max: 10 });
  const tz = h('input', { value: s.timezone, placeholder: 'Europe/Berlin' });
  const smart = chk(s.auto.smartOutro);
  // Phasen der Stimmungskurve
  let phases = ao.phases.map((p) => ({ ...p, prefer: [...p.prefer] }));
  const phaseBox = h('div', { class: 'stack' });
  const paintPhases = () => clear(phaseBox).append(...phases.map((p, i) => h('div', { class: 'item stack' },
    h('div', { class: 'phase-row' },
      h('input', { value: p.name, maxlength: 30, placeholder: 'Name, z. B. Aufwärmen', oninput: (e) => { p.name = e.target.value; } }),
      h('input', { type: 'time', value: p.from, oninput: (e) => { p.from = e.target.value; } }), h('input', { type: 'time', value: p.to, oninput: (e) => { p.to = e.target.value; } }),
      h('span', { class: 'small muted' }, p.prefer.length ? `bevorzugt: ${p.prefer.join(', ')}` : 'keine Vorliebe gewählt'),
      h('button', { class: 'small ghost', onclick: () => { phases.splice(i, 1); paintPhases(); } }, '✕')),
    h('div', { class: 'chips' }, ...FAMILIES.map((f) => h('button', { class: `chip ${p.prefer.includes(f) ? 'on' : ''}`, onclick: () => { p.prefer = p.prefer.includes(f) ? p.prefer.filter((x) => x !== f) : [...p.prefer, f]; paintPhases(); } }, f))))),
    h('button', { class: 'small', onclick: () => { phases.push({ name: 'Neue Phase', from: '20:00', to: '22:00', prefer: [] }); paintPhases(); } }, '+ Phase hinzufügen'));
  paintPhases();

  const fOn = chk(fi.enabled), fPl = h('input', { value: fi.playlist, placeholder: 'Playlist-Link oder -ID' }), fMin = num(fi.minQueue, { min: 0, max: 10, class: 'num' }), fAvoid = num(fi.avoidMin, { min: 5, max: 1440, class: 'num' });
  const ePl = h('input', { value: em.playlist, placeholder: 'Playlist-Link oder -ID' });
  const ePlayer = h('select', {}, h('option', { value: '1', selected: em.player === 1 }, 'Player 1'), h('option', { value: '2', selected: em.player === 2 }, 'Player 2'));
  const eShuf = chk(em.shuffle);
  const nOn = chk(nt.enabled), nUrl = h('input', { value: nt.url, placeholder: 'https://ntfy.sh oder eigener Server' }), nTopic = h('input', { value: nt.topic, placeholder: 'geheimes-topic-name' });
  const nTok = h('input', { type: 'password', placeholder: nt.token ? '(gesetzt – leer lassen zum Behalten)' : 'Zugriffstoken (optional)', autocomplete: 'new-password' }), nDown = num(nt.downSec, { min: 5, max: 300 });
  const EVLABEL = { x32: 'X32/Pi nicht erreichbar', spotify: 'Spotify-Problem oder -Limit', player: 'Player getrennt', panic: 'Not-Aus ausgelöst', queueEmpty: 'Warteschlange leer', emergency: 'Notfall-Playlist gestartet', backup: 'Backup fehlgeschlagen' };
  const evs = Object.fromEntries(Object.keys(nt.events).map((k) => [k, chk(nt.events[k])]));
  const bOn = chk(bk.enabled), bEvery = num(bk.everyMin, { min: 5, max: 1440, class: 'num' }), bKeep = num(bk.keep, { min: 1, max: 200, class: 'num' });
  const bList = h('div', { class: 'stack', style: 'gap:6px' });
  const loadBackups = async () => {
    const { backups } = await api('/admin/backups');
    clear(bList).append(...(backups.length ? backups.slice(0, 8).map((b) => h('div', { class: 'row between small' }, h('span', {}, `${new Date(b.ts).toLocaleString('de-DE')} · ${(b.size / 1024).toFixed(0)} KB`),
      h('a', { class: 'btn small', href: `${BASE}/api/admin/backups/${b.name}`, style: 'height:30px;font-size:.8rem;padding:0 10px' }, '⬇ Laden'))) : [h('div', { class: 'muted small' }, 'Noch keine Backups.')]));
  };
  loadBackups().catch(() => {});

  const saveAll = () => save({
    timezone: tz.value,
    auto: { smartOutro: smart.checked },
    autoOrder: { enabled: aoOn.checked, mood: moodOn.checked, maxRepeat: Number(maxRep.value), window: Number(win.value), phases },
    filler: { enabled: fOn.checked, playlist: fPl.value, minQueue: Number(fMin.value), avoidMin: Number(fAvoid.value) },
    emergency: { playlist: ePl.value, player: Number(ePlayer.value), shuffle: eShuf.checked },
    notify: { enabled: nOn.checked, url: nUrl.value, topic: nTopic.value, token: nTok.value, downSec: Number(nDown.value), events: Object.fromEntries(Object.entries(evs).map(([k, i]) => [k, i.checked])) },
    backup: { enabled: bOn.checked, everyMin: Number(bEvery.value), keep: Number(bKeep.value) },
  });
  const row = (el, text) => h('label', { class: 'check' }, el, text);
  return h('div', { class: 'stack', style: 'gap:16px' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Warteschlange automatisch sortieren'),
      h('p', { class: 'small muted' }, 'Läuft von selbst: Priorisierte Songs bleiben, alle anderen werden sanft umsortiert. Fair bleibt es, weil nur die ersten Wünsche in der Reihe betrachtet werden.'),
      row(aoOn, 'Automatische Ordnung an'),
      h('div', { class: 'grid two' },
        h('label', { class: 'field' }, 'Genre-Balance: höchstens so viele gleiche Genre-Familien hintereinander', maxRep),
        h('label', { class: 'field' }, 'Betrachtete Wünsche pro Platz (Fairness-Fenster)', win)),
      row(moodOn, 'Stimmungskurve verwenden'),
      h('div', { class: 'small muted' }, 'Stimmungskurve: Zu jeder Uhrzeit können Genres bevorzugt werden (nur Vorrang, nichts wird abgelehnt).'),
      phaseBox,
      h('label', { class: 'field' }, 'Zeitzone der Party', tz)),
    h('div', { class: 'grid two' },
      h('div', { class: 'card stack' }, h('h2', {}, 'Smarter Übergang'), row(smart, 'Auto-Crossfade beginnt, wenn der Song ausklingt'),
        h('p', { class: 'small muted' }, 'Nutzt Intro-/Outro-Zeiten aus Spotify (falls für eure App verfügbar). Sonst gilt die feste Vorlaufzeit aus der Technik-Ansicht.')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Lückenfüller'), row(fOn, 'Bei leerer Warteschlange automatisch Songs einreihen'),
        h('label', { class: 'field' }, 'Playlist (öffentlich oder dein eigenes Konto)', fPl),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Auffüllen, wenn weniger als'), fMin, h('span', { class: 'small muted' }, 'Songs warten · Wiederholung frühestens nach'), fAvoid, h('span', { class: 'small muted' }, 'Min.')))),
    h('div', { class: 'card stack' }, h('h2', {}, '🆘 Notfall-Playlist'), h('p', { class: 'small muted' }, 'Ein Knopf in der Technik stoppt alles und startet diese Playlist (gemischt) – falls etwas ausfällt.'),
      h('div', { class: 'grid two' }, h('label', { class: 'field' }, 'Playlist', ePl), h('label', { class: 'field' }, 'Auf Player', ePlayer)), row(eShuf, 'Gemischt abspielen')),
    h('div', { class: 'card stack' }, h('h2', {}, '🔔 Alarm aufs Handy (ntfy)'),
      h('p', { class: 'small muted' }, 'Die App meldet Probleme per ntfy – auf ntfy.sh oder deinem eigenen ntfy-Server. In der ntfy-App denselben Topic abonnieren (am besten einen schwer zu erratenden Namen wählen).'),
      row(nOn, 'Benachrichtigungen an'),
      h('div', { class: 'grid two' }, h('label', { class: 'field' }, 'Server', nUrl), h('label', { class: 'field' }, 'Topic', nTopic), h('label', { class: 'field' }, 'Zugriffstoken (nur bei geschütztem Server)', nTok),
        h('label', { class: 'field' }, 'Alarm erst nach … Sekunden Störung', nDown)),
      h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'eyebrow' }, 'Wann alarmieren?'), ...Object.keys(evs).map((k) => row(evs[k], EVLABEL[k] || k))),
      h('div', { class: 'row' }, h('button', { onclick: safe(async () => { await saveAll(); await api('/admin/notify/test', { method: 'POST', body: {} }); toast('Test gesendet – schau aufs Handy'); }) }, 'Speichern & Test senden'))),
    h('div', { class: 'card stack' }, h('h2', {}, '💾 Automatische Backups'),
      row(bOn, 'Datenbank regelmäßig sichern'),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'alle'), bEvery, h('span', { class: 'small muted' }, 'Minuten · behalte die letzten'), bKeep),
      bList,
      h('div', { class: 'row' }, h('button', { onclick: safe(async () => { const b = await api('/admin/backups', { method: 'POST', body: {} }); toast(`Gesichert: ${b.name}`); loadBackups(); }) }, 'Jetzt sichern'),
        h('span', { class: 'small muted' }, 'Wiederherstellen: Datei als „party.db“ ins Datenverzeichnis legen, App neu starten.'))),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: saveAll }, 'Alles speichern')));
}

// ---------- Design ----------
function viewDesign() {
  const b = data.settings.brand;
  const name = h('input', { value: b.name, maxlength: 40 }), tag = h('input', { value: b.tagline, maxlength: 90, placeholder: 'z. B. Sommerfest 2026' });
  const color = h('input', { type: 'color', value: b.accent || '#0b0b0c', style: 'width:64px;padding:2px;height:42px' });
  let useColor = !!b.accent;
  const colorState = h('span', { class: 'small muted' }, b.accent ? b.accent : 'Standard (Schwarz/Weiß)');
  color.addEventListener('input', () => { useColor = true; colorState.textContent = color.value; });
  const logoBox = h('div', { class: 'logo-prev' });
  const hasLogo = !!document.documentElement.dataset.brandLogo;
  logoBox.append(hasLogo ? h('img', { src: document.documentElement.dataset.brandLogo, alt: 'Logo' }) : h('span', { class: 'muted small' }, 'kein Logo'));
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', style: 'display:none', onchange: async () => {
    const f = file.files[0]; if (!f) return;
    try {
      const res = await fetch(`${BASE}/api/admin/brand/logo`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f, credentials: 'same-origin' });
      const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || `Fehler ${res.status}`);
      toast('Logo gespeichert – Seite neu laden'); setTimeout(() => location.reload(), 600);
    } catch (e) { toast(e.message, true); }
  } });
  return h('div', { class: 'grid two' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Name & Farbe'),
      h('label', { class: 'field' }, 'Name der Veranstaltung', name), h('label', { class: 'field' }, 'Untertitel', tag),
      h('div', { class: 'row' }, h('label', { class: 'field' }, 'Akzentfarbe (Buttons, Zähler …)', color), colorState,
        h('button', { class: 'small ghost', onclick: () => { useColor = false; colorState.textContent = 'Standard (Schwarz/Weiß)'; } }, 'Zurücksetzen')),
      h('p', { class: 'small muted' }, 'Wirkt auf Gäste-Seite, Beamer, Poster, Moderation und PDF. Im Dunkelmodus wird die Farbe automatisch aufgehellt.'),
      h('button', { class: 'primary', onclick: async () => { await save({ brand: { name: name.value, tagline: tag.value, accent: useColor ? color.value : '' } }, 'Design gespeichert – Seite neu laden'); setTimeout(() => location.reload(), 600); } }, 'Speichern')),
    h('div', { class: 'card stack' }, h('h2', {}, 'Logo'), logoBox, file,
      h('p', { class: 'small muted' }, 'PNG, JPG, WebP oder SVG, bis 1 MB. Quadratisch oder mit transparentem Hintergrund sieht es am besten aus.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => file.click() }, 'Logo hochladen'),
        hasLogo ? h('button', { onclick: safe(async () => { await api('/admin/brand/logo/remove', { method: 'POST', body: {} }); toast('Logo entfernt'); setTimeout(() => location.reload(), 500); }) }, 'Entfernen') : null)));
}

// ---------- QR & Poster ----------
function viewPoster() {
  const t = data.settings.test;
  const target = h('select', {}, h('option', { value: 'live' }, 'Live – Gäste-Seite'), t.enabled ? h('option', { value: 'test' }, 'Testmodus – Gäste-Seite') : null);
  const head = h('input', { value: document.documentElement.dataset.brandTag || 'Wünsch dir was!', maxlength: 40 });
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
  const pdf = h('a', { class: 'btn', href: `${BASE}/api/admin/setlist.pdf?env=live` }, '⬇ Setlist als PDF');
  async function run() {
    csv.href = `${BASE}/api/admin/setlist.csv?env=${envSel.value}`; pdf.href = `${BASE}/api/admin/setlist.pdf?env=${envSel.value}`;
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
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, envSel, pdf, csv), out);
}

// ---------- Funktionen: alles einzeln an-/ausschaltbar ----------
function viewFeatures() {
  const { list, groups, flags } = data.features;
  const sw = (f) => {
    const inp = h('input', { type: 'checkbox', checked: flags[f.id], role: 'switch', 'aria-label': f.label });
    inp.addEventListener('change', safe(async () => { await api('/admin/settings', { method: 'POST', body: { features: { [f.id]: inp.checked } } }); flags[f.id] = inp.checked; toast(`${f.label}: ${inp.checked ? 'an' : 'aus'}`); row.classList.toggle('off', !inp.checked); counter(); }));
    const row = h('label', { class: `feat ${flags[f.id] ? '' : 'off'}` }, h('span', { class: 'switch' }, inp, h('i')), h('span', { class: 'grow' }, h('b', {}, f.label), h('span', { class: 'small muted' }, f.desc)));
    return row;
  };
  const cnt = h('span', { class: 'badge' });
  const counter = () => { const n = list.filter((f) => flags[f.id]).length; cnt.textContent = `${n} von ${list.length} an`; };
  counter();
  const bulk = (ids, on) => safe(async () => { await api('/admin/settings', { method: 'POST', body: { features: Object.fromEntries(ids.map((id) => [id, on])) } }); toast(on ? 'Eingeschaltet' : 'Ausgeschaltet'); await load(); });
  const v = data.settings.voting, lim = data.settings.limits, pz = data.settings.pause;
  const vPer = num(v.votesPerWindow, { min: 1, max: 100, class: 'num' }), vWin = num(v.windowMin, { min: 1, max: 600, class: 'num' }), vSort = chk(v.sortByVotes);
  const gain = num(Math.round(lim.maxGain * 100), { min: 30, max: 100, class: 'num' }), maxSong = num(Math.round(lim.maxSongSec / 60 * 10) / 10, { min: 0, max: 30, step: 0.5, class: 'num' });
  const pmsg = h('input', { value: pz.message, maxlength: 120 });
  const HOMES = [['', 'Standard'], ['/mod', 'Moderation'], ['/tech', 'Technik'], ['/stage', 'Bühne'], ['/light', 'Licht'], ['/focus', 'Fokus-Modus'], ['/ticker', 'Live-Wünsche'], ['/board', 'Board'], ['/foh', 'Anzeige'], ['/analytics', 'Analytics']];
  const homes = Object.fromEntries(['tech', 'mod', 'orga', 'display', 'light'].map((r) => [r, h('select', {}, ...HOMES.map(([val, l]) => h('option', { value: val, selected: (data.settings.roleHome?.[r] || '') === val }, l)))]));
  const ROLE = { tech: 'Technik', mod: 'Moderation', orga: 'Orga', display: 'FOH-Anzeige', light: 'Lichttechnik' };
  return h('div', { class: 'stack', style: 'gap:16px' },
    h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h2', {}, 'Funktionen & Ansichten'), cnt),
      h('p', { class: 'small muted' }, 'Hier schaltest du jede Funktion, Ansicht und jeden Effekt einzeln an oder aus – nur der Admin kann das. Ausgeschaltetes ist auch serverseitig gesperrt, nicht nur versteckt. Änderungen gelten sofort (Seiten ggf. neu laden).')),
    ...Object.entries(groups).map(([gid, gname]) => {
      const fs = list.filter((f) => f.group === gid);
      return h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', {}, gname), h('div', { class: 'row' }, h('button', { class: 'small', onclick: bulk(fs.map((f) => f.id), true) }, 'Alle an'), h('button', { class: 'small', onclick: bulk(fs.map((f) => f.id), false) }, 'Alle aus'))),
        h('div', { class: 'feat-list' }, ...fs.map(sw)));
    }),
    h('div', { class: 'grid two' },
      h('div', { class: 'card stack' }, h('h2', {}, 'Wunsch-Voting'),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Pro Gerät höchstens'), vPer, h('span', { class: 'small muted' }, '„+1“ in'), vWin, h('span', { class: 'small muted' }, 'Min.')),
        h('label', { class: 'check' }, vSort, 'Beliebteste Wünsche zuerst zeigen (Gäste & Moderation)')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Technik-Grenzen'),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Fader-Limit (nur wenn „Sicherheits-Fader-Limit“ an):'), gain, h('span', { class: 'small muted' }, '%')),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Song-Bremse (nur wenn an): Übergang spätestens nach'), maxSong, h('span', { class: 'small muted' }, 'Min. (0 = nie)')),
        h('label', { class: 'field' }, 'Text im Pausen-Modus', pmsg)),
      h('div', { class: 'card stack' }, h('h2', {}, 'Startseite nach der Anmeldung'),
        ...Object.entries(homes).map(([r, sel]) => h('label', { class: 'field' }, ROLE[r], sel)))),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => save({
      voting: { votesPerWindow: Number(vPer.value), windowMin: Number(vWin.value), sortByVotes: vSort.checked },
      limits: { maxGain: Number(gain.value) / 100, maxSongSec: Math.round(Number(maxSong.value) * 60) }, pause: { message: pmsg.value },
      roleHome: Object.fromEntries(Object.entries(homes).map(([r, sel]) => [r, sel.value])),
    }) }, 'Feineinstellungen speichern')));
}

// ---------- VPN (WireGuard-Verwaltung) ----------
function viewVpn() {
  const box = h('div', { class: 'stack', style: 'gap:16px' });
  const ago = (s) => (s == null ? 'noch nie' : s < 60 ? `vor ${s} s` : s < 3600 ? `vor ${Math.round(s / 60)} Min.` : `vor ${Math.round(s / 3600)} Std.`);
  const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  const showConfig = async (name, text) => {
    const qr = await qrElement(text, { size: 260 }).catch(() => null);
    const close = modal([h('h2', {}, `Konfiguration: ${name}`),
      h('p', { class: 'small muted' }, 'Enthält den privaten Schlüssel. Nur für das Gerät „' + name + '“ verwenden. Mit dem Handy den QR-Code in der WireGuard-App scannen, oder als Datei importieren.'),
      qr, h('textarea', { rows: 9, readonly: true, style: 'font-family:ui-monospace,monospace;font-size:.78rem' }, text),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, download: `${name}.conf` }, '⬇ Als Datei'), h('button', { class: 'primary', onclick: () => close() }, 'Fertig'))]);
  };
  async function paint() {
    let d;
    try { d = await api('/admin/vpn'); } catch (e) { clear(box).append(h('div', { class: 'card stack' }, h('h2', {}, 'VPN-Verwaltung nicht erreichbar'), h('p', { class: 'small' }, e.message),
      h('p', { class: 'small muted' }, 'Einrichtung: In der .env des Servers WGCTL_TOKEN=<zufälliger Wert> setzen (z. B. mit „openssl rand -hex 24“), dann „docker compose up -d --build“. Es muss docker-compose.vpn.yml aktiv sein (COMPOSE_FILE).'))); return; }
    const name = h('input', { placeholder: 'Name, z. B. handy, laptop-anna', maxlength: 20 });
    const behind = h('input', { type: 'checkbox' });
    clear(box).append(
      h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, 'WireGuard-Server'), h('span', { class: 'badge ok' }, 'läuft')),
        h('p', { class: 'small muted' }, `Adresse: ${d.server.endpoint || '(WG_SERVERURL fehlt)'} · Tunnelnetz 10.8.0.0/24 · Geräte hinter dem Pi (z. B. X32): 10.8.0.192–255`)),
      h('div', { class: 'card stack' }, h('h2', {}, 'Geräte'),
        h('div', { class: 'list' }, ...d.peers.map((p) => h('div', { class: 'item row between' },
          h('div', {}, h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: `dot ${p.online ? 'ok' : ''}` }), h('b', {}, p.name), h('span', { class: 'mono small muted' }, p.ip)),
            h('div', { class: 'tiny muted' }, `${p.online ? 'verbunden' : 'offline'} · Handshake ${ago(p.handshakeAgoSec)} · ↓ ${kb(p.rx)} ↑ ${kb(p.tx)}${p.endpoint ? ` · ${p.endpoint}` : ''}${p.allowedIps.length > 1 ? ' · mit Geräten dahinter' : ''}`)),
          h('div', { class: 'row' },
            p.hasConfig ? h('button', { class: 'small', onclick: safe(async () => { const r = await fetch(`${BASE}/api/admin/vpn/peers/${encodeURIComponent(p.name)}/config`, { credentials: 'same-origin' }); if (!r.ok) throw new Error('Konfiguration nicht verfügbar'); showConfig(p.name, await r.text()); }) }, 'Konfiguration') : null,
            h('button', { class: 'small bad', onclick: safe(async () => { if (!confirm(`Gerät „${p.name}“ entfernen? Es verliert sofort den Zugang.`)) return; await api(`/admin/vpn/peers/${encodeURIComponent(p.name)}`, { method: 'DELETE' }); toast('Entfernt'); paint(); }) }, 'Entfernen')))))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Neues Gerät hinzufügen'),
        h('div', { class: 'row' }, name, h('button', { class: 'primary', onclick: safe(async () => { const o = await api('/admin/vpn/peers', { method: 'POST', body: { name: name.value, behind: behind.checked } }); toast(`${o.name} angelegt (${o.ip})`); await paint(); showConfig(o.name, o.config); }) }, 'Anlegen')),
        h('label', { class: 'check' }, behind, 'Hinter diesem Gerät liegen weitere Geräte (z. B. Pi mit X32): Adressen 10.8.0.192–255 hierhin leiten'),
        h('p', { class: 'small muted' }, 'Danach QR-Code mit der WireGuard-App scannen (Handy) oder die Datei importieren (PC, Pi). Bitte Peers nur hier verwalten, nicht von Hand in der Konfiguration.')));
  }
  paint();
  return box;
}

// ---------- Sicherheit ----------
function viewSecurity() {
  const sec = data.settings.security;
  const box = h('div', { class: 'stack', style: 'gap:16px' });
  const idle = num(sec.idleMinutes, { min: 5, max: 1440, class: 'num' }), maxH = num(sec.maxHours, { min: 1, max: 72, class: 'num' });
  const api1 = num(sec.apiPerMin, { min: 60, max: 5000, class: 'num' }), flood = num(sec.floodPerMin, { min: 5, max: 500, class: 'num' });
  const ips = h('textarea', { rows: 3, placeholder: 'z. B. 192.168.1.0/24 (leer = überall erlaubt)' }); ips.value = (sec.adminIpAllow || []).join('\n');
  const only = chk(sec.adminPasskeyOnly);
  const pw = { cur: h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Aktuelles Passwort' }), n1: h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Neues Passwort (mind. 12 Zeichen)' }) };
  async function paint() {
    const d = await api('/admin/security');
    const pkList = h('div', { class: 'list' }, ...(d.passkeys.length ? d.passkeys.map((p) => h('div', { class: 'item row between' },
      h('div', {}, h('b', {}, p.label), h('div', { class: 'tiny muted' }, `${p.role === 'admin' ? 'Head-Admin' : `Code #${p.accountId}`} · angelegt ${new Date(p.createdAt).toLocaleDateString('de-DE')}${p.lastUsed ? ` · zuletzt ${new Date(p.lastUsed).toLocaleString('de-DE')}` : ''}${p.backedUp ? ' · synchronisiert' : ''}`)),
      h('button', { class: 'small bad', onclick: safe(async () => { if (confirm(`Passkey „${p.label}“ löschen?`)) { await api(`/passkey/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); paint(); } }) }, 'Löschen'))) : [h('div', { class: 'muted small' }, 'Noch keine Passkeys.')]));
    const label = h('input', { value: (navigator.userAgentData?.platform || 'Dieses Gerät').slice(0, 30), maxlength: 40 });
    clear(box).append(
      h('div', { class: 'card stack' }, h('h2', {}, '🔑 Passkeys'),
        h('p', { class: 'small muted' }, 'Anmeldung per Fingerabdruck, Gesicht oder Geräte-PIN – nichts zum Abtippen und nicht abfangbar. Mitarbeitende registrieren ihren Passkey selbst (Schlüssel-Symbol 🔑 oben in der Leiste); hier siehst und löschst du alle.'),
        passkeysSupported() ? h('div', { class: 'row' }, label, h('button', { class: 'primary', onclick: safe(async () => { await passkeyRegister(label.value); toast('Passkey gespeichert'); paint(); }) }, 'Passkey für dieses Gerät anlegen')) : h('div', { class: 'small muted' }, 'Dieser Browser/diese Adresse unterstützt keine Passkeys (HTTPS nötig) oder die Funktion ist ausgeschaltet.'),
        pkList,
        h('label', { class: 'check' }, only, 'Admin-Login NUR mit Passkey (Passwort wird für Admin gesperrt)'),
        h('p', { class: 'small muted' }, `Admin-Passkeys: ${d.adminPasskeys}. Erst einschalten, wenn mindestens ein Passkey funktioniert. Notfall: Server mit Umgebungsvariable ADMIN_RECOVERY=1 starten – dann geht das Passwort wieder.`)),
      h('div', { class: 'grid two' },
        h('div', { class: 'card stack' }, h('h2', {}, 'Sitzungen & Limits'),
          h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Abmelden nach'), idle, h('span', { class: 'small muted' }, 'Min. Inaktivität · spätestens nach'), maxH, h('span', { class: 'small muted' }, 'Std.')),
          h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Anfragen pro Minute und Adresse (Team)'), api1),
          h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Flut-Alarm ab'), flood, h('span', { class: 'small muted' }, 'Wünschen pro Minute')),
          h('label', { class: 'field' }, `Admin nur von diesen Adressen (deine: ${d.yourIp})`, ips),
          h('button', { class: 'primary', onclick: () => save({ security: { idleMinutes: Number(idle.value), maxHours: Number(maxH.value), apiPerMin: Number(api1.value), floodPerMin: Number(flood.value), adminPasskeyOnly: only.checked, adminIpAllow: ips.value.split('\n').map((x) => x.trim()).filter(Boolean) } }) }, 'Speichern'),
          h('p', { class: 'small muted' }, 'Achtung bei der Adressliste: Trägst du dich aus, sperrst du dich aus (Notfall: ADMIN_RECOVERY=1 hebt Passkey-Pflicht auf; die Adressliste leerst du dann in der Datenbank/mit neuem Start ohne Liste).')),
        h('div', { class: 'card stack' }, h('h2', {}, 'Admin-Passwort ändern'), pw.cur, pw.n1,
          h('button', { onclick: safe(async () => { await api('/admin/security/password', { method: 'POST', body: { current: pw.cur.value, next: pw.n1.value } }); pw.cur.value = pw.n1.value = ''; toast('Passwort geändert – alle anderen Sitzungen beendet'); paint(); }) }, 'Ändern'))),
      h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, 'Aktive Anmeldungen'),
        h('button', { class: 'small bad', onclick: safe(async () => { if (confirm('Alle anderen Geräte abmelden?')) { const o = await api('/admin/security/sessions/revoke-all', { method: 'POST', body: {} }); toast(`${o.count} abgemeldet`); paint(); } }) }, 'Alle anderen abmelden')),
        h('div', { class: 'list' }, ...d.sessions.map((s) => h('div', { class: 'item row between' },
          h('div', {}, h('b', {}, s.label), s.current ? h('span', { class: 'badge ok', style: 'margin-left:6px' }, 'du') : null, h('div', { class: 'tiny muted' }, `${s.role} · ${s.ip || '?'} · zuletzt ${s.lastSeen ? fmtClock(s.lastSeen) : '–'} · ${String(s.ua || '').slice(0, 60)}`)),
          s.current ? null : h('button', { class: 'small', onclick: safe(async () => { await api(`/admin/security/sessions/${s.id}/revoke`, { method: 'POST', body: {} }); paint(); }) }, 'Abmelden'))))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Sicherheitsprotokoll'), h('p', { class: 'small muted' }, 'Die letzten Ereignisse (Anmeldungen, Fehlversuche, Änderungen). Nur für dich sichtbar.'),
        h('div', { class: 'list', style: 'max-height:420px;overflow:auto' }, ...d.audit.map((a) => h('div', { class: 'item row between nowrap' },
          h('div', {}, h('b', { class: /fail|blocked|locked/.test(a.kind) ? 'bad-t' : '' }, a.kind), h('div', { class: 'tiny muted' }, `${a.who || ''} ${a.ip ? `· ${a.ip}` : ''} ${a.detail ? `· ${a.detail}` : ''}`)),
          h('span', { class: 'tiny muted' }, new Date(a.ts).toLocaleString('de-DE')))))));
  }
  paint().catch((e) => toast(e.message, true));
  return box;
}

function render() {
  drawTabs();
  clear(body).append({ start: viewStart, funktionen: viewFeatures, sicherheit: viewSecurity, vpn: viewVpn, automatik: viewAutomation, design: viewDesign, poster: viewPoster, einstellungen: viewSettings, codes: viewCodes, verbindungen: viewConnections, bericht: viewReport }[tab]());
}

app.append(topbar('Admin', { live: false, nav: true }), h('div', { class: 'wrap' }, tabBar, body));
addEventListener('hashchange', () => { const t = location.hash.slice(1); if (tabs.includes(t) && t !== tab && data) { tab = t; render(); } });
load().catch((e) => toast(e.message, true));
