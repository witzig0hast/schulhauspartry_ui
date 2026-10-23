import { h, api, BASE, topbar, clear, safe, toast, modal, qrElement, $, fmtClock, passkeysSupported, passkeyRegister } from '/assets/app.js';
import { ampel } from '/assets/staff-ui.js';
import { autoHelp } from '/assets/help.js';
import { openLevels } from '/assets/levels.js';
import { x32AddressBox, openX32Setup } from '/assets/x32setup.js';

const app = $('#app');
let data = null;
// Tabs in Gruppen: was man waehrend der Party braucht zuerst, Technik und Auswertung hinten
const TAB_GROUPS = [
  ['Party', ['start', 'einstellungen', 'automatik', 'design', 'poster']],
  ['Zugang', ['codes', 'sicherheit', 'funktionen']],
  ['Technik', ['verbindungen', 'ki', 'vpn', 'livetest', 'probe']],
  ['Auswertung', ['bericht']],
];
const tabs = TAB_GROUPS.flatMap(([, t]) => t);
const tabLabels = { start: 'Start & Links', funktionen: 'Funktionen', sicherheit: 'Sicherheit', vpn: 'VPN', automatik: 'Automatik', design: 'Design', poster: 'QR & Poster', einstellungen: 'Wünsche & Regeln', codes: 'Codes', verbindungen: 'Verbindungen', ki: 'KI', livetest: 'Live-Test', probe: 'Generalprobe', bericht: 'Bericht & Export' };
const TAB_INTRO = {
  start: 'Betriebsart, Abend-Start, alle Links und das Zurücksetzen.',
  einstellungen: 'Wie viele Wünsche Gäste haben, welche Songs erlaubt sind und welche Texte sie sehen.',
  automatik: 'Was die App von selbst erledigt: sortieren, auffüllen, Start-Playlist, Notfall, Alarme, Backups.',
  design: 'Name, Farbe und Logo der Veranstaltung.',
  poster: 'QR-Code und Plakat zum Ausdrucken.',
  codes: 'Zugänge für das Team: anlegen, sperren, mit SSO verbinden.',
  sicherheit: 'Schutz vor Überlastung, SSO, Passkeys, Sitzungen und das Sicherheitsprotokoll.',
  funktionen: 'Jede Funktion und Ansicht einzeln an- oder ausschalten.',
  verbindungen: 'Spotify-Konten und die Anbindung an Pi und X32.',
  vpn: 'Geräte für den WireGuard-Server (Pi, PC, Handy).',
  ki: 'Eigener Ollama-Server mit einem Modell: Energie-Kurve, Songvorschläge, Licht-Vorschläge, Fehler-Assistent und Rückblick.',
  livetest: 'Vor der Party jede Funktion mit dem echten Setup durchspielen: Player, Pult, Mics, Handy, Beamer, Not-Aus.',
  probe: 'Simulierte Party im Testmodus: Hält das System viele Gäste aus?',
  bericht: 'Zahlen zur Party, Setlist als PDF und CSV.',
};
let tab = tabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'start';
const body = h('div');
const tabBar = h('div', { class: 'tabs' });

const field = (label, input) => h('label', { class: 'field' }, label, input);
const save = (patch, msg = 'Gespeichert') => safe(async () => { await api('/admin/settings', { method: 'POST', body: patch }); toast(msg); await load(); })();
const num = (v, extra = {}) => h('input', { type: 'number', value: v, ...extra });
const origin = () => location.origin;

async function load() {
  data = await api('/admin/settings');
  { const t = location.hash.slice(1); if (tabs.includes(t)) tab = t; }
  render();
}

function drawTabs() {
  clear(tabBar).append(...TAB_GROUPS.map(([g, ts]) => h('div', { class: 'tab-group', role: 'group', 'aria-label': g }, h('span', { class: 'tab-group-l' }, g),
    ...ts.map((t) => h('button', { class: t === tab ? 'active' : '', 'aria-current': t === tab ? 'page' : null, onclick: () => { tab = t; location.hash = t; render(); } }, tabLabels[t])))));
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
  const role = h('select', { 'aria-label': 'Rolle' }, ...data.roles.map((r) => h('option', { value: r.id }, r.label)));
  const label = h('input', { placeholder: 'Bezeichnung (z. B. Mod Lisa)', maxlength: 40 });
  // Startansicht: welche Ansicht/welches Dashboard der Code nach dem Login sieht (nur was die Rolle darf)
  const viewLabel = (p) => data.startViews.find((v) => v.path === p)?.label || p;
  const viewOptions = (roleId, current = '') => [h('option', { value: '' }, 'Standard der Rolle'), ...(data.roles.find((r) => r.id === roleId)?.views || []).map((p) => h('option', { value: p, selected: p === current }, viewLabel(p)))];
  const home = h('select', { 'aria-label': 'Startansicht' }, ...viewOptions(role.value));
  role.addEventListener('change', () => clear(home).append(...viewOptions(role.value)));
  const table = h('div', { class: 'card', style: 'overflow-x:auto' });
  async function refresh() {
    const { accounts } = await api('/admin/accounts');
    clear(table).append(h('table', {},
      h('thead', {}, h('tr', {}, ...['Bezeichnung', 'Rolle', 'Startansicht', 'Angenommen', 'Abgelehnt', 'Priorisiert', 'Zuletzt', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...accounts.map((a) => h('tr', {},
        h('td', {}, h('strong', {}, a.label), a.sso ? h('span', { class: 'badge', style: 'margin-left:6px', title: 'Konto wurde über SSO angelegt' }, 'SSO') : null, a.ssoLinked ? h('span', { class: 'badge ok', style: 'margin-left:6px', title: 'Mit einem SSO-Konto verbunden' }, 'SSO verbunden') : null, a.email ? h('div', { class: 'tiny muted' }, a.email) : null, a.revoked ? h('span', { class: 'badge bad', style: 'margin-left:6px' }, 'gesperrt') : null),
        h('td', {}, a.roleLabel),
        h('td', {}, a.role === 'admin' ? '–' : h('select', { class: 'small', 'aria-label': `Startansicht ${a.label}`, onchange: safe(async (e) => { await api(`/admin/accounts/${a.id}/home`, { method: 'POST', body: { home: e.target.value } }); toast('Startansicht gespeichert'); }) }, ...viewOptions(a.role, a.home || ''))),
        h('td', {}, a.approved), h('td', {}, a.denied), h('td', {}, a.prioritized), h('td', {}, a.last_seen ? fmtClock(a.last_seen) : '–'),
        h('td', {}, h('div', { class: 'row' },
          h('button', { class: 'small', onclick: safe(async () => { const { decisions } = await api(`/admin/accounts/${a.id}/decisions`); showDecisions(a, decisions); }) }, 'Entscheidungen'),
          !a.sso ? h('button', { class: 'small ghost', title: 'E-Mail für die automatische SSO-Zuordnung', onclick: safe(async () => { const e = prompt('E-Mail-Adresse dieser Person im SSO (leer = entfernen):', a.email || ''); if (e == null) return; await api(`/admin/accounts/${a.id}/email`, { method: 'POST', body: { email: e } }); refresh(); }) }, 'E-Mail') : null,
          a.ssoLinked ? h('button', { class: 'small', onclick: safe(async () => { if (!confirm(`SSO-Verbindung von „${a.label}“ lösen?`)) return; await api(`/admin/accounts/${a.id}/sso`, { method: 'DELETE' }); refresh(); }) }, 'SSO lösen') : null,
          !a.revoked ? h('button', { class: 'small', onclick: safe(async () => { await api(`/admin/accounts/${a.id}/revoke`, { method: 'POST', body: {} }); refresh(); }) }, 'Sperren') : null,
          h('button', { class: 'small bad', onclick: safe(async () => { if (!confirm(`Code "${a.label}" endgültig löschen?`)) return; await api(`/admin/accounts/${a.id}`, { method: 'DELETE' }); refresh(); }) }, 'Löschen'))))))));
  }
  refresh();
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Neuen Code erstellen'),
      h('p', { class: 'small muted' }, 'Mit „Startansicht“ landet ein Code direkt in seinem Dashboard – z. B. ein Technik-Code für die Tonleute im Ton-Dashboard, einer für das Licht im Licht-Dashboard.'),
      h('div', { class: 'row' }, role, label, home, h('button', { class: 'primary', onclick: safe(async () => {
        const out = await api('/admin/accounts', { method: 'POST', body: { role: role.value, label: label.value, home: home.value } });
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
  const apps = s.spotify.apps || [];
  const appName = (id) => apps.find((a) => a.id === id)?.name || (id === 'env' ? 'App aus .env' : apps[0]?.name || '');
  const playerBox = (n) => {
    const p = s.spotify.players[n];
    const appSel = h('select', { 'aria-label': `Spotify-App für Player ${n}` }, ...apps.filter((a) => a.clientId && a.clientSecret).map((a) => h('option', { value: a.id, selected: a.id === p.appId }, a.name)));
    const devSel = h('select', {}, h('option', { value: p.deviceId }, p.deviceName || (p.deviceId ? p.deviceId : 'Aktives Gerät (automatisch)')));
    return h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, `Player ${n}`), h('span', { class: `badge ${p.connected ? 'ok' : ''}` }, p.connected ? `verbunden: ${p.user || ''}` : 'nicht verbunden')),
      p.connected ? h('div', { class: 'small muted' }, `über App: ${appName(p.appId)}`) : null,
      apps.length > 1 ? field('Verbinden über App', appSel) : null,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: safe(async () => { const { url } = await api('/admin/spotify/connect', { method: 'POST', body: { player: n, appId: appSel.value } }); location.href = url; }) }, p.connected ? 'Neu verbinden' : 'Mit Spotify verbinden'),
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
  const x32Addr = x32AddressBox(s, save);
  const faderSpeed = h('select', {}, ...[['sanft', 'Sanft (schont den Motor am meisten)'], ['normal', 'Normal (empfohlen)'], ['schnell', 'Schnell (folgt kurzen Blenden genau)']].map(([v, t]) => h('option', { value: v, selected: (s.x32.faderSpeed || 'normal') === v }, t)));
  const ch = s.x32.channels;
  const chIn = (v, i) => num(v[i] ?? '', { min: 1, max: 32, class: 'num', placeholder: '–' });
  const p1 = [chIn(ch.p1, 0), chIn(ch.p1, 1)], p2 = [chIn(ch.p2, 0), chIn(ch.p2, 1)], mics = [0, 1, 2].map((i) => chIn(ch.mics, i));
  const micNames = [0, 1, 2].map((i) => h('input', { value: (s.x32.micNames || [])[i] || `Mic ${i + 1}`, maxlength: 24, 'aria-label': `Name Mikro ${i + 1}` }));
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Status'),
      ...Object.entries(data.connections).map(([env, c]) => h('div', { class: 'stack' }, h('strong', {}, env === 'live' ? 'Live' : 'Testmodus'), ampel(c)))),
    spotifyAppsCard(apps),
    h('div', { class: 'card stack' }, h('h2', {}, 'Spotify-API-Auslastung'),
      h('p', { class: 'small muted' }, 'Spotify begrenzt Anfragen pro App (gleitendes 30-Sekunden-Fenster) und lässt sich nicht abschalten. Die App bleibt deshalb weit darunter: Suchergebnisse werden gemerkt, gleiche Anfragen zusammengefasst, der Player-Status nur bei Bedarf abgefragt. Steuerbefehle haben Vorrang. Meldet Spotify doch ein Limit, pausiert die App automatisch und der Cache übernimmt.'),
      apiInfo ? h('div', { class: 'stack', style: 'gap:8px' },
        h('div', { class: 'row between small' }, h('span', {}, `${apiInfo.used} von ${apiInfo.budget} Anfragen in den letzten ${apiInfo.windowSec} s`), apiInfo.pausedSec ? h('span', { class: 'badge warn' }, `Limit – Pause ${apiInfo.pausedSec} s`) : h('span', { class: 'badge ok' }, 'in Ordnung')),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, Math.round(100 * apiInfo.used / apiInfo.budget))}%` })),
        h('div', { class: 'small muted' }, `Seit Start: ${apiInfo.total} Anfragen · ${apiInfo.cacheHits} aus dem Cache · ${apiInfo.coalesced} zusammengefasst · ${apiInfo.rate429} × Limit von Spotify`),
        ...(apiInfo.apps?.length > 1 ? apiInfo.apps.map((a) => h('div', { class: 'stack', style: 'gap:4px' },
          h('div', { class: 'row between small' }, h('span', {}, `${a.name}${a.search ? '' : ' (nur Player)'}`), h('span', { class: a.pausedSec ? 'badge warn' : 'muted' }, a.pausedSec ? `Pause ${a.pausedSec} s` : `${a.used}/${a.budget}`)),
          h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, Math.round(100 * a.used / a.budget))}%` })))) : []))
        : h('div', { class: 'small muted' }, 'Sobald echte Spotify-Verbindungen aktiv sind, erscheint hier die Auslastung.'),
      apiCacheBox(data.apiCache),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Eigenes Budget'), budget, h('span', { class: 'small muted' }, 'Anfragen pro 30 s und App (Standard 60)'),
        h('button', { class: 'small', onclick: () => save({ spotify: { apiBudget: Number(budget.value) } }) }, 'Speichern'))),
    h('div', { class: 'grid two' }, playerBox(1), playerBox(2)),
    companionCard(),
    h('div', { class: 'card stack' }, h('h2', {}, 'X32 / Pi 5'),
      field('Anbindung', adapter), field('Pi-URL(s) des Relays', piUrl), field('Token', piToken),
      h('div', { class: 'eyebrow' }, 'Adresse des X32 im Veranstaltungsnetz'),
      h('p', { class: 'small muted' }, 'Der Pi spricht mit dem Pult über diese IP-Adresse (Setup → Network am X32). Sie gilt sofort, ohne die .env des Pi zu ändern, und bleibt auch nach einem Neustart des Pi erhalten. Leer lassen = die Adresse aus der .env des Pi. „Im Netz suchen“ findet Pulte im selben Netz wie der Pi.'),
      x32Addr.el,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => openX32Setup({ settings: s, save }) }, 'X32 einrichten (Assistent)'), h('span', { class: 'small muted' }, 'Kanäle per Pegel erkennen, Namen vom Pult, Fader-Tempo, sanfter Fader-Test')),
      h('div', { class: 'eyebrow' }, 'Kanalzuordnung am X32 (Eingangskanäle 1–32)'),
      h('p', { class: 'small muted' }, 'Hier legst du fest, auf welchen X32-Kanälen die Player und Mikrofone liegen. Das gilt sofort und wird automatisch an den Pi weitergegeben – die Relay-.env musst du dafür nicht ändern. Ein Player hat 1 Kanal (Mono) oder 2 (Stereo links/rechts); leer lassen = nicht benutzt.'),
      h('div', { class: 'grid three' }, field('Player 1 (Kanal L / R)', h('div', { class: 'row' }, ...p1)), field('Player 2 (Kanal L / R)', h('div', { class: 'row' }, ...p2)), field('Mikrofon-Kanäle (bis zu 3)', h('div', { class: 'row' }, ...mics))),
      field('Namen der Mikrofone (so erscheinen sie in Technik und Anzeige)', h('div', { class: 'row' }, ...micNames)),
      field('Tempo der Motorfader', faderSpeed),
      h('button', { class: 'primary', onclick: () => save({ x32: { adapter: adapter.value, piUrl: piUrl.value, piToken: piToken.value, ...x32Addr.want(), faderSpeed: faderSpeed.value, micNames: micNames.map((i) => i.value), channels: { p1: p1.map((i) => i.value), p2: p2.map((i) => i.value), mics: mics.map((i) => i.value) } } }) }, 'Speichern'),
      h('p', { class: 'small muted' }, 'Echte Verbindungen (Spotify, Pi) nutzt immer nur die unter "Start & Links → Testmodus-Optionen" gewählte Umgebung; die andere läuft simuliert.')));
}

