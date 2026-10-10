import { h, api, clear, safe, toast, fmtTime, fmtClock, cover, eq, icon, feat } from '/assets/app.js';
import { actionFor } from '/assets/hotkeys.js';

// Waehrend ein Finger/die Maus gedrueckt ist, darf die Oberflaeche nicht neu aufgebaut werden:
// sonst wird der Knopf unter dem Zeiger ausgetauscht und der Klick geht verloren.
let pressing = false, pressTimer = null;
const releaseFns = new Set();
const endPress = () => { pressing = false; clearTimeout(pressTimer); for (const f of releaseFns) f(); };
addEventListener('pointerdown', () => { pressing = true; clearTimeout(pressTimer); pressTimer = setTimeout(endPress, 4000); }, true);
addEventListener('pointerup', () => { setTimeout(endPress, 60); }, true);
addEventListener('pointercancel', endPress, true);
export const isPressing = () => pressing;
export const onRelease = (fn) => releaseFns.add(fn);

export const playerName = (n) => `Player ${n}`;

export function connectionDot(c) {
  const cls = c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'warn';
  return h('span', { class: `dot ${cls}` });
}

export function ampel(connections) {
  const items = [['Server', connections.server], ['X32', connections.x32], ['Pi', connections.pi], ['Spotify', connections.spotify], ['Player 1', connections.player1], ['Player 2', connections.player2]];
  return h('div', { class: 'row' }, ...items.map(([name, c]) => h('span', { class: 'pill', title: c.detail }, connectionDot(c), name)),
    h('span', { class: 'muted tiny' }, `Modus: ${connections.mode}`));
}

export function bar(pct, cls = '') { return h('div', { class: `bar ${cls}` }, h('i', { style: `width:${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%` })); }

export function kpi(label, value, { hot = false } = {}) {
  return h('div', { class: `kpi ${hot ? 'hot' : ''}` }, h('div', { class: 'eyebrow' }, label), h('div', { class: 'v' }, String(value)));
}

export function empty(text, iconName = 'inbox') {
  return h('div', { class: 'empty' }, h('div', { class: 'ic' }, icon(iconName)), h('div', { class: 'small' }, text));
}

export function cardHead(title, count) {
  return h('div', { class: 'card-head' }, h('div', { class: 'title-wrap' }, h('h2', {}, title), count != null ? h('span', { class: `count ${count ? '' : 'soft'}` }, String(count)) : null));
}

// ---- Sperren (Blacklist) ----
export async function ban(body, label, onAfter) {
  try {
    const out = await api('/mod/blacklist', { method: 'POST', body });
    toast(`${label} gesperrt${out.denied || out.removed ? ` – ${out.denied + out.removed} Eintrag/Einträge entfernt` : ''}`);
    onAfter?.();
  } catch (e) { toast(e.message, true); }
}

// Kleines Menue: Song sperren / Interpret sperren (pro Interpret ein Knopf)
export function banMenu(r, onAfter, reason = '') {
  const menu = h('div', { class: 'reasons hidden' },
    h('button', { class: 'outline-bad', onclick: () => ban({ kind: 'track', trackId: r.trackId, title: r.title, artist: r.artist, reason }, `„${r.title}“`, onAfter) }, '⛔ Song sperren'),
    ...(r.artists || []).map((a) => h('button', { class: 'outline-bad', onclick: () => { if (confirm(`Interpret „${a}“ komplett sperren? Alle Songs von ${a} sind dann nicht mehr wünschbar.`)) ban({ kind: 'artist', artistName: a, reason }, a, onAfter); } }, `⛔ Interpret: ${a}`)),
    feat('deviceBlock') && r.status === 'pending' ? h('button', { class: 'outline-bad', title: 'Dieses Gast-Handy kann nichts mehr wünschen', onclick: () => { if (confirm('Dieses Gast-Gerät sperren? Offene Wünsche davon werden abgelehnt.')) safe(async () => { await api("/mod/device/block", { method: 'POST', body: { requestId: r.id } }); toast('Gerät gesperrt'); onAfter?.(); })(); } }, '🚫 Gerät sperren') : null);
  return menu;
}

