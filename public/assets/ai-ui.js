import { h, api, clear, toast, modal, cover, feat } from '/assets/app.js';

// KI-Bausteine fuer Technik, Vorbereitung und Dashboards. Die KI schlaegt vor – uebernommen wird nur per Knopf.
let statusP = null;
export const aiStatus = () => (statusP ||= api('/ai/status').catch(() => null));

const busy = (box, text) => clear(box).append(h('div', { class: 'ai-busy' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text));
const fail = (box, e) => clear(box).append(h('div', { class: 'banner-pause' }, `⚠ ${e.message}`));

// ---- 3: Energie-Kurve ----
async function energy(box) {
  busy(box, 'Die KI hört sich die Warteschlange an …');
  try {
    const r = await api('/ai/energy', { method: 'POST', body: {} });
    const moved = (p, i) => (p.was === i ? '' : p.was > i ? `↑${p.was - i}` : `↓${i - p.was}`);
    clear(box).append(h('div', { class: 'stack' },
      h('div', { class: 'row between' }, h('div', {}, h('div', { class: 'eyebrow' }, 'Stimmung'), h('b', {}, r.mood)),
        h('div', { class: 'ai-energy', title: `Energie ${r.energy} von 10` }, ...Array.from({ length: 10 }, (_, i) => h('i', { class: i < r.energy ? 'on' : '' })))),
      h('div', { class: 'banner-pause' }, r.advice),
      r.changed ? h('div', { class: 'stack', style: 'gap:2px' }, h('div', { class: 'eyebrow' }, 'Vorgeschlagene Reihenfolge'),
        ...r.preview.slice(0, 10).map((p, i) => h('div', { class: 'q-row' }, h('div', { class: 'idx' }, String(i + 1)), cover(p.title, 'sm', p.trackId),
          h('div', { class: 'grow' }, h('div', { class: 't' }, p.title), h('div', { class: 'a' }, p.artist)),
          p.fixed ? h('span', { class: 'badge' }, 'fest') : moved(p, i) ? h('span', { class: 'badge ink' }, moved(p, i)) : h('span')))) : h('div', { class: 'small muted' }, 'Die Reihenfolge passt schon – keine Änderung nötig.'),
      h('div', { class: 'small muted' }, r.why),
      h('div', { class: 'row' },
        r.changed ? h('button', { class: 'primary', onclick: async () => { try { await api('/ai/energy/apply', { method: 'POST', body: { order: r.order } }); toast('Reihenfolge übernommen'); clear(box); } catch (e) { toast(e.message, true); } } }, '✓ Übernehmen') : null,
        h('button', { onclick: () => clear(box) }, 'Verwerfen')),
      feat('autoOrder') ? h('div', { class: 'tiny muted' }, 'Hinweis: Ist die Auto-Ordnung an, sortiert sie beim nächsten Wunsch wieder mit.') : null));
  } catch (e) { fail(box, e); }
}

// ---- 4: Lueckenfueller ----
async function filler(box) {
  busy(box, 'Die KI sucht passende Songs …');
  try {
    const { suggestions } = await api('/ai/filler', { method: 'POST', body: {} });
    clear(box).append(h('div', { class: 'stack', style: 'gap:2px' },
      ...suggestions.map((s) => h('div', { class: 'q-row' }, cover(s.track?.title || s.title, 'sm', s.track?.id),
        h('div', { class: 'grow' }, h('div', { class: 't' }, s.track?.title || s.title), h('div', { class: 'a' }, `${s.track?.artist || s.artist}${s.reason ? ` · ${s.reason}` : ''}`)),
        s.track ? h('button', { class: 'small', onclick: async (e) => { try { await api('/ai/filler/add', { method: 'POST', body: { trackId: s.track.id } }); e.target.replaceWith(h('span', { class: 'badge ok' }, '✓ eingereiht')); } catch (er) { toast(er.message, true); } } }, '+ Einreihen')
          : h('span', { class: 'badge', title: s.note || '' }, s.note || '–'))),
      h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'small', onclick: () => filler(box) }, '↻ Andere Vorschläge'), h('button', { class: 'small ghost', onclick: () => clear(box) }, 'Schließen'))));
  } catch (e) { fail(box, e); }
}