// Hardware-Knoepfe ueber Bitfocus Companion (Stream Deck): Token, Adressen, Anleitung
const COMPANION_ACTIONS = [['crossfade', 'Crossfade zum nächsten Song'], ['panic', 'NOT-AUS (2× innerhalb von 4 s)'], ['panic-clear', 'Not-Aus aufheben'], ['play-1', 'Player 1 Play'], ['pause-1', 'Player 1 Pause'], ['play-2', 'Player 2 Play'], ['pause-2', 'Player 2 Pause'],
  ['fade-in-1', 'P1 einblenden'], ['fade-out-1', 'P1 ausblenden'], ['fade-in-2', 'P2 einblenden'], ['fade-out-2', 'P2 ausblenden'], ['wishes-open', 'Wünsche öffnen'], ['wishes-pause', 'Wünsche pausieren'], ['wishes-close', 'Wünsche schließen'],
  ['pause-mode', 'Pausen-Modus an/aus'], ['auto-toggle', 'Auto-Crossfade an/aus'], ['ducking-toggle', 'Ducking an/aus'], ['emergency', 'Notfall-Playlist an/aus'], ['end', 'Ende-Modus an/aus']];
function companionCard() {
  if (!data.features.flags.companion) return h('span');
  const c = data.settings.companion;
  const base = `${data.publicUrl || origin()}`;
  const testBase = data.settings.test.enabled ? `${base}/${data.settings.test.prefix}` : null;
  const tokenBox = h('div');
  const copy = (t) => () => navigator.clipboard.writeText(t).then(() => toast('Kopiert'), () => toast(t));
  const urlRow = (label, url) => h('div', { class: 'linkrow' }, h('div', { class: 'lbl' }, label), h('div', { class: 'url' }, url), h('button', { class: 'small', onclick: copy(url) }, 'Kopieren'));
  return h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, 'Companion / Stream Deck'), h('span', { class: `badge ${c.enabled && c.hasToken ? 'ok' : ''}` }, c.enabled && c.hasToken ? 'aktiv' : 'aus')),
    h('p', { class: 'small muted' }, 'Echte Tasten für die Technik: In Bitfocus Companion das Modul „Generic HTTP“ hinzufügen. Pro Taste eine Aktion „POST“ mit der Adresse unten und dem Header ', h('code', {}, '{"Authorization": "Bearer <Token>"}'), '. Für Anzeigen auf den Tasten (Titel, Countdown, Not-Aus) die Status-Adresse per GET abfragen und als Variablen nutzen.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: safe(async () => {
        if (c.hasToken && !confirm('Neuen Token erzeugen? Der alte funktioniert dann nicht mehr – Companion muss den neuen bekommen.')) return;
        const out = await api('/admin/companion/token', { method: 'POST', body: {} });
        clear(tokenBox).append(h('div', { class: 'banner-pause stack' }, h('b', {}, 'Token (wird nur jetzt angezeigt):'), h('code', { style: 'user-select:all;word-break:break-all' }, out.token), h('button', { class: 'small', style: 'justify-self:start', onclick: copy(`{"Authorization": "Bearer ${out.token}"}`) }, 'Header für Companion kopieren')));
        data.settings.companion = { enabled: true, hasToken: true };
      }) }, c.hasToken ? '↻ Neuen Token erzeugen' : 'Token erzeugen & aktivieren'),
      c.hasToken ? h('button', { onclick: () => save({ companion: { enabled: !c.enabled } }, c.enabled ? 'Companion aus' : 'Companion an') }, c.enabled ? 'Ausschalten' : 'Einschalten') : null,
      c.hasToken ? h('button', { class: 'ghost small', onclick: () => { if (confirm('Token löschen? Companion-Tasten funktionieren dann nicht mehr.')) save({ companion: { clearToken: true } }, 'Token gelöscht'); } }, 'Token löschen') : null),
    tokenBox,
    h('details', { class: 'more' }, h('summary', {}, 'Adressen für die Tasten'),
      h('div', { class: 'stack', style: 'margin-top:8px' },
        urlRow('Status (GET)', `${base}/api/companion/state`),
        ...COMPANION_ACTIONS.map(([id, label]) => urlRow(label, `${base}/api/companion/action/${id}`)),
        h('p', { class: 'small muted' }, 'Fade- und Crossfade-Dauer lässt sich anhängen, z. B. ', h('code', {}, '…/action/crossfade?sec=6'), '. Not-Aus braucht zwei Drücke innerhalb von 4 Sekunden (Status zeigt „panic_armed“).'),
        testBase ? h('p', { class: 'small muted' }, 'Für den Testmodus statt der Adresse oben: ', h('code', {}, `${testBase}/api/companion/…`)) : null)));
}

// Was die App schon von Spotify weiss, fragt sie nicht noch einmal (dauerhaft gespeichert, auch nach Neustart)
function apiCacheBox(c) {
  if (!c) return h('span');
  const k = c.kinds || {};
  const total = c.hits + c.misses;
  return h('div', { class: 'stack', style: 'gap:6px;border-top:1px solid var(--line);padding-top:10px' },
    h('div', { class: 'row between' }, h('strong', { class: 'small help-host' }, 'Gespeicherte Spotify-Daten'),
      h('button', { class: 'small ghost', onclick: safe(async () => { if (!confirm('Gespeicherte Spotify-Daten und Cover löschen? Die App fragt sie bei Bedarf neu an.')) return; await api('/admin/cache/clear', { method: 'POST', body: {} }); toast('Speicher geleert'); await load(); }) }, 'Leeren')),
    h('div', { class: 'small muted' }, `${k.track || 0} Songs · ${k.artist || 0} Interpreten (Genres) · ${k.search || 0} Suchen · ${k.playlist || 0} Playlists · ${c.covers} Cover (${Math.round(c.coverBytes / 1024)} KB)`),
    h('div', { class: 'small muted' }, total ? `Seit Start ${c.hits} von ${total} Abfragen aus dem Speicher beantwortet (${Math.round(100 * c.hits / total)} %) – so oft musste Spotify nicht gefragt werden.` : 'Seit Start noch keine Abfragen.'));
}