// ---- Warteschlange ----
export function upcomingList(state, { canAct, onAfter } = {}) {
  if (!state.upcoming.length) return empty('Die Warteschlange ist leer.', 'note');
  const box = h('div', {});
  state.upcoming.forEach((u, i) => {
    box.append(h('div', { class: `q-row ${u.prioritized ? 'prio' : ''}` },
      h('div', { class: 'idx' }, String(i + 1)),
      cover(u.title, 'sm'),
      h('div', { class: 'grow' }, h('div', { class: 't' }, u.title), h('div', { class: 'a' }, u.artist)),
      h('div', { class: 'row', style: 'gap:6px;justify-content:flex-end' },
        u.auto ? h('span', { class: 'badge', title: 'Automatisch eingereiht (Lückenfüller)' }, 'Auto') : null,
        u.introMs > 20000 ? h('span', { class: 'badge', title: `Langes Intro (${Math.round(u.introMs / 1000)} s)` }, '♪ Intro') : null,
        u.explicit ? h('span', { class: 'badge warn', title: 'Explicit' }, 'E') : null,
        u.votes > 1 ? h('span', { class: 'badge' }, `+${u.votes - 1}`) : null,
        u.prioritized ? h('span', { class: 'badge bad', title: u.prioritizedBy ? `von ${u.prioritizedBy}` : '' }, `★ Prio${u.prioritizedBy ? ` · ${u.prioritizedBy}` : ''}`) : null,
        u.player ? h('span', { class: `badge p${u.player}` }, `P${u.player}`) : null,
        canAct ? h('button', { class: 'small icon ghost', title: 'Priorisieren', 'aria-label': 'Priorisieren', onclick: safe(async () => { const o = await api('/mod/prioritize', { method: 'POST', body: { id: u.id } }); toast(`Priorisiert – kommt auf Platz ${o.position}`); onAfter?.(); }) }, '★') : null,
        canAct ? h('button', { class: 'small icon ghost', title: 'Entfernen', 'aria-label': 'Entfernen', onclick: safe(async () => { await api('/mod/remove', { method: 'POST', body: { id: u.id } }); onAfter?.(); }) }, '✕') : null,
        canAct ? h('button', { class: 'small icon ghost', title: 'Song sperren', 'aria-label': 'Song sperren', onclick: () => { if (confirm(`„${u.title}“ sperren und aus der Warteschlange nehmen?`)) ban({ kind: 'track', trackId: u.trackId, title: u.title, artist: u.artist }, `„${u.title}“`, onAfter); } }, '⛔') : null)));
  });
  return box;
}

// ---- Wunschkarten (Moderation) ----
export function pendingList(state, { canAct, assign, onAfter, list = 'pending', me = null }) {
  const items = list === 'later' ? (state.later || []) : state.pending;
  const claims = new Map((state.claims || []).map((c) => [c.id, c]));
  if (!items.length) return empty(list === 'later' ? 'Nichts zurückgestellt.' : 'Alles abgearbeitet – keine offenen Wünsche.');
  const box = h('div', { class: 'list' });
  for (const r of items) {
    const claim = claims.get(r.id);
    const age = Math.max(0, Math.round((Date.now() - r.createdAt) / 60000));
    let reasonBox = null; const banBox = banMenu(r, onAfter);
    const decide = (action, reason) => safe(async () => {
      try {
        const body = { id: r.id, action, reason };
        if (action === 'approve' && assign() !== 'auto') body.player = Number(assign());
        const out = await api('/mod/decide', { method: 'POST', body });
        toast(action === 'approve' ? `Hinzugefügt zu ${playerName(out.request.player)}` : action === 'later' ? 'Zurückgestellt' : 'Abgelehnt');
      } catch (e) { if (e.status === 409) toast(e.message, true); else throw e; }
      onAfter?.();
    })();
    const take = () => { if (canAct) api('/mod/claim', { method: 'POST', body: { id: r.id } }).catch(() => {}); };
    box.append(h('div', { class: `item req ${claim && claim.by !== me ? 'claimed' : ''}`, onpointerdown: take },
      h('div', { class: 'req-main' },
        cover(r.title),
        h('div', { class: 'grow' }, h('div', { class: 't' }, r.title), h('div', { class: 'a' }, r.artist)),
        h('div', { class: 'row', style: 'gap:6px;justify-content:flex-end' },
          r.explicit ? h('span', { class: 'badge warn', title: 'Explicit' }, 'Explicit') : null,
          r.votes > 1 ? h('span', { class: 'badge ink' }, `+${r.votes - 1}`) : null,
          h('span', { class: 'muted tiny' }, age < 1 ? 'gerade eben' : `vor ${age} Min.`))),
      claim && claim.by !== me ? h('div', { class: 'claim-tag' }, `✋ ${claim.label} bearbeitet gerade …`) : null,
      canAct ? h('div', { class: 'req-actions' },
        h('button', { class: 'ok', onclick: () => decide('approve') }, '✓  Annehmen'),
        h('button', { class: 'outline-bad', onclick: () => { reasonBox.classList.toggle('hidden'); banBox.classList.add('hidden'); } }, 'Ablehnen'),
        list !== 'later' ? h('button', { class: 'ghost', title: 'Später entscheiden', onclick: () => decide('later') }, '⏳ Später') : null,
        h('button', { class: 'ghost', title: 'Song oder Interpret sperren', onclick: () => { banBox.classList.toggle('hidden'); reasonBox.classList.add('hidden'); } }, '⛔ Sperren')) : null,
      canAct ? (reasonBox = h('div', { class: 'reasons hidden' },
        ...state.settings.rejectReasons.map((reason) => h('button', { onclick: () => decide('deny', reason) }, reason)),
        h('button', { class: 'ghost', onclick: () => decide('deny') }, 'Ohne Grund'))) : null,
      canAct ? banBox : null));
  }
  return box;
}

