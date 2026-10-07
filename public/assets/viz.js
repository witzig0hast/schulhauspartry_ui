import { h, clear } from '/assets/app.js';

// ============================================================
// Mini-Diagrammbibliothek (reines HTML/CSS, kein Canvas):
//  - ein Tooltip pro Seite, per-Marke Hover + Tastaturfokus
//  - jede Grafik hat eine Tabellen-Variante (nichts nur per Tooltip lesbar)
//  - Farben ueber --viz-1..5 (validierte Palette, hell/dunkel)
// ============================================================
let tipEl;
function tip() {
  if (!tipEl) { tipEl = h('div', { class: 'viz-tip hidden', role: 'status' }); document.body.append(tipEl); }
  return tipEl;
}
// rows: [{ color?, label, value }] -- alles per textContent (Daten sind nicht vertrauenswuerdig)
function showTip(ev, title, rows) {
  const t = tip();
  clear(t);
  if (title) t.append(h('div', { class: 'tt-title' }, title));
  for (const r of rows) t.append(h('div', { class: 'tt-row' }, r.color ? h('i', { class: 'tt-key', style: `background:${r.color}` }) : null, h('b', {}, String(r.value)), h('span', {}, r.label)));
  t.classList.remove('hidden');
  const x = (ev.clientX ?? ev.target.getBoundingClientRect().left) + 14, y = (ev.clientY ?? ev.target.getBoundingClientRect().top) + 14;
  const w = t.offsetWidth, hh = t.offsetHeight;
  t.style.left = `${Math.min(x, innerWidth - w - 8)}px`; t.style.top = `${Math.min(y, innerHeight - hh - 8)}px`;
}
const hideTip = () => tip().classList.add('hidden');
function hoverable(el, title, rows) {
  el.tabIndex = 0;
  el.addEventListener('pointermove', (e) => showTip(e, title, rows()));
  el.addEventListener('focus', (e) => showTip(e, title, rows()));
  el.addEventListener('pointerleave', hideTip); el.addEventListener('blur', hideTip);
  return el;
}

export const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('de-DE'));
export const COLORS = ['var(--viz-1)', 'var(--viz-2)', 'var(--viz-3)', 'var(--viz-4)', 'var(--viz-5)'];

// Stabile Farbe pro Entitaet (nicht pro Rang): Familie bekommt beim ersten Auftreten einen Slot
const slotOf = new Map();
export function entityColor(name, inUse = []) {
  if (!slotOf.has(name)) {
    const used = new Set([...slotOf.values()]);
    let i = [0, 1, 2, 3, 4].find((k) => !used.has(k));
    if (i == null) i = [0, 1, 2, 3, 4].find((k) => !inUse.some((n) => slotOf.get(n) === k)) ?? 0;
    slotOf.set(name, i);
  }
  return COLORS[slotOf.get(name)];
}

// Karte mit Titel, Untertitel und Diagramm/Tabelle-Umschalter
const tableMode = new Set();
export function chartCard(title, subtitle, build, { table, legend } = {}) {
  const body = h('div', { class: 'viz-body' });
  const btn = h('button', { class: 'small ghost', type: 'button', 'aria-pressed': 'false' }, 'Tabelle');
  let asTable = tableMode.has(title);
  const draw = () => {
    clear(body).append(asTable && table ? tableEl(table) : build());
    btn.textContent = asTable ? 'Diagramm' : 'Tabelle'; btn.setAttribute('aria-pressed', String(asTable));
  };
  btn.addEventListener('click', () => { asTable = !asTable; if (asTable) tableMode.add(title); else tableMode.delete(title); draw(); });
  draw();
  return h('section', { class: 'card viz' },
    h('div', { class: 'row between', style: 'align-items:flex-start' }, h('div', {}, h('h2', {}, title), subtitle ? h('div', { class: 'small muted' }, subtitle) : null), table ? btn : null),
    legend ? h('div', { class: 'legend' }, ...legend.map((l) => h('span', {}, h('i', { style: `background:${l.color}` }), l.label))) : null,
    body);
}

