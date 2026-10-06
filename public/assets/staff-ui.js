import { h, api, clear, safe, toast, fmtTime, fmtClock } from '/assets/app.js';

export const playerName = (n) => `Player ${n}`;

export function connectionDot(c) {
  const cls = c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'warn';
  return h('span', { class: `dot ${cls}` });
}

export function ampel(connections) {
  const items = [['Server', connections.server], ['X32', connections.x32], ['Pi', connections.pi], ['Spotify', connections.spotify], ['Player 1', connections.player1], ['Player 2', connections.player2]];
  return h('div', { class: 'row' }, ...items.map(([name, c]) => h('span', { class: 'badge', title: c.detail }, connectionDot(c), name)),
    h('span', { class: 'muted tiny' }, `Modus: ${connections.mode}`));
}

export function bar(pct, cls = '') { return h('div', { class: `bar ${cls}` }, h('i', { style: `width:${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%` })); }

// ---- Upcoming ----
export function upcomingList(state, { canAct, onAfter } = {}) {
  const box = h('div', { class: 'list' });
  if (!state.upcoming.length) return box.append(h('div', { class: 'muted' }, 'Warteschlange ist leer.')) || box;
  state.upcoming.forEach((u, i) => {
    box.append(h('div', { class: 'item' },
      h('div', { class: 'row between' },
        h('div', {}, h('div', { class: 'title' }, `${i + 1}. ${u.title}`), h('div', { class: 'small muted' }, u.artist)),
        h('div', { class: 'row' },
          u.explicit ? h('span', { class: 'badge warn' }, 'E') : null,
          u.votes > 1 ? h('span', { class: 'badge' }, `+${u.votes - 1}`) : null,
          u.prioritized ? h('span', { class: 'badge bad', title: u.prioritizedBy ? `von ${u.prioritizedBy}` : '' }, `★ Priorisiert${u.prioritizedBy ? ` (${u.prioritizedBy})` : ''}`) : null,
          h('span', { class: `badge p${u.player}` }, playerName(u.player)))),
      canAct ? h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'small', onclick: safe(async () => { const o = await api('/mod/prioritize', { method: 'POST', body: { id: u.id } }); toast(`Priorisiert – kommt auf Platz ${o.position}`); onAfter?.(); }) }, '★ Priorisieren'),
        h('button', { class: 'small ghost', onclick: safe(async () => { await api('/mod/remove', { method: 'POST', body: { id: u.id } }); onAfter?.(); }) }, 'Entfernen')) : null));
  });
  return box;
}

// ---- Wunschkarten (Moderation) ----
export function pendingList(state, { canAct, assign, onAfter }) {
  const box = h('div', { class: 'list' });
  if (!state.pending.length) { box.append(h('div', { class: 'muted' }, 'Keine offenen Wünsche. 🎉')); return box; }
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
    box.append(h('div', { class: 'item' },
      h('div', { class: 'row between' },
        h('div', {}, h('div', { class: 'title' }, r.title), h('div', { class: 'small muted' }, r.artist)),
        h('div', { class: 'row' },
          r.explicit ? h('span', { class: 'badge warn', title: 'Explicit' }, 'E') : null,
          r.votes > 1 ? h('span', { class: 'badge' }, `+${r.votes - 1} Votes`) : null,
          h('span', { class: 'muted tiny' }, age < 1 ? 'gerade eben' : `vor ${age} Min.`))),
      canAct ? h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'ok', onclick: () => decide('approve') }, '✓ Annehmen'),
        h('button', { class: 'bad', onclick: () => { reasonBox.classList.toggle('hidden'); } }, '✕ Ablehnen')) : null,
      canAct ? (reasonBox = h('div', { class: 'row hidden', style: 'margin-top:8px' },
        ...state.settings.rejectReasons.map((reason) => h('button', { class: 'small', onclick: () => decide('deny', reason) }, reason)),
        h('button', { class: 'small ghost', onclick: () => decide('deny') }, 'Ohne Grund'))) : null));
  }
  return box;
}

export function recentList(state) {
  const box = h('div', { class: 'list' });
  for (const r of state.recent.slice(0, 12)) {
    const label = { approved: 'angenommen', playing: 'läuft', played: 'gespielt', denied: 'abgelehnt', removed: 'entfernt' }[r.status] || r.status;
    box.append(h('div', { class: 'item row between' },
      h('div', {}, h('div', { class: 'title small' }, r.title), h('div', { class: 'tiny muted' }, `${r.artist}${r.decidedBy ? ` · ${r.decidedBy}` : ''}`)),
      h('span', { class: `badge ${r.status === 'denied' ? 'bad' : 'ok'}` }, label)));
  }
  return box;
}

export function playerSummary(n, p, { fohStyle = false } = {}) {
  const pct = p.durationMs ? p.positionMs / p.durationMs : 0;
  return h('div', { class: `np player ${n === 2 ? 'p2' : ''}` },
    h('div', { class: 'row between' }, h('strong', {}, playerName(n)), h('span', { class: `badge ${p.playing ? 'ok' : ''}` }, p.playing ? '▶ spielt' : '⏸ gestoppt')),
    h('div', { class: fohStyle ? 'big' : 'title' }, p.title || '—'),
    h('div', { class: 'muted small' }, p.artist || ''),
    bar(pct, `p${n}`),
    h('div', { class: 'row between tiny muted' }, h('span', {}, fmtTime(p.positionMs)), h('span', {}, `-${fmtTime(p.remainingMs)}`)));
}

export { fmtClock };