// Mehrere Spotify-Apps: jede hat ein eigenes Anfrage-Limit. Die Suche der Gaeste verteilt sich auf alle Apps mit „Suche";
// jeder Player bleibt bei der App, ueber die er verbunden wurde.
function spotifyAppsCard(apps) {
  const row = (a) => ({ id: a.id || '', name: h('input', { value: a.name, maxlength: 40, 'aria-label': 'Name der App' }), cid: h('input', { value: a.clientId || '', placeholder: 'Client ID', autocomplete: 'off', 'aria-label': 'Client ID' }),
    sec: h('input', { type: 'password', placeholder: a.clientSecret ? '(gesetzt – leer lassen zum Behalten)' : 'Client Secret', autocomplete: 'new-password', 'aria-label': 'Client Secret' }),
    search: h('input', { type: 'checkbox', checked: a.search !== false }), used: [1, 2].filter((n) => a.id && data.settings.spotify.players[n].connected && data.settings.spotify.players[n].appId === a.id) });
  const rows = apps.map(row);
  const list = h('div', { class: 'stack' });
  const draw = () => clear(list).append(...rows.map((r, i) => h('div', { class: 'card stack', style: 'background:var(--bg-2, transparent)' },
    h('div', { class: 'row between' }, h('strong', {}, `App ${i + 1}`), h('span', { class: 'row' }, r.used.length ? h('span', { class: 'badge' }, `Player ${r.used.join(' & ')}`) : h('span'),
      h('button', { class: 'small outline-bad', onclick: () => { if (r.used.length && !confirm(`Player ${r.used.join(' & ')} ${r.used.length > 1 ? 'sind' : 'ist'} über diese App verbunden und ${r.used.length > 1 ? 'werden' : 'wird'} getrennt. Trotzdem entfernen?`)) return; rows.splice(i, 1); draw(); } }, 'Entfernen'))),
    h('div', { class: 'grid two' }, field('Name', r.name), field('Client ID', r.cid)), field('Client Secret', r.sec),
    h('label', { class: 'check' }, r.search, 'Für die Gäste-Suche mitnutzen'))));
  draw();
  const add = () => { rows.push(row({ name: `App ${rows.length + 1}` })); draw(); };
  if (!rows.length) add();
  return h('div', { class: 'card stack' }, h('h2', { class: 'help-host' }, 'Spotify-Apps (Developer Dashboard)'),
    h('p', { class: 'small muted' }, 'Du kannst mehrere Spotify-Apps eintragen. Jede App hat ihr eigenes Anfrage-Limit: Die Gäste-Suche verteilt sich auf alle Apps mit Häkchen, und springt bei einem Limit automatisch auf die nächste. Player 1 und 2 können über verschiedene Apps verbunden werden (hilfreich, weil eine App im Entwicklungsmodus nur wenige Spotify-Konten erlaubt).'),
    h('p', { class: 'small muted' }, 'In jeder App im Spotify-Dashboard diese Redirect-URI eintragen: ', h('code', {}, data.redirectUri)),
    data.spotifyEnvApp ? h('p', { class: 'small muted' }, 'Zurzeit wird die App aus der .env-Datei genutzt. Sobald du hier eine App speicherst, gilt die Liste.') : null,
    list,
    h('div', { class: 'row' }, h('button', { onclick: () => (rows.length >= 8 ? toast('Höchstens 8 Apps', true) : add()) }, '+ Weitere App'),
      h('button', { class: 'primary', onclick: () => save({ spotify: { apps: rows.map((r) => ({ id: r.id, name: r.name.value, clientId: r.cid.value, clientSecret: r.sec.value, search: r.search.checked })).filter((a) => a.clientId || a.id) } }) }, 'Apps speichern')));
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
  ['Dashboard Ton', '/ton', 'Tontechnik: beide Player mit Pegel, Übergang, Mics & Ducking, nächste Songs'],
  ['Dashboard Licht', '/light', 'Lichttechnik: jetzt (mit Cover), nächste Songs mit Genre, Übergang-Countdown'],
  ['Dashboard Orga', '/orga', 'Orga & Einlass: Uhr, Zeitplan, Zahlen, Gäste online, Hinweise'],
  ['DJ', '/dj', 'DJ: angenommene Wünsche, Läuft jetzt / Gespielt markieren'],
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
  const ev = data.evening?.live || {};
  const evCard = h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, 'Abend-Start'),
    h('span', { class: `badge ${ev.awaiting ? 'warn' : 'ok'}` }, ev.awaiting ? `Wünsche zu${ev.opensAt ? ` · öffnen ${new Date(ev.opensAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : ''}` : 'Wünsche offen')),
    h('div', { class: 'row' },
      ev.awaiting ? h('button', { class: 'primary', onclick: safe(async () => { await api('/control/open-wishes', { method: 'POST', body: {} }); toast('Wünsche freigeschaltet'); await load(); }) }, 'Wünsche jetzt freischalten') : null,
      data.settings.start.playlist ? h('button', { onclick: safe(async () => { await api('/control/start-evening', { method: 'POST', body: {} }); toast('Start-Playlist läuft'); await load(); }) }, ev.started ? 'Start-Playlist erneut auffüllen' : 'Start-Playlist starten') : null,
      h('a', { class: 'btn', href: '#automatik', onclick: () => { tab = 'automatik'; render(); } }, 'Einstellungen')),
    h('p', { class: 'small muted' }, 'Zeiten und Playlist unter Automatik → Abend-Start.'));
  const mode = data.settings.operation.mode;
  const setMode = (m) => () => {
    if (m === mode) return;
    if (m === 'wishlist' && !confirm('In den Wunschlisten-Modus wechseln?\n\nDie App spielt dann keine Musik mehr ab und steuert das Pult nicht mehr. Laufende Player werden angehalten. Wünsche werden nur noch angenommen oder abgelehnt, ein DJ spielt selbst.')) return;
    save({ operation: { mode: m } }, m === 'wishlist' ? 'Wunschlisten-Modus an' : 'Normalbetrieb an');
  };
  const opt = (m, title, text) => h('button', { class: `mode-opt ${mode === m ? 'on' : ''}`, onclick: setMode(m), 'aria-pressed': String(mode === m) }, h('b', {}, title), h('span', {}, text));
  return h('div', { class: 'stack', style: 'gap:16px' },
    evCard,
    h('div', { class: 'card stack' }, h('h2', {}, 'Betriebsart'),
      h('p', { class: 'small muted' }, 'Spielt die App die Musik selbst (Spotify, Crossfade, Pult) oder gibt es einen DJ, der selbst spielt und die App nur die Wünsche verwaltet? Umschalten ist jederzeit möglich.'),
      h('div', { class: 'grid two' },
        opt('full', 'Normalbetrieb', 'Spotify-Player, Warteschlange, Crossfade, Ducking und X32 – die App spielt.'),
        opt('wishlist', 'Nur Wunschliste', 'Wünsche annehmen oder ablehnen, ein DJ spielt selbst und markiert Songs in der DJ-Ansicht als „läuft“/„gespielt“. Kein Spotify-Player, kein Pult.'))),
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
  const EVLABEL = { x32: 'X32/Pi nicht erreichbar', spotify: 'Spotify-Problem oder -Limit', player: 'Player getrennt', panic: 'Not-Aus ausgelöst', queueEmpty: 'Warteschlange leer', emergency: 'Notfall-Playlist gestartet', backup: 'Backup fehlgeschlagen', mood: 'KI: Stimmung kippt' };
  const evs = Object.fromEntries(Object.keys(nt.events).map((k) => [k, chk(nt.events[k])]));
  const sta = s.start, opn = s.opening;
  const stPl = h('input', { value: sta.playlist, placeholder: 'Playlist-Link oder -ID' }), stMin = num(sta.minQueue, { min: 1, max: 10, class: 'num' }), stAuto = chk(sta.autoStart), stAt = h('input', { type: 'time', value: sta.startAt });
  const opOn = chk(opn.enabled), opAt = h('input', { type: 'time', value: opn.at }), opAuto = chk(opn.auto), opMsg = h('input', { value: opn.message, maxlength: 200 });
  const bOn = chk(bk.enabled), bEvery = num(bk.everyMin, { min: 5, max: 1440, class: 'num' }), bKeep = num(bk.keep, { min: 1, max: 200, class: 'num' });
  const bList = h('div', { class: 'stack', style: 'gap:6px' });
  const loadBackups = async () => {
    const { backups } = await api('/admin/backups');
    clear(bList).append(...(backups.length ? backups.slice(0, 8).map((b) => h('div', { class: 'row between small' }, h('span', {}, `${new Date(b.ts).toLocaleString('de-DE')} · ${(b.size / 1024).toFixed(0)} KB`),
      h('a', { class: 'btn small', href: `${BASE}/api/admin/backups/${b.name}`, style: 'height:30px;font-size:.8rem;padding:0 10px' }, 'Laden'))) : [h('div', { class: 'muted small' }, 'Noch keine Backups.')]));
  };
  loadBackups().catch(() => {});

  const saveAll = () => save({
    timezone: tz.value,
    auto: { smartOutro: smart.checked },
    autoOrder: { enabled: aoOn.checked, mood: moodOn.checked, maxRepeat: Number(maxRep.value), window: Number(win.value), phases },
    start: { playlist: stPl.value, minQueue: Number(stMin.value), autoStart: stAuto.checked, startAt: stAt.value },
    opening: { enabled: opOn.checked, at: opAt.value, auto: opAuto.checked, message: opMsg.value },
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
    h('div', { class: 'card stack' }, h('h2', {}, 'Abend-Start'),
      h('p', { class: 'small muted' }, 'Zum Auftakt läuft eine Start-Playlist, die Wünsche bleiben zu, bis du sie freischaltest oder die Uhrzeit erreicht ist. Sobald Wünsche angenommen werden, kommen sie vor die Songs der Start-Playlist.'),
      h('div', { class: 'eyebrow' }, 'Start-Playlist'),
      h('label', { class: 'field' }, 'Playlist (Link oder ID)', stPl),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Immer mindestens'), stMin, h('span', { class: 'small muted' }, 'Songs in der Warteschlange, solange noch kein Wunsch angenommen wurde')),
      row(stAuto, 'Automatisch starten um'), stAt,
      h('div', { class: 'small muted' }, 'Startknopf: Technik-Ansicht → „Start-Playlist starten“. Die Playlist wird gemischt, ohne gesperrte oder explizite Songs (je nach Einstellung).'),
      h('hr'),
      h('div', { class: 'eyebrow' }, 'Wünsche freischalten'),
      row(opOn, 'Wünsche sind zu, bis sie freigeschaltet werden'),
      h('div', { class: 'row' }, row(opAuto, 'Automatisch freischalten um'), opAt),
      h('label', { class: 'field' }, 'Hinweis für Gäste', opMsg),
      h('div', { class: 'small muted' }, 'Beim Einschalten werden die Wünsche sofort geschlossen. Freischalten geht jederzeit von Hand (Technik/Admin) – dann zählt die Uhrzeit nicht mehr.')),
    h('div', { class: 'card stack' }, h('h2', {}, 'Notfall-Playlist'), h('p', { class: 'small muted' }, 'Ein Knopf in der Technik stoppt alles und startet diese Playlist (gemischt) – falls etwas ausfällt.'),
      h('div', { class: 'grid two' }, h('label', { class: 'field' }, 'Playlist', ePl), h('label', { class: 'field' }, 'Auf Player', ePlayer)), row(eShuf, 'Gemischt abspielen')),
    h('div', { class: 'card stack' }, h('h2', {}, 'Alarm aufs Handy (ntfy)'),
      h('p', { class: 'small muted' }, 'Die App meldet Probleme per ntfy – auf ntfy.sh oder deinem eigenen ntfy-Server. In der ntfy-App denselben Topic abonnieren (am besten einen schwer zu erratenden Namen wählen).'),
      row(nOn, 'Benachrichtigungen an'),
      h('div', { class: 'grid two' }, h('label', { class: 'field' }, 'Server', nUrl), h('label', { class: 'field' }, 'Topic', nTopic), h('label', { class: 'field' }, 'Zugriffstoken (nur bei geschütztem Server)', nTok),
        h('label', { class: 'field' }, 'Alarm erst nach … Sekunden Störung', nDown)),
      h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'eyebrow' }, 'Wann alarmieren?'), ...Object.keys(evs).map((k) => row(evs[k], EVLABEL[k] || k))),
      h('div', { class: 'row' }, h('button', { onclick: safe(async () => { await saveAll(); await api('/admin/notify/test', { method: 'POST', body: {} }); toast('Test gesendet – schau aufs Handy'); }) }, 'Speichern & Test senden'))),
    h('div', { class: 'card stack' }, h('h2', {}, 'Automatische Backups'),
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
      h('div', { class: 'p-url' }, url.replace(/^https?:\/\//, '').replace(/\/+$/, '')));
  }
  [target, head, sub].forEach((el) => el.addEventListener('input', () => paint().catch(() => {})));
  paint().catch((e) => toast(e.message, true));
  return h('div', { class: 'stack', style: 'gap:16px' },
    h('div', { class: 'card stack no-print' }, h('h2', {}, 'QR-Code & Poster'), h('p', { class: 'small muted' }, 'Zum Ausdrucken (A4). Der Code führt auf die Gäste-Seite.'),
      h('div', { class: 'grid two' }, h('label', { class: 'field' }, 'Ziel', target), h('label', { class: 'field' }, 'Überschrift', head)),
      h('label', { class: 'field' }, 'Untertitel', sub),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => window.print() }, 'Drucken / als PDF speichern'), h('a', { class: 'btn', href: `${BASE}/beamer`, target: '_blank', rel: 'noopener' }, 'Beamer-Ansicht öffnen'))),
    out);
}

// ---------- Bericht ----------
function viewReport() {
  const envSel = h('select', {}, h('option', { value: 'live' }, 'Live'), h('option', { value: 'test' }, 'Testmodus'));
  const out = h('div', { class: 'stack' });
  const csv = h('a', { class: 'btn', href: `${BASE}/api/admin/setlist.csv?env=live` }, 'Setlist als CSV');
  const pdf = h('a', { class: 'btn', href: `${BASE}/api/admin/setlist.pdf?env=live` }, 'Setlist als PDF');
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
  return h('div', { class: 'stack' }, h('div', { class: 'row' }, envSel, pdf, csv), recapCard(envSel), out);
}

// KI-Rueckblick: Text fuer die Gaeste (Homepage/Instagram) und Auswertung fuers Team
function recapCard(envSel) {
  if (!data.features.flags.aiRecap) return h('span');
  const box = h('div', { class: 'stack' });
  const copy = (t) => safe(async () => { try { await navigator.clipboard.writeText(t); toast('Kopiert'); } catch { toast('Kopieren nicht möglich', true); } });
  const show = (r) => clear(box).append(!r ? h('p', { class: 'small muted' }, 'Noch kein Rückblick geschrieben.') : h('div', { class: 'grid two' },
    h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h3', {}, `Für die Gäste: ${r.title}`), h('button', { class: 'small', onclick: copy(`${r.title}\n\n${r.guests}`) }, 'Kopieren')), h('div', { class: 'recap-text' }, r.guests)),
    h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h3', {}, 'Für das Team'), h('button', { class: 'small', onclick: copy(r.team) }, 'Kopieren')), h('div', { class: 'recap-text' }, r.team)),
    h('div', { class: 'tiny muted' }, `Geschrieben ${new Date(r.ts).toLocaleString('de-DE')} von ${r.model} – vor dem Veröffentlichen bitte lesen.`)));
  const load = () => api(`/admin/ai/recap?env=${envSel.value}`).then((x) => show(x.recap)).catch(() => {});
  envSel.addEventListener('change', load); load();
  return h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, 'Rückblick'),
    h('button', { class: 'primary', onclick: async (e) => {
      e.target.disabled = true; clear(box).append(h('div', { class: 'small muted' }, 'Die KI schreibt … (kann bei großen Modellen eine Minute dauern)'));
      try { show((await api('/admin/ai/recap', { method: 'POST', body: { env: envSel.value } })).recap); } catch (er) { toast(er.message, true); load(); } finally { e.target.disabled = false; }
    } }, 'Rückblick schreiben')), box);
}

// ---------- KI (Ollama) ----------
function viewAi() {
  const a = data.settings.ai;
  const url = h('input', { value: a.url, placeholder: 'http://192.168.178.50:11434', autocomplete: 'off' });
  const token = h('input', { type: 'password', placeholder: a.token ? '(gesetzt – leer lassen zum Behalten)' : 'nur nötig hinter einem geschützten Proxy', autocomplete: 'new-password' });
  const model = h('select', {}, h('option', { value: a.model }, a.model || '– erst Modelle laden –'));
  const enabled = chk(a.enabled), autoLight = chk(a.autoLight), autoFiller = chk(a.autoFiller);
  const timeout = num(a.timeoutSec, { min: 10, max: 600, class: 'num' });
  const info = h('div', { class: 'small muted' });
  const loadModels = safe(async () => {
    info.textContent = 'Lade Modelle …';
    const { models } = await api('/admin/ai/models', { method: 'POST', body: { url: url.value, token: token.value || undefined } });
    clear(model).append(...(models.length ? models.map((m) => h('option', { value: m.name, selected: m.name === a.model }, `${m.name}${m.params ? ` · ${m.params}` : ''}${m.size ? ` · ${(m.size / 1e9).toFixed(1)} GB` : ''}`)) : [h('option', { value: '' }, 'Keine Modelle installiert (ollama pull …)')]));
    info.textContent = `${models.length} Modell${models.length === 1 ? '' : 'e'} gefunden.`;
  });
  const status = h('div', { class: 'small muted' });
  api('/ai/status').then((s) => { status.textContent = s.ready ? `Bereit · ${s.calls} Anfragen seit Start${s.lastMs ? ` · letzte Antwort ${(s.lastMs / 1000).toFixed(1)} s` : ''}${s.lastError ? ` · letzter Fehler: ${s.lastError}` : ''}` : 'Noch nicht eingerichtet.'; }).catch(() => {});
  const flags = data.features.flags;
  const feat = (id, label) => h('div', { class: 'row nowrap small' }, h('span', { class: `badge ${flags[id] ? 'ok' : ''}` }, flags[id] ? 'an' : 'aus'), label);
  return h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Ollama-Server'),
      h('p', { class: 'small muted' }, 'Die App nutzt deinen eigenen Ollama-Server mit einem Modell. Es gehen nur Songdaten und Technikzustand dorthin – keine Gästedaten, keine Passwörter oder Tokens. Die KI schlägt nur vor; übernommen wird per Knopf (Ausnahme: Licht-Vorschläge und – falls eingeschaltet – der automatische Lückenfüller).'),
      field('Ollama-Adresse', url), field('Zugangs-Token', token),
      h('div', { class: 'row' }, h('button', { onclick: loadModels }, '↻ Modelle laden'), info),
      field('Modell', model),
      h('label', { class: 'check' }, enabled, 'KI einschalten'),
      h('label', { class: 'check' }, autoLight, 'Licht-Vorschläge automatisch erzeugen'),
      h('label', { class: 'check' }, autoFiller, 'Leere Warteschlange automatisch per KI auffüllen'),
      field('Maximale Wartezeit (Sekunden)', timeout),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => save({ ai: { url: url.value, token: token.value || undefined, model: model.value, enabled: enabled.checked, autoLight: autoLight.checked, autoFiller: autoFiller.checked, timeoutSec: Number(timeout.value) } }) }, 'Speichern'),
        h('button', { onclick: safe(async () => { const r = await api('/admin/ai/test', { method: 'POST', body: {} }); toast(`✓ Antwort nach ${(r.ms / 1000).toFixed(1)} s: „${r.reply}“`); }) }, 'Verbindung testen'),
        a.token ? h('button', { class: 'ghost small', onclick: () => save({ ai: { clearToken: true } }, 'Token entfernt') }, 'Token entfernen') : null),
      status),
    h('div', { class: 'card stack' }, h('h2', {}, 'Was die KI macht'),
      feat('aiEnergy', 'Energie-Kurve: Technik → KI-Assistent → „Reihenfolge vorschlagen“'),
      feat('aiFiller', 'Lückenfüller: Technik → „Songs vorschlagen“ (bei Spotify geprüft, Einreihen per Knopf)'),
      feat('aiLight', 'Licht-Vorschläge: Farben, Tempo, Intensität, Strobo im Licht-Dashboard'),
      feat('aiHelp', 'Fehler-Assistent: „Was ist los?“ in Technik, Vorbereitung und Ton-Dashboard'),
      feat('aiRecap', 'Rückblick: Bericht & Export → „Rückblick schreiben“'),
      feat('aiGenres', 'Genres nachtragen: wenn Spotify keine liefert (im Licht-Dashboard mit „KI“ markiert)'),
      feat('aiSummary', 'Wunsch-Zusammenfassung: Moderation → „Zusammenfassen“'),
      h('div', { class: 'row' }, feat('aiMood', 'Stimmungs-Warnung: alle 10 Minuten, Meldung nur per ntfy (Automatik → Alarm aufs Handy)'),
        h('button', { class: 'small', onclick: safe(async () => { const r = await api('/ai/mood', { method: 'POST', body: {} }); toast(r.drop ? `Kippt (${r.severity}): ${r.reason}` : `In Ordnung: ${r.reason}`); }) }, 'Jetzt einmal prüfen')),
      h('p', { class: 'small muted' }, 'Einzeln an- und ausschalten unter Zugang → Funktionen (Gruppe „KI“). Modell-Tipp: Für deutsche Texte und sauberes JSON eignen sich z. B. Qwen 2.5/3 oder Llama 3.1 ab 7–8 B Parametern; kleinere Modelle sind schneller, liefern aber öfter unbrauchbare Vorschläge.')));
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
  const HOMES = [['', 'Standard'], ['/mod', 'Moderation'], ['/tech', 'Technik'], ['/stage', 'Bühne'], ['/ton', 'Dashboard Ton'], ['/light', 'Dashboard Licht'], ['/orga', 'Dashboard Orga'], ['/dj', 'DJ'], ['/focus', 'Fokus-Modus'], ['/ticker', 'Live-Wünsche'], ['/board', 'Board'], ['/foh', 'Anzeige'], ['/analytics', 'Analytics']];
  const homes = Object.fromEntries(['tech', 'mod', 'orga', 'display', 'light', 'dj'].map((r) => [r, h('select', {}, ...HOMES.map(([val, l]) => h('option', { value: val, selected: (data.settings.roleHome?.[r] || '') === val }, l)))]));
  const ROLE = { tech: 'Technik', mod: 'Moderation', orga: 'Orga', display: 'FOH-Anzeige', light: 'Lichttechnik', dj: 'DJ' };
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
      h('div', { class: 'row' }, h('a', { class: 'btn', href: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`, download: `${name}.conf` }, 'Als Datei'), h('button', { class: 'primary', onclick: () => close() }, 'Fertig'))]);
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
        h('label', { class: 'check' }, behind, 'Hinter diesem Gerät liegen weitere Geräte'),
        h('p', { class: 'small muted' }, 'Danach QR-Code mit der WireGuard-App scannen (Handy) oder die Datei importieren (PC, Pi). Bitte Peers nur hier verwalten, nicht von Hand in der Konfiguration.')));
  }
  paint();
  return box;
}