function tableEl({ head, rows }) {
  return h('div', { style: 'overflow-x:auto' }, h('table', {}, h('thead', {}, h('tr', {}, ...head.map((x) => h('th', {}, x)))), h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, String(c))))))));
}

const empty = (t = 'Noch keine Daten.') => h('div', { class: 'muted small', style: 'padding:18px 0' }, t);

// Horizontale Balken. series: [{name,color,values[]}], labels[]; ein oder zwei Serien
export function hbars(labels, series, { unit = '' } = {}) {
  if (!labels.length) return empty();
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  return h('div', { class: 'hb' }, ...labels.map((label, i) => h('div', { class: 'hb-row' },
    h('div', { class: 'hb-label', title: label }, label),
    h('div', { class: 'hb-bars' }, ...series.map((s) => {
      const v = s.values[i] || 0;
      return hoverable(h('div', { class: 'hb-track' }, h('i', { class: 'hb-fill', style: `width:${(v / max) * 100}%;background:${s.color}` }), h('span', { class: 'hb-val' }, `${fmt(v)}${unit}`)),
        label, () => series.map((x) => ({ color: x.color, label: x.name, value: `${fmt(x.values[i] || 0)}${unit}` })));
    })))));
}

// Senkrechte Saeulen (eine Serie)
export function vbars(labels, values, { color = COLORS[0], unit = '' } = {}) {
  if (!labels.length || !values.some((v) => v > 0)) return empty();
  const max = Math.max(1, ...values);
  return h('div', { class: 'vb' }, ...labels.map((l, i) => h('div', { class: 'vb-col' },
    h('span', { class: 'vb-val' }, values[i] ? fmt(values[i]) : ''),
    hoverable(h('div', { class: 'vb-bar-wrap' }, h('i', { class: 'vb-bar', style: `height:${Math.max(values[i] ? 4 : 0, (values[i] / max) * 100)}%;background:${color}` })), l, () => [{ color, label: 'Anzahl', value: `${fmt(values[i])}${unit}` }]),
    h('span', { class: 'vb-label' }, l))));
}

// Gestapelte Saeulen ueber die Zeit. columns: [{label, values[]}], series: [{name,color}]
export function stackedColumns(columns, series) {
  const totals = columns.map((c) => c.values.reduce((a, b) => a + b, 0));
  if (!totals.some((t) => t > 0)) return empty('Noch keine Wünsche in diesem Zeitraum.');
  const max = Math.max(1, ...totals);
  const every = Math.ceil(columns.length / 8);
  return h('div', { class: 'sc' }, ...columns.map((c, i) => h('div', { class: 'sc-col' },
    hoverable(h('div', { class: 'sc-stack' }, ...c.values.map((v, k) => (v ? h('i', { style: `height:${(v / max) * 100}%;background:${series[k].color}` }) : null))),
      c.label, () => series.map((s, k) => ({ color: s.color, label: s.name, value: fmt(c.values[k]) })).concat([{ label: 'gesamt', value: fmt(totals[i]) }])),
    h('span', { class: 'sc-label' }, i % every === 0 ? c.label : ''))));
}

// 100%-Balken (z. B. angenommen / abgelehnt je Genre)
export function shareBars(rows, aName, bName, aColor = COLORS[0], bColor = COLORS[1]) {
  if (!rows.length) return empty('Noch keine Entscheidungen.');
  return h('div', { class: 'hb' }, ...rows.map((r) => {
    const tot = r.a + r.b;
    return h('div', { class: 'hb-row' }, h('div', { class: 'hb-label', title: r.label }, r.label),
      hoverable(h('div', { class: 'share' }, h('i', { style: `flex:${r.a};background:${aColor}` }), h('i', { style: `flex:${r.b};background:${bColor}` }), h('span', { class: 'hb-val' }, `${Math.round(100 * r.a / tot)} %`)),
        r.label, () => [{ color: aColor, label: aName, value: r.a }, { color: bColor, label: bName, value: r.b }]));
  }));
}
