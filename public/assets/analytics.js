import { h, api, connect, topbar, clear, safe, fmtClock, $ } from '/assets/app.js';
import { kpi } from '/assets/staff-ui.js';
import { chartCard, hbars, vbars, stackedColumns, shareBars, entityColor, COLORS, fmt } from '/assets/viz.js';

const app = $('#app');
const RANGES = [[0, 'Gesamt'], [15, '15 Min'], [60, '1 Std'], [120, '2 Std'], [360, '6 Std']];
let range = 0;
let data = null;

const top = topbar('Analytics', { nav: true });
const filters = h('div', { class: 'filters' });
const out = h('div', { class: 'stack', style: 'gap:16px' });
const liveDot = h('span', { class: 'pill live' }, h('i', { class: 'dot' }), 'Live – aktualisiert alle 10 s');

function paintFilters() {
  clear(filters).append(h('div', { class: 'seg' }, ...RANGES.map(([m, l]) => h('button', { class: m === range ? 'on' : '', onclick: () => { range = m; paintFilters(); load(); } }, l))), liveDot);
}

const sec = (s) => (s == null ? '–' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`);
const hhmm = (t) => fmtClock(t);

function render() {
  const a = data, k = a.kpis;
  const A = COLORS[0], B = COLORS[1], C = COLORS[2];
  clear(out).append(
    // Kennzahlen
    h('div', { class: 'kpis', style: 'grid-template-columns:repeat(auto-fit,minmax(170px,1fr))' },
      kpi('Wünsche', `${fmt(k.requests)}`, { hot: k.pending > 0 }), kpi('Angenommen', k.approvalRate == null ? '–' : `${k.approvalRate} %`),
      kpi('Ø Entscheidung', sec(k.medianDecisionSec)), kpi('Gespielt', `${fmt(k.plays)} · ${fmt(k.playedMinutes)} min`),
      kpi('Geräte', fmt(k.devices)), kpi('Wünsche je Gerät', k.perDevice ?? '–'), kpi('Explicit-Anteil', k.explicitShare == null ? '–' : `${k.explicitShare} %`), kpi('Blockierte Versuche', fmt(k.blocked))),

    h('div', { class: 'grid two' },
      (() => {
        const labels = a.genres.requested.slice(0, 8).map(([f]) => f);
        const play = new Map(a.genres.played);
        const req = a.genres.requested.slice(0, 8).map(([, n]) => n), pl = labels.map((f) => play.get(f) || 0);
        return chartCard('Genres: gewünscht vs. gespielt', 'Gewünscht inkl. +1 · gespielt = tatsächlich gelaufen',
          () => hbars(labels, [{ name: 'Gewünscht', color: A, values: req }, { name: 'Gespielt', color: B, values: pl }]),
          { legend: [{ color: A, label: 'Gewünscht' }, { color: B, label: 'Gespielt' }], table: { head: ['Genre', 'Gewünscht', 'Gespielt'], rows: labels.map((l, i) => [l, req[i], pl[i]]) } });
      })(),
      (() => {
        const fams = a.genreTimeline.families;
        const series = fams.map((f) => ({ name: f, color: entityColor(f, fams) }));
        const cols = a.genreTimeline.columns.map((c) => ({ label: hhmm(c.t), values: c.values }));
        return chartCard('Genre-Verlauf', `Top-${fams.length}-Genres, je ${a.genreTimeline.step} Min`, () => stackedColumns(cols, series),
          { legend: series.map((s) => ({ color: s.color, label: s.name })), table: { head: ['Zeit', ...fams], rows: cols.map((c) => [c.label, ...c.values]) } });
      })()),

    h('div', { class: 'grid two' },
      chartCard('Top-Interpreten: gewünscht', 'Nach Wünschen inkl. +1', () => hbars(a.artists.requested.map(([n]) => n), [{ name: 'Gewünscht', color: A, values: a.artists.requested.map(([, v]) => v) }]),
        { table: { head: ['Interpret', 'Gewünscht'], rows: a.artists.requested } }),
      chartCard('Top-Interpreten: gespielt', 'Was wirklich gelaufen ist', () => hbars(a.artists.played.map(([n]) => n), [{ name: 'Gespielt', color: A, values: a.artists.played.map(([, v]) => v) }]),
        { table: { head: ['Interpret', 'Gespielt'], rows: a.artists.played } })),

    h('div', { class: 'grid two' },
      chartCard('Annahme-Quote je Genre', 'Welche Genres werden angenommen oder abgelehnt?', () => shareBars(a.genres.acceptance.map((g) => ({ label: g.family, a: g.approved, b: g.denied })), 'Angenommen', 'Abgelehnt', A, B),
        { legend: [{ color: A, label: 'Angenommen' }, { color: B, label: 'Abgelehnt' }], table: { head: ['Genre', 'Angenommen', 'Abgelehnt', 'Quote'], rows: a.genres.acceptance.map((g) => [g.family, g.approved, g.denied, `${g.rate} %`]) } }),
      chartCard('Jahrzehnte', 'Aus welcher Zeit kommen die Wünsche?', () => vbars(a.decades.map(([d]) => d), a.decades.map(([, n]) => n), { color: A }),
        { table: { head: ['Jahrzehnt', 'Wünsche'], rows: a.decades } })),

    h('div', { class: 'grid two' },
      (() => {
        const cols = a.timeline.map((b) => ({ label: hhmm(b.t), values: [b.approved, b.denied, b.pending] }));
        const series = [{ name: 'Angenommen', color: A }, { name: 'Abgelehnt', color: B }, { name: 'Offen', color: C }];
        return chartCard('Wünsche im Zeitverlauf', `je ${a.step} Min`, () => stackedColumns(cols, series), { legend: series.map((s) => ({ color: s.color, label: s.name })), table: { head: ['Zeit', 'Angenommen', 'Abgelehnt', 'Offen'], rows: cols.map((c) => [c.label, ...c.values]) } });
      })(),
      chartCard('Entscheidungsgeschwindigkeit', `Ø ${sec(k.avgDecisionSec)} · Median ${sec(k.medianDecisionSec)}`, () => vbars(a.decisionSpeed.map((d) => d.label), a.decisionSpeed.map((d) => d.count), { color: A }),
        { table: { head: ['Dauer', 'Wünsche'], rows: a.decisionSpeed.map((d) => [d.label, d.count]) } })),

    h('div', { class: 'grid two' },
      chartCard('Beliebtheit der Songs', k.avgPopularity == null ? 'Spotify-Beliebtheit 0–100' : `Ø ${k.avgPopularity} von 100 (Spotify)`, () => vbars(a.popularity.map((p) => p.label), a.popularity.map((p) => p.count), { color: A }),
        { table: { head: ['Beliebtheit', 'Songs'], rows: a.popularity.map((p) => [p.label, p.count]) } }),
      chartCard('Meist unterstützte Songs', 'Die meisten „+1“', () => hbars(a.topVoted.map(([n]) => n), [{ name: 'Stimmen', color: A, values: a.topVoted.map(([, v]) => v) }]),
        { table: { head: ['Song', 'Stimmen'], rows: a.topVoted } })),

    h('div', { class: 'grid two' },
      chartCard('Gäste-Aktivität', 'Wie viele Wünsche pro Gerät', () => hbars(['1 Wunsch', '2 Wünsche', '3 oder mehr'], [{ name: 'Geräte', color: A, values: [a.devices.one, a.devices.two, a.devices.more] }]),
        { table: { head: ['Wünsche je Gerät', 'Geräte'], rows: [['1', a.devices.one], ['2', a.devices.two], ['3+', a.devices.more]] } }),
      chartCard('Blockierte Versuche', 'Wünsche, die nicht möglich waren', () => hbars(['Gesperrt', 'Schon gespielt', 'Explicit'], [{ name: 'Versuche', color: A, values: [a.blocked.blacklist || 0, a.blocked.played || 0, a.blocked.explicit || 0] }]),
        { table: { head: ['Grund', 'Versuche'], rows: [['Gesperrt', a.blocked.blacklist || 0], ['Schon gespielt', a.blocked.played || 0], ['Explicit', a.blocked.explicit || 0]] } })),

    chartCard('Detail-Genres', a.genres.unknownShare ? `${a.genres.unknownShare} % ohne Genre-Angabe` : 'Feine Spotify-Genres, gewünscht', () => hbars(a.genres.detail.map(([g]) => g), [{ name: 'Gewünscht', color: A, values: a.genres.detail.map(([, v]) => v) }]),
      { table: { head: ['Genre', 'Gewünscht'], rows: a.genres.detail } }));
}

const load = safe(async () => {
  out.classList.add('viz-loading');
  data = await api(`/analytics?range=${range}`);
  render();
  out.classList.remove('viz-loading');
});

paintFilters();
app.append(top, h('div', { class: 'wrap' }, filters, out));
connect({ ping: true, onStatus: (ok) => top.setLive(ok), onState: () => {} });
load();
setInterval(load, 10000);