// ---- 7: Fehler-Assistent ----
export function helpResult(r) {
  const cls = { ok: 'ok', warn: 'warn', fail: 'fail' }[r.level] || 'warn';
  return h('div', { class: 'stack' },
    h('div', { class: `ready ${cls}`, style: 'padding:14px 18px' }, h('div', { style: 'font-size:1.6rem' }, r.level === 'ok' ? '✅' : r.level === 'fail' ? '🛑' : '⚠️'), h('div', { style: 'font-weight:650' }, r.summary)),
    r.answer ? h('p', {}, r.answer) : null,
    ...r.problems.map((p) => h('div', { class: 'card stack', style: 'padding:14px 16px' },
      h('div', { class: 'row between' }, h('b', {}, p.title), h('span', { class: `badge ${p.severity === 'hoch' ? 'bad' : p.severity === 'mittel' ? 'warn' : ''}` }, p.severity)),
      h('div', { class: 'small muted' }, p.cause),
      h('ol', { class: 'ai-steps' }, ...p.steps.map((x) => h('li', {}, x))))),
    h('div', { class: 'tiny muted' }, 'Vorschlag der KI – prüf die Schritte mit gesundem Menschenverstand.'));
}
export function helpPanel() {
  const q = h('input', { placeholder: 'Frage (optional), z. B. „Warum ist Player 2 rot?“', maxlength: 400, 'aria-label': 'Frage an die KI' });
  const out = h('div');
  const ask = async () => {
    busy(out, 'Die KI prüft Verbindungen, Fehler und Prüfliste …');
    try { clear(out).append(helpResult(await api('/ai/help', { method: 'POST', body: { question: q.value } }))); } catch (e) { fail(out, e); }
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
  return h('div', { class: 'stack' }, h('div', { class: 'row nowrap' }, q, h('button', { class: 'primary', onclick: ask }, '🩺 Was ist los?')), out);
}
export function openHelpModal() {
  const close = modal([h('h2', {}, '🩺 Was ist los?'), h('p', { class: 'small muted' }, 'Die KI wertet Verbindungen, Fehlerliste, Prüfliste und den letzten Live-Test aus und nennt die nächsten Schritte.'), helpPanel(), h('button', { onclick: () => close() }, 'Schließen')], { wide: true });
}

// Karte fuer die Technik
export async function aiCard() {
  const st = await aiStatus();
  if (!st?.ready) return null;
  const f = st.features;
  if (!f.energy && !f.filler && !f.help) return null;
  const out = h('div');
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' }, h('h2', {}, '🤖 KI-Assistent'), h('span', { class: 'tiny muted' }, st.model)),
    h('div', { class: 'row' },
      f.energy ? h('button', { onclick: () => energy(out) }, '📈 Reihenfolge vorschlagen') : null,
      f.filler ? h('button', { onclick: () => filler(out) }, '➕ Songs vorschlagen') : null,
      f.help ? h('button', { onclick: () => clear(out).append(helpPanel()) }, '🩺 Was ist los?') : null),
    out);
}

// ---- Wunsch-Zusammenfassung (Moderation) ----
export async function summaryBox() {
  const st = await aiStatus();
  if (!st?.ready || !st.features.summary) return null;
  const out = h('div');
  const run = async () => {
    busy(out, 'Die KI liest die offenen Wünsche …');
    try {
      const r = await api('/ai/summary', { method: 'POST', body: {} });
      clear(out).append(h('div', { class: 'stack', style: 'gap:8px' },
        h('div', {}, h('b', {}, r.overview)),
        r.groups.length ? h('div', { class: 'row', style: 'gap:6px' }, ...r.groups.map((g) => h('span', { class: 'badge' }, `${g.name} · ${g.count}`))) : null,
        r.flagged.length ? h('div', { class: 'stack', style: 'gap:2px' }, h('div', { class: 'eyebrow' }, 'Bitte genauer ansehen'),
          ...r.flagged.map((f) => h('div', { class: 'q-row' }, cover(f.title, 'sm', f.trackId), h('div', { class: 'grow' }, h('div', { class: 't' }, f.title), h('div', { class: 'a' }, f.artist)), h('span', { class: 'badge warn' }, f.reason)))) : null,
        r.advice ? h('div', { class: 'small' }, `👉 ${r.advice}`) : null,
        h('div', { class: 'tiny muted' }, 'Nur ein Überblick der KI – entscheiden tust du.')));
    } catch (e) { fail(out, e); }
  };
  return h('div', { class: 'card stack', style: 'padding:12px 14px;margin-bottom:10px' },
    h('div', { class: 'row between' }, h('b', {}, '🤖 Überblick über die offenen Wünsche'), h('button', { class: 'small', onclick: run }, 'Zusammenfassen')), out);
}
