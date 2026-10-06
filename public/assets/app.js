// Gemeinsame Helfer fuer alle Ansichten
export const BASE = document.documentElement.dataset.base || '';
export const ENV = document.documentElement.dataset.env || 'live';

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/guest')) {
    location.href = `${BASE}/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Nicht angemeldet');
  }
  if (!res.ok) { const e = new Error(data?.error || `Fehler ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

export function toast(msg, bad = false) {
  let host = $('.toast-host');
  if (!host) { host = h('div', { class: 'toast-host' }); document.body.append(host); }
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  host.append(t);
  setTimeout(() => t.remove(), bad ? 5000 : 3000);
}
export const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

export function modal(content) {
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) back.remove(); } }, h('div', { class: 'modal' }, content));
  document.body.append(back);
  return () => back.remove();
}

export const fmtTime = (ms) => { ms = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(ms / 60)}:${String(ms % 60).padStart(2, '0')}`; };
export const fmtClock = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

// ---- Dark-Mode: folgt dem System, manuell umschaltbar ----
export function themeButton() {
  const labels = { system: 'Auto', light: 'Hell', dark: 'Dunkel' };
  const get = () => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } };
  const btn = h('button', { class: 'theme-btn ghost', title: 'Darstellung', type: 'button' });
  const paint = () => { btn.textContent = `◐ ${labels[get()]}`; };
  btn.addEventListener('click', () => {
    const next = { system: 'dark', dark: 'light', light: 'system' }[get()];
    try { if (next === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', next); } catch { /* egal */ }
    if (next === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    paint();
  });
  paint();
  return btn;
}

export function topbar(title, { right = [], test = ENV === 'test' } = {}) {
  const bar = h('div', { class: 'topbar' }, h('h1', { class: 'grow' }, title), ...right, themeButton());
  const wrap = h('div', {}, test ? h('div', { class: 'testbanner' }, 'TESTMODUS – keine echte Party') : null, bar);
  return wrap;
}

// ---- WebSocket mit Reconnect; optionaler Ping (nur Spezialansichten) ----
export function connect({ onState, onGuest, onStatus, ping = false }) {
  let ws, retry = 0, closed = false, pingTimer, pingEl;
  if (ping) { pingEl = h('div', { class: 'ping' }, 'Ping – ms'); document.body.append(pingEl); }
  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}${BASE}/ws`);
    ws.onopen = () => {
      retry = 0; onStatus?.(true);
      if (ping) {
        clearInterval(pingTimer);
        const send = () => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping', ts: performance.now() })); };
        send(); pingTimer = setInterval(send, 4000);
      }
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'state') onState?.(m.data);
      else if (m.type === 'guest') onGuest?.(m.data);
      else if (m.type === 'pong' && pingEl) pingEl.textContent = `Ping ${Math.round(performance.now() - m.ts)} ms`;
    };
    ws.onclose = (e) => {
      onStatus?.(false); clearInterval(pingTimer);
      if (pingEl) pingEl.textContent = 'Ping – offline';
      if (closed || e.code === 4004) return;
      setTimeout(open, Math.min(8000, 500 * 2 ** retry++));
    };
  };
  open();
  return { close() { closed = true; ws?.close(); } };
}

export async function logout() {
  try { await api('/logout', { method: 'POST', body: {} }); } catch { /* egal */ }
  location.href = `${BASE}/login`;
}
