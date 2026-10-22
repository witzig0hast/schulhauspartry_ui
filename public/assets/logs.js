import { h, api, connect, topbar, clear, safe, toast, BASE, $ } from '/assets/app.js';

// Live-Protokoll: alles, was passiert. Zwei Sichten auf dieselben Eintraege:
//   Mensch   – Uhrzeit, Bereich, verstaendlicher Satz, wer es war
//   Maschine – Zeitstempel, Level, Ereignisname und die Rohdaten (JSON), wie sie auch im Export stehen
// Filter: Umgebung, ab welchem Level, Bereiche, Suche. Neue Eintraege kommen live oben dazu (pausierbar).
const app = $('#app');
const LV = { debug: ['', '·', 'Debug'], info: ['', 'i', 'Info'], warn: ['warn', '!', 'Warnung'], error: ['bad', '✕', 'Fehler'] };
const LEVELS = ['debug', 'info', 'warn', 'error'];
const MAX_ROWS = 1500;
let pref = {};
try { pref = JSON.parse(localStorage.getItem('logs.pref') || '{}'); } catch { /* egal */ }
const f = { env: pref.env || '', level: pref.level || 'info', cats: new Set(pref.cats || []), q: '', view: pref.view || 'human' };
let cats = {}, rows = [], paused = false, held = [], me = null, counts = {};
const savePref = () => { try { localStorage.setItem('logs.pref', JSON.stringify({ env: f.env, level: f.level, cats: [...f.cats], view: f.view })); } catch { /* egal */ } };

const pad = (n, l = 2) => String(n).padStart(l, '0');
const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
const jsonOf = (e) => ({ ts: new Date(e.ts).toISOString(), env: e.env, level: e.level, cat: e.cat, event: e.event, msg: e.msg, actor: e.actor, data: e.data });

// JSON mit Farben (sicher: nur Textknoten, kein innerHTML)
function jsonView(v, indent = 0) {
  const sp = '  '.repeat(indent);
  if (v === null) return h('span', { class: 'j-null' }, 'null');
  if (typeof v === 'string') return h('span', { class: 'j-str' }, JSON.stringify(v));
  if (typeof v === 'number') return h('span', { class: 'j-num' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'j-bool' }, String(v));
  const arr = Array.isArray(v);
  const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
  if (!entries.length) return h('span', {}, arr ? '[]' : '{}');
  return h('span', {}, arr ? '[' : '{', '\n', ...entries.flatMap(([k, x], i) => [sp, '  ', arr ? '' : h('span', { class: 'j-key' }, JSON.stringify(k)), arr ? '' : ': ', jsonView(x, indent + 1), i < entries.length - 1 ? ',' : '', '\n']), sp, arr ? ']' : '}');
}

const matches = (e) => (!f.env || e.env === f.env) && LEVELS.indexOf(e.level) >= LEVELS.indexOf(f.level) && (!f.cats.size || f.cats.has(e.cat))
  && (!f.q || `${e.msg} ${e.event} ${JSON.stringify(e.data)} ${JSON.stringify(e.actor)}`.toLowerCase().includes(f.q.toLowerCase()));

function actorText(a) {
  if (!a) return '';
  if (a.kind === 'guest') return a.label || 'Gast';
  if (a.kind === 'ai') return `KI${a.model ? ` (${a.model})` : ''}`;
  if (a.kind === 'system') return 'automatisch';
  return a.label || a.kind || '';
}

