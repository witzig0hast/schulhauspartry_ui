import { h, api, BASE, topbar, clear, logout, safe, toast, modal, $, fmtClock } from '/assets/app.js';
import { ampel } from '/assets/staff-ui.js';

const app = $('#app');
let data = null;
const tabs = ['einstellungen', 'codes', 'verbindungen', 'testmodus', 'bericht'];
const tabLabels = { einstellungen: 'Einstellungen', codes: 'Codes', verbindungen: 'Verbindungen', testmodus: 'Testmodus', bericht: 'Bericht & Export' };
let tab = tabs.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'einstellungen';
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
  const presets = s.fadePresets.map((p) => ({ name: h('input', { value: p.name, maxlength: 20 }), sec: num(p.sec, { min: 0.5, max: 60, step: 0.5 }) }));
  return h('div', { class: 'grid two' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Wunsch-Limit pro Gerät'),
      h('div', { class: 'row' }, count, h('span', {}, 'Wünsche pro'), win, h('span', {}, 'Minuten')),
      h('p', { class: 'small muted' }, 'Gilt pro Gerät (Cookie/Token), nicht pro IP. Ein "+1" auf einen schon vorgeschlagenen Song zählt ebenfalls.'),
      field('Explicit-Filter', explicit)),
    h('div', { class: 'card stack' }, h('h2', {}, 'Texte'),
      h('label', { class: 'check' }, noticeOn, 'Organisatoren-Hinweis anzeigen'), noticeText,
      field('Wenn Wünsche pausiert sind', msgs.paused), field('Wenn Wünsche geschlossen sind', msgs.closed), field('Ende-Modus', msgs.ended)),
    h('div', { class: 'card stack' }, h('h2', {}, 'Moderation'),
      field('Ablehnungsgründe (eine pro Zeile)', reasons),
      field('Priorisierte Songs kommen innerhalb der nächsten … Songs', prio)),
    h('div', { class: 'card stack' }, h('h2', {}, 'Fade-Presets'),
      ...presets.map((p) => h('div', { class: 'row' }, p.name, p.sec, h('span', {}, 's')))),
    h('div', { class: 'row', style: 'grid-column:1/-1' }, h('button', { class: 'primary', onclick: () => save({
      limit: { count: Number(count.value), windowMin: Number(win.value) }, explicitMode: explicit.value,
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
    h('div', { class: 'grid two' }, playerBox(1), playerBox(2)),
    h('div', { class: 'card stack' }, h('h2', {}, 'X32 / Pi 5'),
      field('Anbindung', adapter), field('Pi-URL (Relay)', piUrl), field('Token', piToken),
      h('div', { class: 'grid three' }, field('Player 1 (L/R)', h('div', { class: 'row' }, ...p1)), field('Player 2 (L/R)', h('div', { class: 'row' }, ...p2)), field('Mic-Kanäle', h('div', { class: 'row' }, ...mics))),
      h('button', { class: 'primary', onclick: () => save({ x32: { adapter: adapter.value, piUrl: piUrl.value, piToken: piToken.value, channels: { p1: p1.map((i) => Number(i.value)), p2: p2.map((i) => Number(i.value)), mics: mics.map((i) => Number(i.value)) } } }) }, 'Speichern'),
      h('p', { class: 'small muted' }, 'Echte Verbindungen (Spotify, Pi) nutzt immer nur die unter "Testmodus" gewählte Umgebung; die andere läuft simuliert.')));
}

// ---------- Testmodus ----------
function viewTest() {
  const t = data.settings.test;
  const url = `${origin()}/${t.prefix}/`;
  const speed = num(t.mockSpeed, { min: 1, max: 60, step: 1 });
  const real = h('select', {}, h('option', { value: 'live', selected: t.realEnv === 'live' }, 'Live (Party)'), h('option', { value: 'test', selected: t.realEnv === 'test' }, 'Testmodus'));
  return h('div', { class: 'grid two' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Testmodus'),
      h('p', { class: 'small muted' }, 'Gleiche Ansichten wie live, aber unter einer geheimen URL und mit eigenen Daten. Ist der Testmodus aus, liefert die URL 404.'),
      h('div', { class: 'row' }, h('span', { class: `badge ${t.enabled ? 'ok' : ''}` }, t.enabled ? 'AN' : 'AUS'),
        h('button', { class: t.enabled ? '' : 'primary', onclick: () => save({ test: { enabled: !t.enabled } }) }, t.enabled ? 'Ausschalten' : 'Einschalten')),
      h('div', { class: 'small muted' }, 'Test-URL (Gäste-Seite):'), h('code', { style: 'user-select:all;word-break:break-all' }, url),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, 'Öffnen'),
        h('button', { onclick: () => { if (confirm('Neue Test-URL erzeugen? Die alte funktioniert dann nicht mehr.')) save({ test: { regeneratePrefix: true } }); } }, 'URL neu erzeugen'))),
    h('div', { class: 'card stack' }, h('h2', {}, 'Optionen'),
      field('Echte Verbindungen (Spotify/Pi) nutzt', real),
      field('Simulations-Tempo (nur Testmodus, Faktor)', speed),
      h('button', { class: 'primary', onclick: () => save({ test: { realEnv: real.value, mockSpeed: Number(speed.value) } }) }, 'Speichern'),
      h('hr', { style: 'border:0;border-top:1px solid var(--line);width:100%' }),
      h('div', { class: 'small muted' }, `Testdaten: ${data.counts.test.pending} offen, ${data.counts.test.approved} in Queue, ${data.counts.test.played} gespielt`),
      h('button', { class: 'bad', onclick: safe(async () => { if (confirm('Alle Testdaten löschen?')) { await api('/admin/reset-test', { method: 'POST', body: { env: 'test' } }); toast('Testdaten gelöscht'); load(); } }) }, 'Testdaten zurücksetzen')));
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
  clear(body).append({ einstellungen: viewSettings, codes: viewCodes, verbindungen: viewConnections, testmodus: viewTest, bericht: viewReport }[tab]());
}

app.append(topbar('Admin', { live: false, right: [h('button', { class: 'ghost small', onclick: logout }, 'Abmelden')] }), h('div', { class: 'wrap' }, tabBar, body));
load().catch((e) => toast(e.message, true));