export function recentList(state) {
  if (!state.recent.length) return empty('Noch keine Entscheidungen.', 'note');
  const box = h('div', { class: 'tl' });
  for (const r of state.recent.slice(0, 12)) {
    const label = { approved: 'angenommen', playing: 'läuft', played: 'gespielt', denied: 'abgelehnt', removed: 'entfernt' }[r.status] || r.status;
    box.append(h('div', { class: 'tl-row' },
      h('span', { class: `dot ${r.status === 'denied' || r.status === 'removed' ? 'bad' : 'ok'}` }),
      h('div', { class: 'grow', style: 'overflow:hidden' }, h('div', { style: 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, r.title), h('div', { class: 'tiny muted' }, `${r.artist}${r.decidedBy ? ` · ${r.decidedBy}` : ''}`)),
      h('span', { class: `badge ${r.status === 'denied' || r.status === 'removed' ? 'bad' : 'ok'}` }, label)));
  }
  return box;
}

// Player-Karte (Hero-Stil) fuer Moderation und FOH-Anzeige
const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() - ts) / 60000)); return m < 1 ? 'gerade eben' : m < 60 ? `vor ${m} Min.` : `vor ${Math.floor(m / 60)} h ${m % 60} min`; };

// Verlauf: schon gespielte Songs -> nochmal einreihen oder sperren
export function historyList(state, { canAct, onAfter } = {}) {
  if (!state.history?.length) return empty('Noch nichts gespielt.', 'note');
  const blocked = new Set((state.blacklist || []).filter((b) => b.kind === 'track').map((b) => b.key));
  const box = h('div', {});
  for (const r of state.history) {
    const isBlocked = blocked.has(r.trackId);
    box.append(h('div', { class: 'q-row' },
      cover(r.title, 'sm'),
      h('div', { class: 'grow' }, h('div', { class: 't' }, r.title), h('div', { class: 'a' }, `${r.artist} · ${r.status === 'playing' ? 'läuft jetzt' : ago(r.playedAt)}`)),
      isBlocked ? h('span', { class: 'badge bad' }, 'gesperrt') : null,
      canAct && r.status !== 'playing' && !isBlocked ? h('button', { class: 'small', title: 'Nochmal hinten einreihen', onclick: safe(async () => { const o = await api('/mod/requeue', { method: 'POST', body: { id: r.id } }); toast(`Wieder eingereiht (${playerName(o.player)})`); onAfter?.(); }) }, '↻ Nochmal') : null,
      canAct && !isBlocked ? h('button', { class: 'small icon ghost', title: 'Song sperren (schon gespielt)', onclick: () => { if (confirm(`„${r.title}“ sperren, weil schon gespielt?`)) ban({ kind: 'track', trackId: r.trackId, title: r.title, artist: r.artist, reason: 'Schon gespielt' }, `„${r.title}“`, onAfter); } }, '⛔') : null));
  }
  return box;
}