function rowEl(e) {
  const [cls, icon] = LV[e.level] || LV.info;
  const detail = h('div', { class: 'lg-detail hidden' });
  const toggle = () => {
    if (!detail.classList.contains('hidden')) { detail.classList.add('hidden'); return; }
    clear(detail).append(
      h('div', { class: 'row small', style: 'gap:14px' }, h('span', {}, h('b', {}, 'Ereignis '), h('code', {}, e.event)), h('span', {}, h('b', {}, 'Zeit '), h('code', {}, new Date(e.ts).toISOString())), h('span', {}, h('b', {}, 'Umgebung '), e.env),
        h('button', { class: 'small ghost', onclick: (ev) => { ev.stopPropagation(); navigator.clipboard.writeText(JSON.stringify(jsonOf(e), null, 2)).then(() => toast('JSON kopiert'), () => toast('Kopieren nicht möglich', true)); } }, 'JSON kopieren')),
      h('pre', { class: 'lg-json' }, jsonView(jsonOf(e))));
    detail.classList.remove('hidden');
  };
  const head = f.view === 'machine'
    ? h('div', { class: 'lg-line mono' }, h('span', { class: 'muted' }, new Date(e.ts).toISOString().slice(11, 23)), h('span', { class: `lg-lv ${e.level}` }, e.level.toUpperCase().padEnd(5)), h('span', { class: 'lg-ev' }, e.event),
      h('span', { class: 'lg-data' }, e.data ? JSON.stringify(e.data) : ''))
    : h('div', { class: 'lg-line' }, h('span', { class: 'mono muted lg-t' }, clock(e.ts).slice(0, 8)), h('span', { class: `lg-ic ${cls}`, title: LV[e.level]?.[2] }, icon),
      h('span', { class: 'badge lg-cat' }, cats[e.cat] || e.cat), e.env !== 'live' ? h('span', { class: `badge ${e.env === 'test' ? 'warn' : ''}` }, e.env === 'test' ? 'Test' : 'System') : null,
      h('span', { class: 'lg-msg' }, e.msg), e.actor ? h('span', { class: 'lg-who muted' }, actorText(e.actor)) : null);
  return h('div', { class: `lg-row lv-${e.level}`, onclick: toggle }, head, detail);
}

const list = h('div', { class: 'lg-list' });
const moreBtn = h('button', { class: 'small', onclick: () => load(true) }, 'Ältere laden');
const newBtn = h('button', { class: 'small primary hidden', onclick: () => { paused = false; flushHeld(); drawControls(); } });
function draw() {
  clear(list).append(...(rows.length ? rows.map(rowEl) : [h('div', { class: 'muted small', style: 'padding:24px;text-align:center' }, 'Keine Einträge für diese Filter.')]));
}
const keyOf = (e) => (e.id != null ? `i${e.id}` : `s${e.seq}`);
function flushHeld() {
  if (!held.length) return;
  // Was schon da ist (z. B. gleichzeitig ueber den ersten Abruf gekommen), nicht doppelt zeigen
  const have = new Set(rows.map(keyOf));
  const fresh = held.filter((e) => matches(e) && !have.has(keyOf(e))).reverse(); held = [];
  rows = [...fresh, ...rows].slice(0, MAX_ROWS);
  for (const e of fresh.reverse()) list.prepend(rowEl(e));
  while (list.childElementCount > MAX_ROWS) list.lastChild.remove();
  if (list.firstChild?.classList.contains('muted')) draw();
  newBtn.classList.add('hidden');
}

async function load(older = false) {
  const qs = new URLSearchParams({ level: f.level, limit: '300' });
  if (f.env) qs.set('env', f.env);
  if (f.cats.size) qs.set('cats', [...f.cats].join(','));
  if (f.q) qs.set('q', f.q);
  if (older && rows.length) qs.set('before', String(rows[rows.length - 1].ts));
  const out = await api(`/logs?${qs}`);
  cats = out.cats; counts = out.counts || {};
  rows = older ? [...rows, ...out.logs].slice(0, MAX_ROWS) : out.logs;
  moreBtn.disabled = out.logs.length < 300;
  drawControls(); draw();
}

