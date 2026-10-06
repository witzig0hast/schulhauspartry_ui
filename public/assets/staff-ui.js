import { h, api, clear, safe, toast, fmtTime, fmtClock, cover, eq, icon } from '/assets/app.js';

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
        u.explicit ? h('span', { class: 'badge warn', title: 'Explicit' }, 'E') : null,
        u.votes > 1 ? h('span', { class: 'badge' }, `+${u.votes - 1}`) : null,
        u.prioritized ? h('span', { class: 'badge bad', title: u.prioritizedBy ? `von ${u.prioritizedBy}` : '' }, `★ Prio${u.prioritizedBy ? ` · ${u.prioritizedBy}` : ''}`) : null,
        h('span', { class: `badge p${u.player}` }, `P${u.player}`),
        canAct ? h('button', { class: 'small icon ghost', title: 'Priorisieren', 'aria-label': 'Priorisieren', onclick: safe(async () => { const o = await api('/mod/prioritize', { method: 'POST', body: { id: u.id } }); toast(`Priorisiert – kommt auf Platz ${o.position}`); onAfter?.(); }) }, '★') : null,
        canAct ? h('button', { class: 'small icon ghost', title: 'Entfernen', 'aria-label': 'Entfernen', onclick: safe(async () => { await api('/mod/remove', { method: 'POST', body: { id: u.id } }); onAfter?.(); }) }, '✕') : null)));
  });
  return box;
}

// ---- Wunschkarten (Moderation) ----
export function pendingList(state, { canAct, assign, onAfter }) {
  if (!state.pending.length) return empty('Alles abgearbeitet – keine offenen Wünsche.');
  const box = h('div', { class: 'list' });
  for (const r of state.pending) {
    const age = Math.max(0, Math.round((Date.now() - r.createdAt) / 60000));
    let reasonBox = null;
    const decide = (action, reason) => safe(async () => {
      try {
        const body = { id: r.id, action, reason };
        if (action === 'approve' && assign() !== 'auto') body.player = Number(assign());
        const out = await api('/mod/decide', { method: 'POST', body });
        toast(action === 'approve' ? `Hinzugefügt zu ${playerName(out.request.player)}` : 'Abgelehnt');
      } catch (e) { if (e.status === 409) toast(e.message, true); else throw e; }
      onAfter?.();
    })();
    box.append(h('div', { class: 'item req' },
      h('div', { class: 'req-main' },
        cover(r.title),
        h('div', { class: 'grow' }, h('div', { class: 't' }, r.title), h('div', { class: 'a' }, r.artist)),
        h('div', { class: 'row', style: 'gap:6px;justify-content:flex-end' },
          r.explicit ? h('span', { class: 'badge warn', title: 'Explicit' }, 'Explicit') : null,
          r.votes > 1 ? h('span', { class: 'badge ink' }, `+${r.votes - 1}`) : null,
          h('span', { class: 'muted tiny' }, age < 1 ? 'gerade eben' : `vor ${age} Min.`))),
      canAct ? h('div', { class: 'req-actions' },
        h('button', { class: 'ok', onclick: () => decide('approve') }, '✓  Annehmen'),
        h('button', { class: 'outline-bad', onclick: () => reasonBox.classList.toggle('hidden') }, 'Ablehnen')) : null,
      canAct ? (reasonBox = h('div', { class: 'reasons hidden' },
        ...state.settings.rejectReasons.map((reason) => h('button', { onclick: () => decide('deny', reason) }, reason)),
        h('button', { class: 'ghost', onclick: () => decide('deny') }, 'Ohne Grund'))) : null));
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

export { fmtClock };