// ---------- Single Sign-On (OpenID Connect, z. B. Authentik) ----------
const SSO_ROLES = [['tech', 'Technik'], ['mod', 'Moderation'], ['dj', 'DJ'], ['orga', 'Orga (nur lesen)'], ['light', 'Lichttechnik'], ['display', 'FOH-Anzeige'], ['admin', 'Admin (nur wenn erlaubt)']];
function ssoCard() {
  const o = data.settings.sso;
  const on = chk(o.enabled), issuer = h('input', { value: o.issuer, placeholder: 'https://auth.example.de/application/o/schulhauspartry/' }), cid = h('input', { value: o.clientId, autocomplete: 'off' });
  const sec = h('input', { type: 'password', placeholder: o.clientSecret ? '(gesetzt – leer lassen zum Behalten)' : 'Client Secret', autocomplete: 'new-password' });
  const scopes = h('input', { value: o.scopes }), gclaim = h('input', { value: o.groupsClaim }), label = h('input', { value: o.buttonLabel, maxlength: 40 });
  const allowAdmin = chk(o.allowAdmin), autoCreate = chk(o.autoCreate !== false), autoLinkEmail = chk(!!o.autoLinkEmail);
  const def = h('select', {}, h('option', { value: '' }, 'Kein Zugang'), ...SSO_ROLES.filter(([v]) => v !== 'admin').map(([v, l]) => h('option', { value: v, selected: o.defaultRole === v }, l)));
  let map = o.roleMap.map((m) => ({ ...m }));
  const mapBox = h('div', { class: 'stack', style: 'gap:8px' });
  const paint = () => clear(mapBox).append(...map.map((m, i) => h('div', { class: 'row nowrap' },
    h('input', { value: m.group, placeholder: 'Gruppe im Anbieter, z. B. party-technik', oninput: (e) => { m.group = e.target.value; } }),
    h('select', { onchange: (e) => { m.role = e.target.value; } }, ...SSO_ROLES.map(([v, l]) => h('option', { value: v, selected: m.role === v }, l))),
    h('button', { class: 'small ghost', onclick: () => { map.splice(i, 1); paint(); } }, '✕'))),
    h('button', { class: 'small', onclick: () => { map.push({ group: '', role: 'mod' }); paint(); } }, '+ Gruppe zuordnen'));
  paint();
  const result = h('div', { class: 'small' });
  const saveSso = () => save({ sso: { enabled: on.checked, issuer: issuer.value, clientId: cid.value, clientSecret: sec.value, scopes: scopes.value, groupsClaim: gclaim.value, buttonLabel: label.value, defaultRole: def.value, allowAdmin: allowAdmin.checked, autoCreate: autoCreate.checked, autoLinkEmail: autoLinkEmail.checked, roleMap: map } }, 'SSO gespeichert');
  return h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, 'Single Sign-On (SSO)'), h('span', { class: `badge ${o.enabled ? 'ok' : ''}` }, o.enabled ? 'an' : 'aus')),
    h('p', { class: 'small muted' }, 'Mitarbeitende melden sich über deinen Identity-Provider an (Authentik, Keycloak, Authelia … per OpenID Connect). Die Rolle in der App kommt aus den Gruppen des Anbieters. Codes und Passkeys funktionieren weiter.'),
    h('label', { class: 'check' }, on, 'SSO aktivieren'),
    h('div', { class: 'grid two' }, h('label', { class: 'field' }, 'Issuer-URL', issuer), h('label', { class: 'field' }, 'Client-ID', cid),
      h('label', { class: 'field' }, 'Client-Secret', sec), h('label', { class: 'field' }, 'Beschriftung des Anmelde-Knopfs', label),
      h('label', { class: 'field' }, 'Scopes', scopes), h('label', { class: 'field' }, 'Name des Gruppen-Felds', gclaim)),
    h('div', { class: 'small' }, h('b', {}, 'Rückkehr-Adresse (Redirect-URI) beim Anbieter eintragen: '), h('code', { style: 'user-select:all' }, data.ssoRedirectUri)),
    h('div', { class: 'eyebrow' }, 'Gruppen → Rollen'), mapBox,
    h('div', { class: 'grid two' }, h('label', { class: 'field' }, 'Wer in keiner dieser Gruppen ist, bekommt', def)),
    h('label', { class: 'check' }, autoCreate, 'Neue Konten automatisch anlegen'),
    h('label', { class: 'check' }, autoLinkEmail, 'Bestehende Zugänge per E-Mail verbinden'),
    h('p', { class: 'small muted' }, 'Verbinden kann sich auch jede Person selbst: eingeloggt oben auf den Schlüssel-Knopf → „Mit SSO verbinden“. Der Head-Admin verbindet seinen Zugang genauso.'),
    h('label', { class: 'check' }, allowAdmin, 'Admin-Rolle per SSO erlauben'),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: saveSso }, 'Speichern'),
      h('button', { onclick: safe(async () => { await saveSso(); try { const r = await api('/admin/sso/test', { method: 'POST', body: {} }); clear(result).append(h('span', { class: 'badge ok' }, 'Verbindung ok'), ` ${r.keys} Schlüssel, Aussteller ${r.issuer}`); } catch (e) { clear(result).append(h('span', { class: 'badge bad' }, 'Fehler'), ` ${e.message}`); } }) }, 'Speichern & Verbindung testen')), result,
    h('details', { class: 'more' }, h('summary', {}, 'Einrichtung in Authentik (Kurzanleitung)'), h('ol', { class: 'small', style: 'margin:10px 0 0 18px;display:grid;gap:4px' },
      h('li', {}, 'Authentik → Anwendungen → „Anwendung mit Provider erstellen" → Provider-Typ OAuth2/OpenID.'),
      h('li', {}, 'Client-Typ „Vertraulich", Redirect-URI wie oben (Modus „Strikt"), Signaturschlüssel wählen (empfohlen) oder leer lassen (dann HS256 mit dem Secret).'),
      h('li', {}, 'Scopes: openid, profile, email. Authentik liefert die Gruppen im Feld „groups".'),
      h('li', {}, 'Client-ID und Secret hier eintragen, Issuer-URL = die „OpenID-Konfigurations-Aussteller"-URL des Providers.'),
      h('li', {}, 'In Authentik Gruppen anlegen (z. B. party-technik) und der Anwendung zuordnen; hier unter „Gruppen → Rollen" verknüpfen.'))));
}