// ----- Bedienleiste -----
const search = h('input', { type: 'search', placeholder: 'Suchen (Text, Ereignis, Daten) …', 'aria-label': 'Suchen', value: '' });
let st = null;
search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { f.q = search.value.trim(); load().catch((e) => toast(e.message, true)); }, 300); });
const seg = (items, cur, on) => h('div', { class: 'seg' }, ...items.map(([v, l]) => h('button', { class: v === cur ? 'on' : '', onclick: () => on(v) }, l)));
const controls = h('div', { class: 'stack' });
function drawControls() {
  const reload = () => { savePref(); load().catch((e) => toast(e.message, true)); };
  clear(controls).append(
    h('div', { class: 'row' }, search,
      seg([['', 'Alle'], ['live', 'Live'], ['test', 'Test'], ['system', 'System']], f.env, (v) => { f.env = v; reload(); }),
      seg([['debug', 'Alles'], ['info', 'Info+'], ['warn', 'Warnungen+'], ['error', 'Fehler']], f.level, (v) => { f.level = v; reload(); }),
      seg([['human', '👤 Mensch'], ['machine', '{ } Maschine']], f.view, (v) => { f.view = v; savePref(); drawControls(); draw(); }),
      h('div', { class: 'grow' }),
      h('button', { class: paused ? 'primary' : '', onclick: () => { paused = !paused; if (!paused) flushHeld(); drawControls(); } }, paused ? '▶ Weiter live' : '⏸ Anhalten'),
      newBtn,
      h('a', { class: 'btn small', href: `${BASE}/api/logs/export?${new URLSearchParams({ level: f.level, ...(f.env ? { env: f.env } : {}), ...(f.cats.size ? { cats: [...f.cats].join(',') } : {}), ...(f.q ? { q: f.q } : {}) })}` }, '⬇ Export (JSONL)')),
    h('div', { class: 'row', style: 'gap:6px' }, h('span', { class: 'small muted' }, 'Bereiche:'),
      ...Object.entries(cats).map(([id, label]) => {
        const c = counts[id];
        return h('button', { class: `chip ${f.cats.has(id) ? 'on' : ''}`, title: c ? `letzte Stunde: ${c.total} (${c.warn || 0} Warnungen, ${c.error || 0} Fehler)` : 'letzte Stunde: 0', onclick: () => { if (f.cats.has(id)) f.cats.delete(id); else f.cats.add(id); reload(); } },
          label, c?.error ? h('span', { class: 'badge bad', style: 'margin-left:6px' }, String(c.error)) : c?.warn ? h('span', { class: 'badge warn', style: 'margin-left:6px' }, String(c.warn)) : null);
      }),
      f.cats.size ? h('button', { class: 'small ghost', onclick: () => { f.cats.clear(); reload(); } }, 'alle') : null),
    f.level === 'debug' ? h('div', { class: 'tiny muted' }, me?.role === 'admin' ? 'Debug-Einträge (z. B. jede Spotify-Anfrage) entstehen nur, wenn unten „Debug-Einträge erzeugen“ an ist, und liegen nur im Speicher.' : 'Debug-Einträge entstehen nur, wenn der Admin sie einschaltet.') : h('span'));
}

// ----- Einstellungen (nur Admin) -----
const settingsBox = h('div');
async function drawSettings() {
  if (me?.role !== 'admin') return;
  const s = (await api('/admin/settings')).settings.logs;
  const days = h('input', { type: 'number', class: 'num', min: 1, max: 365, value: s.keepDays });
  const dbg = h('input', { type: 'checkbox', checked: s.debug });
  clear(settingsBox).append(h('details', { class: 'card more' }, h('summary', {}, '⚙ Protokoll-Einstellungen'),
    h('div', { class: 'stack', style: 'margin-top:10px' },
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Einträge aufheben'), days, h('span', { class: 'small muted' }, 'Tage')),
      h('label', { class: 'check' }, dbg, 'Debug-Einträge erzeugen (jede Spotify-Anfrage, Mic schließt, Ducking vorbei – nur im Speicher, nur zur Fehlersuche)'),
      h('p', { class: 'small muted' }, 'Das Protokoll liegt in einer eigenen Datei (logs.db) und ist nicht in den Backups. Gäste erscheinen nie mit Geräte-ID, nur als kurzes Kürzel (gleiches Handy = gleiches Kürzel). Anmeldungen und IP-Adressen (Bereiche „Sicherheit“ und „Admin“) sieht nur der Admin.'),
      h('button', { class: 'primary small', style: 'justify-self:start', onclick: safe(async () => { await api('/admin/settings', { method: 'POST', body: { logs: { keepDays: Number(days.value), debug: dbg.checked } } }); toast('Gespeichert'); }) }, 'Speichern'))));
}

const top = topbar('Protokoll', { nav: true });
app.append(top, h('div', { class: 'wrap stack' }, h('div', { class: 'card stack lg-bar' }, controls), settingsBox, list, h('div', { class: 'row', style: 'justify-content:center' }, moreBtn)));
api('/me').then((m) => { me = m; drawControls(); drawSettings().catch(() => {}); }).catch(() => {});
load().catch((e) => toast(e.message, true));
connect({
  ping: true, onStatus: (ok) => top.setLive(ok),
  onLogs: (batch) => {
    held.push(...batch);
    if (paused) { const n = held.filter(matches).length; newBtn.textContent = `${n} neue`; newBtn.classList.toggle('hidden', !n); return; }
    flushHeld();
  },
});