// Sperrliste + Suche, um direkt etwas zu sperren
export function blacklistPanel(state, { canAct, onAfter } = {}) {
  const wrap = h('div', { class: 'stack' });
  if (canAct) {
    const results = h('div', { class: 'list' });
    let t = null;
    const input = h('input', { type: 'search', placeholder: 'Song suchen, um ihn zu sperren …', maxlength: 80, oninput: () => { clearTimeout(t); t = setTimeout(safe(async () => {
      const q = input.value.trim(); if (q.length < 2) return clear(results);
      const { tracks } = await api(`/mod/search?q=${encodeURIComponent(q)}`);
      clear(results).append(...tracks.map((x) => h('div', { class: 'item row between nowrap' }, h('div', { class: 'req-main grow' }, cover(x.title, 'sm'), h('div', { class: 'grow' }, h('div', { class: 't' }, x.title), h('div', { class: 'a' }, x.artist))),
        h('button', { class: 'small outline-bad', onclick: () => ban({ kind: 'track', trackId: x.id, title: x.title, artist: x.artist }, `„${x.title}“`, () => { input.value = ''; clear(results); onAfter?.(); }) }, '⛔ Sperren'))));
    }), 300); } });
    wrap.append(input, results);
  }
  const list = state.blacklist || [];
  wrap.append(list.length ? h('div', {}, ...list.map((b) => h('div', { class: 'q-row' },
    h('span', { class: 'badge' }, b.kind === 'artist' ? 'Interpret' : 'Song'),
    h('div', { class: 'grow' }, h('div', { class: 't' }, b.kind === 'artist' ? b.artist : b.title), h('div', { class: 'a' }, `${b.kind === 'track' ? `${b.artist} · ` : ''}${b.reason || 'gesperrt'} · ${ago(b.createdAt)}`)),
    canAct ? h('button', { class: 'small', onclick: safe(async () => { await api('/mod/blacklist/remove', { method: 'POST', body: { id: b.id } }); toast('Freigegeben'); onAfter?.(); }) }, 'Freigeben') : null)))
    : empty('Nichts gesperrt.', 'note'));
  return wrap;
}

// ---- Moderator-Chat (Name ist Pflicht, wird pro Geraet gemerkt) ----
export function chatPanel(state, { canWrite, onSent } = {}) {
  let name = ''; try { name = localStorage.getItem('chat.name') || ''; } catch { /* egal */ }
  const nameIn = h('input', { value: name, placeholder: 'Dein Name', maxlength: 24, style: 'max-width:160px', 'aria-label': 'Dein Name' });
  const text = h('input', { placeholder: 'Nachricht an das Team …', maxlength: 400, 'aria-label': 'Nachricht' });
  const list = h('div', { class: 'chat-list' });
  const msgs = state.chat || [];
  list.append(...(msgs.length ? msgs.map((m) => h('div', { class: `chat-msg ${m.name === name ? 'mine' : ''}` }, h('div', { class: 'who' }, `${m.name} · ${fmtClock(m.ts)}`), h('div', {}, m.text))) : [empty('Noch keine Nachrichten.', 'note')]));
  const send = safe(async () => {
    const n = nameIn.value.trim();
    if (!n) { nameIn.focus(); throw new Error('Bitte gib zuerst deinen Namen an.'); }
    if (!text.value.trim()) return;
    try { localStorage.setItem('chat.name', n); } catch { /* egal */ }
    await api('/chat', { method: 'POST', body: { name: n, text: text.value } });
    text.value = ''; onSent?.();
  });
  const form = canWrite ? h('form', { class: 'chat-form', onsubmit: (e) => { e.preventDefault(); send(); } }, nameIn, text, h('button', { class: 'primary', type: 'submit' }, 'Senden')) : h('div', { class: 'small muted' }, 'Nur lesen.');
  setTimeout(() => { list.scrollTop = list.scrollHeight; });
  return h('div', { class: 'chat' }, list, form);
}

export function playerSummary(n, p, { fohStyle = false, onAir = false } = {}) {
  const pct = p.durationMs ? p.positionMs / p.durationMs : 0;
  const idle = !p.title;
  return h('div', { class: `player ${n === 2 ? 'p2' : ''} ${onAir ? 'onair' : ''}` },
    h('div', { class: 'row between', style: 'margin-bottom:12px' },
      h('div', { class: 'row', style: 'gap:8px' }, h('span', { class: 'eyebrow' }, playerName(n)), onAir ? h('span', { class: 'badge ink' }, 'On Air') : null),
      h('div', { class: 'row', style: 'gap:8px' }, eq(p.playing), h('span', { class: `badge ${p.playing ? 'ok' : ''}` }, p.playing ? 'spielt' : 'gestoppt'))),
    h('div', { class: `hero ${idle ? 'idle' : ''}` },
      idle ? h('div', { class: `cover ${fohStyle ? 'lg' : 'lg'}`, style: '--h:0;background:var(--bg-2);color:var(--faint);text-shadow:none;box-shadow:none' }, '–') : cover(p.title, 'lg'),
      h('div', { class: 'meta' }, h('div', { class: 't' }, p.title || 'Kein Song'), h('div', { class: 'a' }, p.artist || 'Bereit'))),
    h('div', { style: 'margin-top:14px' }, bar(pct, `p${n}`), h('div', { class: 'time' }, h('span', {}, fmtTime(p.positionMs)), h('span', {}, `−${fmtTime(p.remainingMs)}`))));
}

export { fmtClock, actionFor };