// ---------- Schutz vor Ueberlastung ----------
function shieldCard() {
  const box = h('div', { class: 'card stack' });
  async function paint() {
    let d;
    try { d = await api('/admin/shield'); } catch (e) { clear(box).append(h('p', { class: 'small muted' }, e.message)); return; }
    const c = d.cfg;
    const field2 = (k, label, min, max) => h('label', { class: 'field' }, label, num(c[k], { min, max, 'data-k': k }));
    const fields = [field2('pagePerMin', 'Seiten & Team pro Adresse/Min.', 30, 100000), field2('assetPerMin', 'Dateien pro Adresse/Min.', 30, 200000), field2('guestPerMin', 'Gäste-Anfragen pro Adresse/Min.', 30, 100000),
      field2('writePerMin', 'Schreibende Anfragen pro Adresse/Min.', 10, 50000), field2('devicePerMin', 'Anfragen pro Gäste-Gerät/Min.', 20, 20000), field2('wishesPerIp', 'Wünsche pro Adresse/15 Min.', 5, 5000),
      field2('newDevicesPerMin', 'Neue Geräte pro Adresse/Min.', 5, 20000), field2('wsPerIp', 'Live-Verbindungen pro Adresse', 5, 5000), field2('wsTotal', 'Live-Verbindungen insgesamt', 50, 50000),
      field2('maxInflight', 'Gleichzeitige Anfragen (Gäste)', 50, 20000), field2('maxPending', 'Max. offene Wünsche', 20, 5000), field2('banStrikes', 'Sperre nach … Abweisungen/Min.', 20, 5000), field2('banMin', 'Sperrdauer (Minuten)', 1, 1440)];
    const on = chk(c.enabled), attack = chk(c.attackMode);
    const bars = d.blocked.last60, mx = Math.max(1, ...bars);
    clear(box).append(
      h('div', { class: 'row between' }, h('h2', {}, 'Schutz vor Überlastung'), h('span', { class: `badge ${c.attackMode ? 'bad' : c.enabled ? 'ok' : ''}` }, c.attackMode ? 'ANGRIFFSMODUS' : c.enabled ? 'aktiv' : 'aus')),
      h('p', { class: 'small muted' }, 'Begrenzt Anfragen pro Absender-Adresse, Gäste-Gerät, neue Geräte, Wünsche und Live-Verbindungen und sperrt Dauerfeuer automatisch. Wichtig: Gäste im selben WLAN teilen sich oft eine Adresse – die Standardwerte sind deshalb großzügig. Gegen echte Datenfluten schützt Cloudflare (siehe docs/SECURITY.md).'),
      h('div', { class: 'small' }, `Live-Verbindungen: ${d.ws.total} von ${c.wsTotal} · gleichzeitige Anfragen: ${d.inflight} · abgewiesen seit Start: ${d.blocked.total}`),
      h('div', { class: 'spark', title: 'Abgewiesene Anfragen pro Minute (letzte 60 Min.)', style: 'display:flex;align-items:flex-end;gap:2px;height:36px' }, ...bars.map((n) => h('i', { style: `flex:1;background:var(--ink);opacity:.7;border-radius:2px;height:${Math.max(2, Math.round(36 * n / mx))}px` }))),
      d.bans.length ? h('div', { class: 'list' }, ...d.bans.map((b) => h('div', { class: 'item row between' }, h('div', {}, h('b', { class: 'mono' }, b.ip), h('div', { class: 'tiny muted' }, `${b.reason} · noch ${Math.ceil(b.untilSec / 60)} Min.`)), h('button', { class: 'small', onclick: safe(async () => { await api('/admin/shield/unban', { method: 'POST', body: { ip: b.ip } }); paint(); }) }, 'Entsperren')))) : h('div', { class: 'small muted' }, 'Keine Sperren.'),
      d.offenders.length ? h('details', { class: 'more' }, h('summary', {}, 'Auffälligste Absender'), h('div', { class: 'stack', style: 'margin-top:8px;gap:4px' }, ...d.offenders.map((o) => h('div', { class: 'row between small' }, h('span', { class: 'mono' }, o.ip), h('span', {}, `${o.n} Abweisungen${o.banned ? ' · gesperrt' : ''}`))))) : h('span'),
      h('label', { class: 'check' }, on, 'Schutz aktiv'),
      h('label', { class: 'check' }, attack, 'Angriffsmodus'),
      h('details', { class: 'more' }, h('summary', {}, 'Grenzen einstellen'), h('div', { class: 'grid three', style: 'margin-top:10px' }, ...fields)),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => {
        const v = { enabled: on.checked, attackMode: attack.checked };
        for (const i of box.querySelectorAll('input[data-k]')) v[i.dataset.k] = Number(i.value);
        save({ security: { shield: v } }, 'Gespeichert');
      } }, 'Speichern'), h('button', { onclick: paint }, 'Aktualisieren')));
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
      h('div', { class: 'card stack' }, h('h2', {}, 'Passkeys'),
        h('p', { class: 'small muted' }, 'Anmeldung per Fingerabdruck, Gesicht oder Geräte-PIN – nichts zum Abtippen und nicht abfangbar. Mitarbeitende registrieren ihren Passkey selbst (Schlüssel-Knopf oben in der Leiste); hier siehst und löschst du alle.'),
        passkeysSupported() ? h('div', { class: 'row' }, label, h('button', { class: 'primary', onclick: safe(async () => { await passkeyRegister(label.value); toast('Passkey gespeichert'); paint(); }) }, 'Passkey für dieses Gerät anlegen')) : h('div', { class: 'small muted' }, 'Dieser Browser/diese Adresse unterstützt keine Passkeys (HTTPS nötig) oder die Funktion ist ausgeschaltet.'),
        pkList,
        h('label', { class: 'check' }, only, 'Admin-Login nur mit Passkey'),
        h('p', { class: 'small muted' }, `Admin-Passkeys: ${d.adminPasskeys}. Erst einschalten, wenn mindestens ein Passkey funktioniert. Notfall: Server mit Umgebungsvariable ADMIN_RECOVERY=1 starten – dann geht das Passwort wieder.`)),
      shieldCard(),
      ssoCard(),
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
  clear(body).append(h('p', { class: 'tab-intro' }, TAB_INTRO[tab] || ''), { ki: viewAi, livetest: viewLiveTest, probe: viewProbe, start: viewStart, funktionen: viewFeatures, sicherheit: viewSecurity, vpn: viewVpn, automatik: viewAutomation, design: viewDesign, poster: viewPoster, einstellungen: viewSettings, codes: viewCodes, verbindungen: viewConnections, bericht: viewReport }[tab]());
}

app.append(topbar('Admin', { live: false, nav: true }), h('div', { class: 'wrap' }, tabBar, body));
addEventListener('hashchange', () => { const t = location.hash.slice(1); if (tabs.includes(t) && t !== tab && data) { tab = t; render(); } });
load().catch((e) => toast(e.message, true));

