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

// ---- Icons (statische, vertrauenswuerdige SVG-Strings) ----
const ICONS = {
  logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 10v4M9 6v12M13 3v18M17 8v8M21 11v2"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.5-6.9A2 2 0 0016.8 4H7.2a2 2 0 00-1.7 1.1z"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  contrast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 010 18z" fill="currentColor"/></svg>',
};
export function icon(name) {
  const span = document.createElement('span');
  span.style.display = 'contents';
  span.innerHTML = ICONS[name] || '';
  return span.firstChild || span;
}

// Monogramm-Cover: stabile Farbe aus dem Titel
export function cover(title = '?', size = '') {
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.codePointAt(0)) % 360;
  const letters = (title.match(/[\p{L}\p{N}]+/gu) || ['?']).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return h('div', { class: `cover ${size}`, style: `--h:${hash}`, 'aria-hidden': 'true' }, letters);
}
export const eq = (on) => h('span', { class: `eq ${on ? '' : 'off'}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));

// ---- Dark-Mode: folgt dem System, manuell umschaltbar ----
export function themeButton() {
  const labels = { system: 'Auto', light: 'Hell', dark: 'Dunkel' };
  const get = () => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } };
  const btn = h('button', { class: 'theme-btn row nowrap', title: 'Darstellung', type: 'button' });
  const paint = () => { btn.replaceChildren(icon('contrast'), labels[get()]); };
  btn.addEventListener('click', () => {
    const next = { system: 'dark', dark: 'light', light: 'system' }[get()];
    try { if (next === 'system') localStorage.removeItem('theme'); else localStorage.setItem('theme', next); } catch { /* egal */ }
    if (next === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    paint();
  });
  paint();
  return btn;
}

// Welche Ansichten darf welche Rolle oeffnen (nur zur Navigation, der Server prueft separat)
const NAV = [['Technik', '/tech', ['admin', 'tech']], ['Moderation', '/mod', ['admin', 'tech', 'mod', 'orga']], ['Anzeige', '/foh', ['admin', 'tech', 'orga', 'display']], ['Admin', '/admin', ['admin']]];

// Kopfzeile mit Marke, Navigation, Live-Status und Abmelden
export function topbar(title, { right = [], test = ENV === 'test', live = true, nav = false } = {}) {
  const pill = h('span', { class: 'pill off', title: 'Verbindung' }, h('i', { class: 'dot' }), 'Verbinde …');
  const navBox = h('nav', { class: 'nav' });
  const bar = h('div', { class: 'topbar' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, icon('logo')), h('div', {}, h('div', { class: 'name' }, 'Schulhauspartry'), h('div', { class: 'sub' }, title))),
    navBox, h('div', { class: 'grow' }), live ? pill : null, ...right,
    nav ? h('button', { class: 'small ghost', onclick: logout }, 'Abmelden') : null, themeButton());
  const wrap = h('div', { style: 'position:sticky;top:0;z-index:10' }, test ? h('div', { class: 'testbanner' }, 'Testmodus · keine echte Party') : null, bar);
  bar.style.position = 'static';
  wrap.setLive = (ok) => { pill.className = `pill ${ok ? 'live' : 'off'}`; pill.lastChild.textContent = ok ? 'Live' : 'Getrennt'; };
  if (nav) {
    api('/me').then((me) => {
      for (const [label, path, roles] of NAV) {
        if (!roles.includes(me.role)) continue;
        navBox.append(h('a', { class: `navlink ${location.pathname.replace(/\/$/, '') === BASE + path ? 'on' : ''}`, href: BASE + path }, label));
      }
      if (navBox.children.length < 2) navBox.remove();
    }).catch(() => {});
  }
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
