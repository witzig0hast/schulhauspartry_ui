import { h, api, connect, topbar, clear, safe, toast, feat, $ } from '/assets/app.js';

// Zeitplan mit Countdown; Technik/Admin pflegen, alle anderen sehen ihn
const app = $('#app');
let items = [], tz = 'Europe/Berlin', canEdit = false;
const list = h('div', { class: 'list' });
const nowHHMM = () => new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const mins = (hhmm) => { const [a, b] = hhmm.split(':').map(Number); return a * 60 + b; };
function paint() {
  const now = mins(nowHHMM());
  const nextIdx = items.findIndex((i) => !i.done && mins(i.at) >= now);
  clear(list).append(...(items.length ? items.map((i, idx) => {
    const diff = mins(i.at) - now;
    return h('div', { class: `item row between nowrap ${i.done ? 'done' : ''} ${idx === nextIdx ? 'next' : ''}` },
      h('div', { class: 'row nowrap' }, h('b', { class: 'mono' }, i.at), h('div', {}, h('div', { class: 't' }, i.title), i.note ? h('div', { class: 'tiny muted' }, i.note) : null)),
      h('div', { class: 'row nowrap' }, idx === nextIdx ? h('span', { class: 'badge ink' }, diff <= 0 ? 'jetzt' : `in ${diff} Min.`) : null, i.public ? h('span', { class: 'badge', title: 'Auf Beamer sichtbar' }, 'öffentlich') : null,
        canEdit ? h('button', { class: 'small', onclick: safe(async () => { await api(`/schedule/${i.id}/done`, { method: 'POST', body: { done: !i.done } }); load(); }) }, i.done ? '↺' : '✓') : null,
        canEdit ? h('button', { class: 'small bad', onclick: safe(async () => { await api(`/schedule/${i.id}`, { method: 'DELETE' }); load(); }) }, '✕') : null));
  }) : [h('div', { class: 'muted' }, 'Noch keine Programmpunkte.')]));
}
async function load() { const d = await api('/schedule'); items = d.items; tz = d.tz; paint(); }
const at = h('input', { type: 'time', value: '20:00' }), title = h('input', { placeholder: 'Programmpunkt, z. B. Siegerehrung', maxlength: 80 }), note = h('input', { placeholder: 'Notiz (optional)', maxlength: 160 }), pub = h('input', { type: 'checkbox' });
const form = h('div', { class: 'card stack hidden' }, h('h2', {}, 'Programmpunkt hinzufügen'), h('div', { class: 'row' }, at, title), note,
  h('label', { class: 'check' }, pub, 'Auf dem Beamer anzeigen (Gäste sehen „Gleich: …“)'),
  h('button', { class: 'primary', onclick: safe(async () => { await api('/schedule', { method: 'POST', body: { at: at.value, title: title.value, note: note.value, public: pub.checked } }); title.value = note.value = ''; toast('Hinzugefügt'); load(); }) }, 'Hinzufügen'));
const bar = topbar('Zeitplan', { nav: true });
app.append(bar, h('div', { class: 'wrap stack' }, h('div', { class: 'card stack' }, h('div', { class: 'row between' }, h('h2', {}, 'Zeitplan'), h('span', { class: 'pill mono', id: 'clk' })), list), form));
api('/me').then((me) => { canEdit = ['admin', 'tech'].includes(me.role); form.classList.toggle('hidden', !canEdit); paint(); }).catch(() => {});
setInterval(() => { $('#clk').textContent = nowHHMM(); paint(); }, 15000); $('#clk').textContent = nowHHMM();
load();
connect({ onStatus: (ok) => bar.setLive(ok), onState: (s) => { if (JSON.stringify(s.schedule) !== JSON.stringify(items)) { items = s.schedule || []; paint(); } } });
void feat;