// ---------- Generalprobe ----------
let probeTimer = null;
function viewProbe() {
  clearInterval(probeTimer);
  const box = h('div', { class: 'stack', style: 'gap:16px' });
  const testOn = data.settings.test.enabled;
  const o = { guests: num(150, { min: 5, max: 1500 }), durationMin: num(5, { min: 1, max: 30 }), rampSec: num(60, { min: 0, max: 600 }),
    approvePct: num(80, { min: 0, max: 100 }), modDelaySec: num(6, { min: 1, max: 120 }), speed: num(10, { min: 1, max: 30 }) };
  const intensity = h('select', {}, ...[['ruhig', 'Ruhig'], ['normal', 'Normal (lebhafte Party)'], ['hoch', 'Hoch'], ['extrem', 'Extrem (Härtetest)']].map(([v, l]) => h('option', { value: v, selected: v === 'normal' }, l)));
  const ipMode = h('select', {}, h('option', { value: 'many' }, 'Verschiedene (mobile Daten)'), h('option', { value: 'one' }, 'Eine gemeinsame (Schul-WLAN)'));
  const pages = chk(true), live = chk(true), poll = chk(true), reset = chk(true);
  const form = h('div', { class: 'card stack' }, h('h2', {}, 'Neue Generalprobe'),
    h('p', { class: 'small muted' }, 'Simuliert eine komplette Party im Testmodus: Gäste öffnen die Seite, suchen, wünschen, voten und halten Live-Verbindungen; ein Moderations-Bot nimmt an und lehnt ab; die Wiedergabe läuft mit Crossfades. Alles geht über die echten Schnittstellen inklusive Schutzgrenzen. Die Live-Party wird nicht angefasst.'),
    !testOn ? h('div', { class: 'banner-pause' }, 'Der Testmodus ist aus. ', h('button', { class: 'small', onclick: () => save({ test: { enabled: true } }, 'Testmodus an') }, 'Testmodus einschalten')) : null,
    h('div', { class: 'grid three' }, field('Gäste', o.guests), field('Dauer (Minuten)', o.durationMin), field('Anlaufzeit (Sekunden)', o.rampSec),
      field('Aktivität', intensity), field('Adressen', ipMode), field('Wiedergabe-Tempo', o.speed),
      field('Moderation nimmt an (%)', o.approvePct), field('Moderation entscheidet nach (Sekunden)', o.modDelaySec)),
    h('div', { class: 'grid two' }, h('label', { class: 'check' }, pages, 'Seitenaufrufe mitsimulieren'), h('label', { class: 'check' }, live, 'Live-Verbindungen mitsimulieren'),
      h('label', { class: 'check' }, poll, 'Umfrage mitsimulieren'), h('label', { class: 'check' }, reset, 'Testdaten danach zurücksetzen')),
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !testOn, onclick: safe(async () => {
      const body = Object.fromEntries(Object.entries(o).map(([k, i]) => [k, Number(i.value)]));
      Object.assign(body, { intensity: intensity.value, ipMode: ipMode.value, pages: pages.checked, live: live.checked, poll: poll.checked, resetAfter: reset.checked });
      paint(await api('/admin/rehearsal/start', { method: 'POST', body }));
    }) }, 'Generalprobe starten'), h('span', { class: 'small muted' }, 'Tipp: zuerst mit der erwarteten Gästezahl und „Normal", dann einmal „Eine gemeinsame Adresse" probieren.')));
  const live2 = h('div', { class: 'stack', style: 'gap:16px' });
  const LV = { ok: ['ok', '✓'], info: ['', 'i'], warn: ['warn', '!'], bad: ['bad', '✕'] };
  const ms = (v) => (v == null ? '–' : v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`);
  const spark = (vals, title) => { const mx = Math.max(1, ...vals); return h('div', { title, style: 'display:flex;align-items:flex-end;gap:1px;height:40px' }, ...vals.map((v) => h('i', { style: `flex:1;min-width:1px;background:var(--ink);opacity:.75;height:${Math.max(1, Math.round(40 * v / mx))}px` }))); };
  function report(c, running) {
    const t = c.totals, el = ((c.endedAt || Date.now()) - c.startedAt) / 1000, dur = c.opt.durationMin * 60;
    const tile = (k, v, sub) => h('div', { class: 'kpi' }, h('div', { class: 'eyebrow' }, k), h('div', { class: 'v' }, String(v)), sub ? h('div', { class: 'tiny muted' }, sub) : h('span'));
    return [
      h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('h2', {}, running ? 'Generalprobe läuft …' : `Ergebnis (${c.endReason || 'fertig'})`),
          running ? h('button', { class: 'bad', onclick: safe(async () => paint(await api('/admin/rehearsal/stop', { method: 'POST', body: {} }))) }, '■ Abbrechen')
            : h('span', { class: `badge ${c.verdict === 'ok' ? 'ok' : c.verdict === 'warn' ? 'warn' : 'bad'}` }, c.verdict === 'ok' ? 'bestanden' : c.verdict === 'warn' ? 'mit Hinweisen' : 'Probleme')),
        running ? h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, Math.round(100 * el / dur))}%` })) : h('span'),
        h('div', { class: 'small muted' }, `${c.guests.joined} von ${c.guests.target} Gästen · ${Math.round(el)} s von ${dur} s · Aktivität ${c.opt.intensity} · ${c.opt.ipMode === 'one' ? 'eine Adresse' : 'verschiedene Adressen'}`),
        h('div', { class: 'kpis' }, tile('Anfragen', t.n, `${t.rps}/s, Spitze ${t.peakRps}/s`), tile('Fehler', t.err, 'Server/Verbindung'), tile('Vom Schutz abgewiesen', t.shield),
          tile('Live-Verbindungen', c.ws.open ?? c.ws.opened, `${c.ws.failed} fehlgeschlagen`), tile('Entscheidungen', c.decisions.approved + c.decisions.denied, `${c.decisions.approved} angenommen`), tile('Server-CPU max.', `${c.server.cpuMax} %`, `RAM ${c.server.rss ?? '–'} MB`)),
        h('div', { class: 'grid two' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Anfragen pro Sekunde'), spark(c.timeline.map((x) => x.req), 'Anfragen/s')), h('div', {}, h('div', { class: 'eyebrow' }, 'Server-Verzögerung (ms)'), spark(c.server.lag, 'Verzögerung')))),
      h('div', { class: 'card stack' }, h('h2', {}, 'Bewertung'), h('div', { class: 'list' }, ...c.findings.map((f) => h('div', { class: 'item stack', style: 'gap:4px' }, h('div', { class: 'row nowrap' }, h('span', { class: `badge ${LV[f.level][0]}` }, LV[f.level][1]), h('b', {}, f.text)), f.hint ? h('div', { class: 'small muted' }, f.hint) : h('span'))))),
      h('div', { class: 'card', style: 'overflow-x:auto' }, h('h2', {}, 'Antwortzeiten'), h('table', {}, h('thead', {}, h('tr', {}, ...['Bereich', 'Anfragen', 'ok', 'Limit (gewollt)', 'Schutz', 'Fehler', 'Median', '95 %', 'Max'].map((x) => h('th', {}, x)))),
        h('tbody', {}, ...Object.entries(c.cats).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v.n), h('td', {}, v.ok), h('td', {}, v.appLimit + v.closed + v.other4xx), h('td', {}, v.shield), h('td', {}, v.err5xx + v.neterr), h('td', {}, ms(v.p50)), h('td', {}, ms(v.p95)), h('td', {}, ms(v.max))))))),
      h('div', { class: 'small muted' }, `Testmodus jetzt: ${c.app.pending} offen, ${c.app.queue} in der Warteschlange, ${c.app.played} gespielt · ${c.crossfades} Crossfades durch den Technik-Bot.`),
    ];
  }
  function paint(st) {
    clear(live2);
    if (st.running) live2.append(...report(st.current, true));
    else if (st.last) live2.append(...report(st.last, false));
    form.classList.toggle('hidden', st.running);
    clearInterval(probeTimer);
    if (st.running) probeTimer = setInterval(() => { if (tab !== 'probe') return clearInterval(probeTimer); api('/admin/rehearsal').then(paint).catch(() => {}); }, 1000);
  }
  box.append(form, live2);
  api('/admin/rehearsal').then(paint).catch((e) => clear(live2).append(h('p', { class: 'small muted' }, e.message)));
  return box;
}

// ---------- Live-Test: jede Funktion mit dem echten Setup ----------
let ltTimer = null;
const LT_IC = { ok: ['ok', '✓'], warn: ['warn', '!'], fail: ['fail', '✕'], skipped: ['', '–'], cancelled: ['', '×'], running: ['warn', '●'], pending: ['', '○'] };
function viewLiveTest() {
  clearInterval(ltTimer);
  const s = data.settings, testOn = s.test.enabled;
  const box = h('div', { class: 'stack', style: 'gap:16px' });
  const runBox = h('div', { class: 'stack', style: 'gap:16px' });
  const memo = { cur: '', list: '', head: '' };
  const qrCache = new Map();
  const ans = (step, value) => safe(async () => paint(await api('/admin/livetest/answer', { method: 'POST', body: { step, value } })))();
  const ic = (st) => h('div', { class: `prep-ic ${LT_IC[st]?.[0] || ''}` }, LT_IC[st]?.[1] || '?');
  const checkList = (checks) => h('div', { class: 'stack', style: 'gap:4px' }, ...checks.map((c) => h('div', { class: 'row nowrap small' },
    h('span', { class: `badge ${c.ok === true ? 'ok' : c.ok === false ? 'bad' : ''}` }, c.ok === true ? '✓' : c.ok === false ? '✕' : 'i'), h('span', {}, h('b', {}, c.label), c.detail ? ` – ${c.detail}` : ''))));

  // Was ist echt, was simuliert?
  const pl = (n) => s.spotify.players[n].connected;
  const setupInfo = h('div', { class: 'grid three' },
    ...[['Spotify-App', data.spotifyConfigured], ['Player 1', pl(1)], ['Player 2', pl(2)], ['Pi / X32', s.x32.adapter === 'http'], ['Mikrofone', (s.x32.channels.mics || []).length > 0], ['Alarm (ntfy)', s.notify.enabled && !!s.notify.topic]]
      .map(([k, ok]) => h('div', { class: 'row nowrap small' }, h('span', { class: `badge ${ok ? 'ok' : 'warn'}` }, ok ? 'echt' : 'fehlt'), k)));
  const chks = {};
  const resetBefore = chk(true), resetAfter = chk(false);
  const stepsBox = h('div', { class: 'grid three' });
  const form = h('div', { class: 'card stack' }, h('h2', {}, 'Live-Test starten'),
    h('p', { class: 'small muted' }, 'Spielt vor der Party jede Funktion einmal mit den echten Geräten durch. Die App löst jeden Schritt aus, prüft automatisch (Spotify-Status, Pegel am Pult, Mikrofone …) und fragt dich nur, wo ein Mensch hinhören oder hinsehen muss. Für Wunsch, Moderation und Beamer nimmst du am besten ein Handy und ein zweites Gerät dazu.'),
    h('p', { class: 'small muted' }, 'Während des Tests bekommt der Testmodus die echten Verbindungen, die Live-Umgebung läuft so lange simuliert. Danach wird automatisch zurückgestellt. Die Live-Daten bleiben unberührt.'),
    !testOn ? h('div', { class: 'banner-pause' }, 'Der Testmodus ist aus. ', h('button', { class: 'small', onclick: () => save({ test: { enabled: true } }, 'Testmodus an') }, 'Testmodus einschalten')) : null,
    h('div', { class: 'eyebrow' }, 'Dein Setup'), setupInfo,
    h('p', { class: 'small muted' }, 'Was fehlt, wird simuliert – der Test läuft trotzdem durch, sagt dir dann aber, dass er nicht echt war.'),
    h('div', { class: 'eyebrow' }, 'Schritte'), stepsBox,
    h('div', { class: 'grid two' }, h('label', { class: 'check' }, resetBefore, 'Testdaten vorher leeren'), h('label', { class: 'check' }, resetAfter, 'Testdaten danach leeren')),
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !testOn, onclick: safe(async () => {
      const skip = Object.entries(chks).filter(([, c]) => !c.checked).map(([id]) => id);
      paint(await api('/admin/livetest/start', { method: 'POST', body: { skip, resetBefore: resetBefore.checked, resetAfter: resetAfter.checked } }));
    }) }, 'Live-Test starten')));

  const linkRow = (l) => {
    const url = `${origin()}${l.path}`;
    if (l.qr && !qrCache.has(url)) qrCache.set(url, qrElement(url, { size: 180 }).catch(() => null));
    const qrHost = h('div');
    if (l.qr) qrCache.get(url).then((q) => { if (q) qrHost.append(q.cloneNode(true)); });
    return h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'linkrow' }, h('div', { class: 'lbl' }, l.label), h('div', { class: 'url' }, url),
      h('button', { class: 'small', onclick: safe(async () => { try { await navigator.clipboard.writeText(url); toast('Link kopiert'); } catch { toast(url); } }) }, 'Kopieren'),
      h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener', style: 'height:32px;padding:0 12px;font-size:.82rem;border-radius:9px' }, 'Öffnen')), qrHost);
  };
  const currentCard = (r, step) => h('div', { class: 'card stack', style: 'border:2px solid var(--ink)' },
    h('div', { class: 'row between' }, h('div', {}, h('div', { class: 'eyebrow' }, step.group), h('h2', {}, step.title)), ic(step.status)),
    h('p', { class: 'small muted' }, step.help),
    step.waiting ? h('div', { class: 'banner-pause' }, step.waiting) : null,
    ...(step.links || []).map((l) => linkRow(l)),
    step.question ? h('div', { class: 'stack' }, h('div', { class: 'big', style: 'font-size:1.25rem;font-weight:700' }, step.question.text),
      h('div', { class: 'row' }, h('button', { class: 'primary', style: 'min-width:120px;height:48px', onclick: () => ans(step.id, 'yes') }, `✓ ${step.question.yes}`), h('button', { class: 'outline-bad', style: 'min-width:120px;height:48px', onclick: () => ans(step.id, 'no') }, `✕ ${step.question.no}`))) : null,
    (step.actions || []).length ? h('div', { class: 'row' }, ...step.actions.map((a) => h('button', { class: a.id === 'open-levels' || a.id === 'retry' ? 'primary' : '', onclick: () => {
      if (a.id === 'open-levels') return openLevels({ base: `/${r.prefix}`, intro: 'Live-Test, Schritt 1: Stell Fader und Lautstärken ein. Starte Testmusik und hör über die Anlage, wie es klingt. Mit „Übernehmen“ geht der Test weiter.' }).then((how) => { if (how === 'confirmed') ans(step.id, 'done'); }).catch((e) => toast(e.message, true));
      ans(step.id, a.id);
    } }, a.label))) : null,
    step.checks?.length ? checkList(step.checks) : null,
    h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => ans(step.id, 'skip') }, 'Schritt überspringen')));
  const stepList = (steps) => h('div', { class: 'card' }, h('h2', {}, 'Alle Schritte'), h('div', { class: 'prep-grp' }, ...steps.map((st) => h('div', { class: 'prep-row' }, ic(st.status),
    h('div', {}, h('div', { style: 'font-weight:620' }, `${st.title}`, h('span', { class: 'tiny muted' }, ` · ${st.group}`)), st.detail ? h('div', { class: 'small muted' }, st.detail) : null,
      st.checks?.length && st.status !== 'running' ? h('details', { class: 'small' }, h('summary', {}, `${st.checks.length} Prüfung${st.checks.length > 1 ? 'en' : ''}`), checkList(st.checks)) : null),
    h('span')))));

  function paint(stt) {
    const r = stt.run;
    form.classList.toggle('hidden', stt.running);
    if (!stepsBox.childNodes.length) {
      for (const d of stt.steps) chks[d.id] = chk(true);
      stepsBox.append(...stt.steps.map((d) => h('label', { class: 'check', title: d.help }, chks[d.id], d.title)));
    }
    clearInterval(ltTimer);
    if (stt.running) ltTimer = setInterval(() => { if (tab !== 'livetest') return clearInterval(ltTimer); api('/admin/livetest').then(paint).catch(() => {}); }, 1000);
    const show = r || stt.last;
    if (!show) { memo.head = memo.cur = memo.list = ''; clear(runBox); return; }
    const done = show.steps.filter((x) => !['pending', 'running'].includes(x.status)).length;
    const cnt = (k) => show.steps.filter((x) => x.status === k).length;
    const headKey = JSON.stringify([stt.running, done, show.verdict, show.simulated]);
    const cur = r && r.steps.find((x) => x.id === r.current);
    const curKey = JSON.stringify(cur ? [cur.id, cur.status, cur.waiting, cur.question, cur.actions, cur.checks, cur.links] : null);
    const listKey = JSON.stringify(show.steps.map((x) => [x.status, x.detail, x.checks.length]));
    if (headKey === memo.head && curKey === memo.cur && listKey === memo.list) return;   // nichts Neues: Knoepfe nicht unter dem Finger austauschen
    memo.head = headKey; memo.cur = curKey; memo.list = listKey;
    const fail = cnt('fail'), warn = cnt('warn');
    const head = stt.running
      ? h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, 'Live-Test läuft …'), h('div', { class: 'row' }, show.simulated ? h('span', { class: 'badge warn' }, 'teilweise simuliert') : h('span', { class: 'badge ok' }, 'echtes Setup'),
        h('button', { class: 'bad', onclick: safe(async () => { if (confirm('Live-Test abbrechen? Die Musik wird ausgeblendet.')) paint(await api('/admin/livetest/stop', { method: 'POST', body: {} })); }) }, '■ Abbrechen'))),
        h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(100 * done / show.steps.length)}%` })), h('div', { class: 'small muted' }, `${done} von ${show.steps.length} Schritten · gestartet ${fmtClock(show.startedAt)} von ${show.by || 'Admin'}`))
      : h('div', { class: `ready ${fail ? 'fail' : warn || show.simulated || show.verdict === 'abgebrochen' ? 'warn' : 'ok'}` }, h('span', { class: `status-dot ${fail ? 'fail' : warn || show.simulated ? 'warn' : 'ok'}`, 'aria-hidden': 'true' }),
        h('div', {}, h('div', { class: 'big' }, `Letzter Live-Test: ${show.verdict}`), h('div', { class: 'small muted' }, `${fmtClock(show.endedAt || show.startedAt)} · ${cnt('ok')} ok · ${warn} Hinweise · ${fail} Fehler · ${cnt('skipped') + cnt('cancelled')} übersprungen${show.simulated ? ' · nur teilweise mit echten Geräten' : ''}`)));
    clear(runBox).append(head, cur ? currentCard(r, cur) : h('span'), stepList(show.steps));
  }
  box.append(form, runBox);
  api('/admin/livetest').then(paint).catch((e) => clear(runBox).append(h('p', { class: 'small muted' }, e.message)));
  return box;
}

// ---------- Erklaerungen (ⓘ) ----------
const HELP = {
  // Wuensche & Regeln
  'Wunsch-Limit pro Gerät': 'Wie viele Wünsche ein Handy in einem Zeitraum abschicken darf. Ein „+1" auf einen schon gewünschten Song zählt mit. Beispiel: 2 Wünsche pro 15 Minuten.',
  'Explicit-Filter': 'Songs mit „Explicit"-Kennzeichen von Spotify: normal behandeln, in der Moderation markieren oder für Gäste ganz sperren.',
  'Texte': 'Was Gäste sehen, wenn Wünsche pausiert/geschlossen sind, und ein optionaler Hinweis der Organisatoren als Popup.',
  'Organisatoren-Hinweis anzeigen': 'Zeigt den Text einmal als Popup auf jedem Gäste-Handy und dauerhaft auf dem Beamer.',
  'Wenn Wünsche pausiert sind': 'Text auf der Gäste-Seite, wenn die Technik die Wünsche kurz pausiert.',
  'Wenn Wünsche geschlossen sind': 'Text auf der Gäste-Seite, wenn die Wünsche geschlossen sind.',
  'Ende-Modus': 'Text, der nach „Ende des Abends" angezeigt wird.',
  'Schon gespielte Songs': 'Ob ein Song, der heute schon lief, noch einmal gewünscht werden darf.',
  'Regel': '„Erlauben": beliebig oft. „Pause": erst nach der Wartezeit wieder. „Sperren": heute gar nicht mehr. Die Moderation kann Songs trotzdem von Hand wieder einreihen.',
  'Moderation': 'Einstellungen, die die Arbeit der Moderation betreffen.',
  'Ablehnungsgründe (eine pro Zeile)': 'Diese Gründe stehen beim Ablehnen als Knöpfe zur Wahl und werden dem Gast angezeigt.',
  'Priorisierte Songs kommen innerhalb der nächsten … Songs': 'Wenn jemand einen Song mit priorisiert, rückt er auf diesen Platz in der Warteschlange vor (1 = als Nächstes).',
  'Fade-Presets': 'Schnellknöpfe für Fade-Zeiten in der Technik-Ansicht.',
  'Wunsch-Voting': 'Gäste sehen offene Wünsche anderer und können „+1" geben. Hier stellst du ein, wie oft.',
  'Beliebteste Wünsche zuerst zeigen': 'Sortiert offene Wünsche nach Stimmen statt nach Eingang – für Gäste und Moderation.',
  'Technik-Grenzen': 'Sicherheitsgrenzen für die Wiedergabe (nur aktiv, wenn die passende Funktion eingeschaltet ist).',
  'Text im Pausen-Modus': 'Wird im Pausen-Modus auf dem Beamer und der Gäste-Seite angezeigt.',
  'Startseite nach der Anmeldung': 'Welche Ansicht sich nach dem Login je Rolle öffnet.',
  // Automatik
  'Warteschlange automatisch sortieren': 'Sortiert noch nicht priorisierte Songs sanft um: nicht zu viel vom selben Genre hintereinander, passende Genres zur Uhrzeit nach vorn.',
  'Automatische Ordnung an': 'Schaltet das automatische Umsortieren der Warteschlange ein.',
  'Genre-Balance': 'So viele Songs derselben Genre-Familie dürfen höchstens direkt hintereinander laufen, wenn es Alternativen gibt.',
  'Betrachtete Wünsche pro Platz': 'Fairness: Für jeden Platz werden nur die ersten so vielen Wünsche betrachtet. Kleiner = näher an der Eingangsreihenfolge.',
  'Stimmungskurve verwenden': 'Zu bestimmten Uhrzeiten bestimmte Genres bevorzugen (nur Vorrang, nichts wird abgelehnt).',
  'Zeitzone der Party': 'Für alle Uhrzeiten (Stimmungskurve, Start-Playlist, Freischaltung). In Deutschland: Europe/Berlin.',
  'Smarter Übergang': 'Der automatische Crossfade beginnt am Ende des Songs, wenn er ausklingt – nicht mitten im Refrain.',
  'Auto-Crossfade beginnt, wenn der Song ausklingt': 'Nutzt Intro-/Outro-Zeiten von Spotify (falls verfügbar). Sonst gilt die feste Vorlaufzeit aus der Technik-Ansicht.',
  'Lückenfüller': 'Wenn die Warteschlange fast leer ist, legt die App Songs aus einer Playlist nach, damit es keine Stille gibt.',
  'Bei leerer Warteschlange automatisch Songs einreihen': 'Schaltet den Lückenfüller ein. Wünsche kommen immer vor die automatisch eingereihten Songs.',
  'Playlist (öffentlich oder dein eigenes Konto)': 'Link (open.spotify.com/playlist/…) oder ID der Playlist, aus der aufgefüllt wird.',
  'Abend-Start': 'Start-Playlist zum Auftakt und die Freischaltung der Wünsche zu einer Uhrzeit.',
  'Playlist (Link oder ID)': 'Diese Playlist läuft zum Auftakt, bis die ersten Wünsche angenommen werden. Danach kommen Wünsche immer vor ihre Songs.',
  'Automatisch starten um': 'Die Start-Playlist startet zu dieser Uhrzeit von selbst (einmal pro Abend). Ohne Haken: Knopf in der Technik.',
  'Wünsche sind zu, bis sie freigeschaltet werden': 'Beim Einschalten werden die Wünsche sofort geschlossen. Gäste sehen den Hinweis mit Countdown.',
  'Automatisch freischalten um': 'Zu dieser Uhrzeit öffnen die Wünsche von selbst. Freischalten von Hand geht immer (Technik/Admin).',
  'Hinweis für Gäste': 'Text auf der Gäste-Seite und dem Beamer, solange die Wünsche zu sind. {zeit} wird durch die Uhrzeit ersetzt.',
  'Notfall-Playlist': 'Ein Knopf in der Technik stoppt alles und startet diese Playlist – falls etwas ausfällt.',
  'Playlist': 'Link oder ID der Playlist.',
  'Auf Player': 'Auf welchem Spotify-Player die Notfall-Playlist läuft.',
  'Gemischt abspielen': 'Zufällige Reihenfolge.',
  'Alarm aufs Handy (ntfy)': 'Die App schickt Meldungen bei Problemen an die ntfy-App auf deinem Handy.',
  'Benachrichtigungen an': 'Schaltet alle Handy-Meldungen ein oder aus.',
  'Server': 'ntfy-Server: https://ntfy.sh oder dein eigener.',
  'Topic': 'Kanalname in ntfy. Wähle einen schwer zu erratenden Namen – wer ihn kennt, kann mitlesen.',
  'Zugriffstoken (nur bei geschütztem Server)': 'Nur nötig, wenn dein ntfy-Server eine Anmeldung verlangt.',
  'Alarm erst nach … Sekunden Störung': 'Kurzes Ruckeln löst keinen Alarm aus – erst wenn ein Problem so lange anhält.',
  'Automatische Backups': 'Sicherungen der Datenbank (Wünsche, Codes, Einstellungen).',
  'Datenbank regelmäßig sichern': 'Legt in festen Abständen eine Kopie an und behält die letzten N.',
  // Design / Poster
  'Name der Veranstaltung': 'Erscheint oben in allen Ansichten, auf dem Beamer, Poster und im PDF.',
  'Untertitel': 'Kurzer Zusatz, z. B. „Sommerfest 2026".',
  'Akzentfarbe (Buttons, Zähler …)': 'Farbe für Knöpfe und Hervorhebungen. Im Dunkelmodus wird sie automatisch aufgehellt.',
  'Ziel': 'Wohin der QR-Code führt: echte Party oder Testmodus.',
  'Überschrift': 'Großer Text auf dem Plakat.',
  // Verbindungen
  'Client ID': 'Aus dem Spotify-Developer-Dashboard deiner App.',
  'Client Secret': 'Aus dem Spotify-Developer-Dashboard. Wird verschlüsselt gespeichert.',
  'Spotify-Apps (Developer Dashboard)': 'Jede App aus developer.spotify.com hat ein eigenes Anfrage-Limit (ca. 30-Sekunden-Fenster). Mit mehreren Apps verteilt sich die Gäste-Suche, und fällt eine App ins Limit, springt die nächste ein. Im Entwicklungsmodus erlaubt eine App nur wenige Spotify-Konten – dann Player 1 und 2 über verschiedene Apps verbinden.',
  'Ollama-Adresse': 'Adresse deines Ollama-Servers inkl. Port, z. B. http://192.168.178.50:11434 oder https://ollama.example.de. Der Server muss vom Party-Server aus erreichbar sein (gleiches Netz oder VPN).',
  'Zugangs-Token': 'Nur nötig, wenn Ollama hinter einem Reverse-Proxy mit Anmeldung steht (wird als Bearer-Token gesendet und verschlüsselt gespeichert).',
  'Modell': 'Ein Modell für alle KI-Funktionen. „Modelle laden“ fragt den Server, welche installiert sind.',
  'Licht-Vorschläge automatisch erzeugen': 'Im Hintergrund bekommt der laufende und die nächsten fünf Songs je einen Lichtvorschlag (einmal pro Song, wird gespeichert).',
  'Leere Warteschlange automatisch per KI auffüllen': 'Läuft Musik und ist die Warteschlange leer (und die Lückenfüller-Playlist liefert nichts), reiht die App selbst einen KI-Vorschlag ein – höchstens alle 2 Minuten.',
  'Maximale Wartezeit (Sekunden)': 'So lange wartet die App auf eine Antwort. Große Modelle auf schwacher Hardware brauchen länger.',
  'Gespeicherte Spotify-Daten': 'Songs, Genres, Suchtreffer, Playlists und Album-Cover, die schon einmal von Spotify geholt wurden, liegen dauerhaft im Speicher (eigene Datei cache.db, nicht in den Backups). Die App fragt sie nicht erneut an – auch nicht nach einem Neustart. Songs/Genres bleiben 30 Tage, Suchen 12 Stunden, Playlists 1 Stunde.',
  'Für die Gäste-Suche mitnutzen': 'An: Suche, Song-Infos und Genres dürfen über diese App laufen. Aus: die App ist nur für den Player da, der über sie verbunden ist (so bleibt ihr Limit ganz für Play/Pause/Crossfade).',
  'Verbinden über App': 'Über welche Spotify-App sich dieser Player anmeldet. Der Player bleibt bei dieser App, bis du ihn neu verbindest.',
  // Live-Test
  'Live-Test starten': 'Spielt jede Funktion einmal mit den echten Geräten durch. Dauert mit Handy und zweitem Gerät etwa 10–15 Minuten.',
  'Testdaten vorher leeren': 'Löscht vor dem Test Wünsche und Warteschlange des Testmodus, damit der Test sauber startet. Live-Daten bleiben unberührt.',
  'Testdaten danach leeren': 'Löscht nach dem Test die Test-Wünsche wieder. Aus lassen, wenn du dir danach noch alles ansehen willst.',
  'Anbindung': '„Simuliert": kein Pult nötig (zum Testen). „Pi 5 / X32": die App steuert das echte Pult über das Relay auf dem Pi.',
  'Pi-URL(s) des Relays': 'Adresse des Relays auf dem Pi. Mehrere durch Komma: zuerst die im LAN (z. B. http://192.168.178.177:8080), dann die per VPN (http://10.8.0.2:8080). Die App nimmt automatisch die, die antwortet.',
  'Token': 'Das geheime Token aus der .env des Pi (RELAY_TOKEN).',
  'Player 1 (Kanal L / R)': 'Eingangskanäle am X32, auf denen Player 1 liegt. 1 Kanal = Mono, 2 = Stereo. Leer = nicht benutzt.',
  'Player 2 (Kanal L / R)': 'Eingangskanäle am X32, auf denen Player 2 liegt.',
  'Mikrofon-Kanäle (bis zu 3)': 'Kanäle der Mikrofone. Daran erkennt die App Durchsagen (Ducking, Anzeige).',
  'Namen der Mikrofone': 'So heißen die Mikrofone in Technik- und Anzeige-Ansicht.',
  'Echte Verbindungen (Spotify/Pi) nutzt': 'Nur eine Umgebung steuert die echten Geräte. Für Tests vor der Party: „Testmodus", während der Party: „Live".',
  'Simulations-Tempo im Testmodus (Faktor)': 'Im Testmodus laufen simulierte Songs so viel schneller – praktisch, um Übergänge zu testen.',
  // VPN
  'Hinter diesem Gerät liegen weitere Geräte': 'Für den Pi mit X32: Die Adressen 10.8.0.192–255 werden zu diesem Gerät geleitet. Das X32 ist dann von zu Hause unter 10.8.0.200 erreichbar.',
  // SSO
  'SSO aktivieren': 'Zeigt auf der Login-Seite „Mit SSO anmelden". Codes und Passkeys funktionieren weiter.',
  'Issuer-URL': 'Bei Authentik: die „OpenID-Konfigurations-Aussteller"-URL des Providers, z. B. https://auth.example.de/application/o/schulhausparty/.',
  'Client-ID': 'Aus dem Provider deines Identity-Providers.',
  'Client-Secret': 'Aus dem Provider. Wird verschlüsselt gespeichert und nie wieder angezeigt.',
  'Beschriftung des Anmelde-Knopfs': 'Text des SSO-Knopfs auf der Login-Seite.',
  'Scopes': 'Welche Angaben die App anfragt. Standard: openid profile email.',
  'Name des Gruppen-Felds': 'In welchem Feld der Anbieter die Gruppen liefert. Bei Authentik: groups.',
  'Wer in keiner dieser Gruppen ist, bekommt': 'Rolle für Personen ohne passende Gruppe – oder kein Zugang.',
  'Neue Konten automatisch anlegen': 'An: Wer per Gruppe eine Rolle bekommt, erhält automatisch ein Konto. Aus: Nur wer schon mit einem bestehenden Zugang verbunden ist, kommt per SSO hinein.',
  'Bestehende Zugänge per E-Mail verbinden': 'Hat ein Zugang unter Codes eine E-Mail (Knopf „E-Mail“) und meldet sich jemand mit genau dieser bestätigten E-Mail per SSO an, wird er automatisch verbunden.',
  'Admin-Rolle per SSO erlauben': 'Sonst werden Admin-Gruppen ignoriert. SSO-Admins sind nicht der Head-Admin (z. B. kein VPN, kein Passwort ändern).',
  // Schutz vor Ueberlastung
  'Schutz aktiv': 'Begrenzt Anfragen pro Adresse und Gerät und sperrt Dauerfeuer automatisch.',
  'Angriffsmodus': 'Setzt alle Grenzen auf 20 %. Bei einem laufenden Angriff einschalten, danach wieder aus.',
  'Seiten & Team pro Adresse/Min.': 'Seitenaufrufe und Team-Anfragen pro Absender-Adresse und Minute.',
  'Dateien pro Adresse/Min.': 'Abrufe von Skripten, Styles und Logo pro Adresse. Jeder Gast lädt beim Öffnen ca. 6 Dateien.',
  'Gäste-Anfragen pro Adresse/Min.': 'Alle Gäste-Aktionen (Suche, Wunsch, Status) pro Adresse. Im Schul-WLAN teilen sich oft alle Gäste eine Adresse – dann hoch genug wählen!',
  'Schreibende Anfragen pro Adresse/Min.': 'Wünsche, Votes, Entscheidungen usw. pro Adresse.',
  'Anfragen pro Gäste-Gerät/Min.': 'Grenze pro Handy, unabhängig von der Adresse. Damit bremst man einzelne Störer, ohne alle im WLAN zu treffen.',
  'Wünsche pro Adresse/15 Min.': 'Zusätzlich zum Limit pro Gerät: Wünsche von einer Adresse insgesamt.',
  'Neue Geräte pro Adresse/Min.': 'Verhindert, dass jemand durch Löschen der Cookies immer wieder neue Wunsch-Kontingente bekommt.',
  'Live-Verbindungen pro Adresse': 'Jeder Gast hält eine Live-Verbindung. Im Schul-WLAN: mindestens so viele wie erwartete Gäste.',
  'Live-Verbindungen insgesamt': 'Obergrenze aller Live-Verbindungen zusammen.',
  'Gleichzeitige Anfragen (Gäste)': 'Werden es mehr, bekommen Gäste kurz „gleich nochmal versuchen". Das angemeldete Team ist ausgenommen.',
  'Max. offene Wünsche': 'Sind so viele Wünsche offen, nimmt die App vorübergehend keine neuen an.',
  'Sperre nach … Abweisungen/Min.': 'Wer so oft pro Minute abgewiesen wird, wird für die Sperrdauer komplett gesperrt.',
  'Sperrdauer (Minuten)': 'Wie lange eine automatische Sperre dauert. Im Admin kann man vorher entsperren.',
  // Passkeys/Sicherheit
  'Admin-Login nur mit Passkey': 'Das Admin-Passwort funktioniert dann nicht mehr. Erst einschalten, wenn ein Passkey sicher funktioniert. Notfall: Server mit ADMIN_RECOVERY=1 starten.',
  'Admin nur von diesen Adressen': 'Admin-Bereich nur von diesen IP-Adressen/Netzen (z. B. 192.168.1.0/24). Leer = überall. Vorsicht: Du kannst dich aussperren.',
  // Generalprobe
  'Gäste': 'So viele simulierte Gäste machen mit.',
  'Dauer (Minuten)': 'Wie lange die Probe läuft. Abbrechen geht jederzeit.',
  'Anlaufzeit (Sekunden)': 'In dieser Zeit kommen die Gäste nach und nach dazu (wie beim Einlass). 0 = alle sofort.',
  'Aktivität': 'Wie viel die Gäste tun. „Normal" entspricht einer lebhaften Party, „Extrem" ist ein Härtetest.',
  'Adressen': 'Verschiedene Adressen = Gäste mit mobilen Daten. Eine Adresse = alle im selben WLAN (z. B. Schul-WLAN) – damit prüfst du die Grenzen „pro Adresse".',
  'Moderation nimmt an (%)': 'Der Moderations-Bot nimmt so viel Prozent der Wünsche an und lehnt den Rest ab.',
  'Moderation entscheidet nach (Sekunden)': 'So lange wartet der Bot, bevor er einen Wunsch entscheidet.',
  'Wiedergabe-Tempo': 'Simulierte Songs laufen so viel schneller, damit in kurzer Zeit viele Übergänge passieren.',
  'Seitenaufrufe mitsimulieren': 'Jeder Gast lädt beim Beitritt die Gäste-Seite mit allen Dateien.',
  'Live-Verbindungen mitsimulieren': 'Jeder Gast hält eine Live-Verbindung offen, wie ein echtes Handy.',
  'Umfrage mitsimulieren': 'In der Mitte startet eine Umfrage, die Gäste stimmen ab.',
  'Testdaten danach zurücksetzen': 'Nach der Probe werden Wünsche und Setlist des Testmodus gelöscht. Die Live-Party wird nie angefasst.',
};
autoHelp(document.getElementById('app'), HELP);
