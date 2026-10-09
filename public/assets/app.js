// Gemeinsame Helfer fuer alle Ansichten
export const BASE = document.documentElement.dataset.base || '';
export const ENV = document.documentElement.dataset.env || 'live';
export const BUILD = document.documentElement.dataset.build || '?';
export const BRAND = { name: document.documentElement.dataset.brandName || 'Schulhauspartry', tagline: document.documentElement.dataset.brandTag || '', logo: document.documentElement.dataset.brandLogo || '' };

export const FEATURES = new Set((document.documentElement.dataset.features || '').split(',').filter(Boolean));
export const feat = (id) => FEATURES.has(id);

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

// Logo der Veranstaltung (eigenes Bild oder Standard-Symbol)
export function brandLogo(size = '') {
  const box = h('div', { class: `logo ${BRAND.logo ? 'has-img' : ''}`, style: size });
  if (BRAND.logo) box.append(h('img', { src: BRAND.logo, alt: BRAND.name })); else box.append(icon('logo'));
  return box;
}

// Welche Ansichten darf welche Rolle oeffnen (nur zur Navigation, der Server prueft separat)
const STAFF = ['admin', 'tech', 'mod', 'orga', 'display'];
const NAV = [
  { label: 'Licht', path: '/light', roles: ['admin', 'tech', 'orga', 'display', 'light'], hint: 'Für die Lichttechnik: jetzt, nächste Songs, Übergang', f: 'viewLight', main: false },
  { label: 'Bühne', path: '/stage', roles: STAFF, hint: 'Jetzt, Nächster, Uhr, Zeitplan, Mics', f: 'viewStage' },
  { label: 'Zeitplan', path: '/schedule', roles: STAFF, hint: 'Programmpunkte mit Countdown', f: 'viewSchedule' },
  { label: 'Verlauf', path: '/activity', roles: ['admin', 'tech', 'mod', 'orga'], hint: 'Was ist heute passiert?', f: 'viewActivity' },
  { label: 'Charts', path: '/charts', roles: STAFF, hint: 'Wunsch-Rangliste (öffentlich)', f: 'viewCharts' },
  { label: 'Playlist des Abends', path: '/wall', roles: STAFF, hint: 'Was bisher lief (öffentlich)', f: 'viewWall' },
  { label: 'Technik', path: '/tech', roles: ['admin', 'tech'], main: true },
  { label: 'Moderation', path: '/mod', roles: ['admin', 'tech', 'mod', 'orga'], main: true },
  { label: 'Admin', path: '/admin', roles: ['admin'], main: true },
  { label: 'Vorbereitung', path: '/prep', roles: ['admin', 'tech'], f: 'viewPrep', hint: 'Alles vor der Party prüfen & testen' },
  { label: 'Fokus-Modus', path: '/focus', roles: ['admin', 'tech', 'mod'], f: 'viewFocus', hint: 'Schwarz, bis ein Wunsch kommt' },
  { label: 'Live-Wünsche', path: '/ticker', roles: ['admin', 'tech', 'orga', 'display'], f: 'viewTicker', hint: 'Neue Wünsche & Entscheidungen live' },
  { label: 'Analytics', path: '/analytics', roles: STAFF, f: 'viewAnalytics', hint: 'Genres, Interpreten, Zeitverlauf …' },
  { label: 'Board', path: '/board', roles: STAFF, f: 'viewBoard', hint: 'Eigene Ansicht aus Bausteinen' },
  { label: 'Anzeige', path: '/foh', roles: ['admin', 'tech', 'orga', 'display'], f: 'viewFoh', hint: 'FOH-Status zum Ansehen' },
  { label: 'Beamer', path: '/beamer', roles: ['admin', 'tech', 'orga', 'display'], f: 'viewBeamer', hint: 'Großer Bildschirm für Gäste' },
];

// Kopfzeile mit Marke, Navigation, Live-Status und Abmelden
export function topbar(title, { right = [], test = ENV === 'test', live = true, nav = false } = {}) {
  const pill = h('span', { class: 'pill off', title: 'Verbindung' }, h('i', { class: 'dot' }), 'Verbinde …');
  const navBox = h('nav', { class: 'nav' });
  const bar = h('div', { class: 'topbar' },
    h('div', { class: 'brand' }, brandLogo(), h('div', {}, h('div', { class: 'name' }, BRAND.name), h('div', { class: 'sub' }, title))),
    navBox, h('div', { class: 'grow' }), live ? pill : null, ...right,
    nav && passkeysSupported() ? h('button', { class: 'small ghost', title: 'Passkey für dieses Gerät', 'aria-label': 'Passkey', onclick: () => openPasskeys() }, '🔑') : null,
    nav ? h('button', { class: 'small ghost', onclick: logout }, 'Abmelden') : null, themeButton());
  const wrap = h('div', { style: 'position:sticky;top:0;z-index:10' }, test ? h('div', { class: 'testbanner' }, 'Testmodus · keine echte Party') : null, bar);
  bar.style.position = 'static';
  wrap.setLive = (ok) => { pill.className = `pill ${ok ? 'live' : 'off'}`; pill.lastChild.textContent = ok ? 'Live' : 'Getrennt'; };
  if (nav) {
    api('/me').then((me) => {
      const here = location.pathname.replace(/\/$/, '');
      const mine = NAV.filter((n) => n.roles.includes(me.role) && (!n.f || feat(n.f)));
      for (const n of mine.filter((x) => x.main)) navBox.append(h('a', { class: `navlink ${here === BASE + n.path ? 'on' : ''}`, href: BASE + n.path }, n.label));
      const more = mine.filter((x) => !x.main);
      if (more.length) {
        const active = more.find((x) => here === BASE + x.path);
        const menu = h('details', { class: 'menu' }, h('summary', { class: `navlink ${active ? 'on' : ''}` }, active ? active.label : 'Ansichten', ' ▾'),
          h('div', { class: 'menu-list' }, ...more.map((n) => h('a', { href: BASE + n.path, class: here === BASE + n.path ? 'on' : '' }, h('b', {}, n.label), h('span', {}, n.hint || '')))));
        document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.removeAttribute('open'); });
        navBox.append(menu);
      }
    }).catch(() => {});
  }
  return wrap;
}

// QR-Code als SVG-Element (Bibliothek wird nur bei Bedarf geladen)
export async function qrElement(text, { size = 220, cls = 'qr' } = {}) {
  const { default: qrcode } = await import('/assets/qrcode.js');
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const box = h('div', { class: cls, role: 'img', 'aria-label': 'QR-Code', style: `width:${size}px;height:${size}px` });
  box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 16, scalable: true }); // Ausgabe der Bibliothek, enthaelt nur Pfaddaten
  return box;
}

// Kleiner Versions-Hinweis unten links (hilft beim Debuggen: welche Version sieht welches Geraet?)
export function buildTag() {
  let el = document.getElementById('buildtag');
  if (!el) { el = h('div', { class: 'ping', id: 'buildtag' }, `v${BUILD}`); document.body.append(el); }
  return el;
}
addEventListener('DOMContentLoaded', () => buildTag());

// ---- WebSocket mit Reconnect; optionaler Ping (nur Spezialansichten) ----
export function connect({ onState, onGuest, onStatus, ping = false }) {
  let ws, retry = 0, closed = false, pingTimer, pingEl;
  if (ping) { pingEl = buildTag(); pingEl.textContent = `Ping – ms · v${BUILD}`; }
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
      else if (m.type === 'pong' && pingEl) pingEl.textContent = `Ping ${Math.round(performance.now() - m.ts)} ms · v${BUILD}`;
    };
    ws.onclose = (e) => {
      onStatus?.(false); clearInterval(pingTimer);
      if (pingEl) pingEl.textContent = `Ping – offline · v${BUILD}`;
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


// ---- Passkeys (WebAuthn) ----
const b64uToBuf = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer; };
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const passkeysSupported = () => feat('passkeys') && !!window.PublicKeyCredential && !!navigator.credentials;

export async function passkeyLogin() {
  const { options, cid } = await api('/passkey/login/options', { method: 'POST', body: {} });
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: b64uToBuf(options.challenge), rpId: options.rpId, timeout: options.timeout, userVerification: options.userVerification,
    allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  } });
  const r = cred.response;
  return api('/passkey/login/verify', { method: 'POST', body: { cid, response: {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults?.() || {}, authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature), userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined },
  } } });
}

export async function passkeyRegister(label) {
  const o = await api('/passkey/register/options', { method: 'POST', body: {} });
  const cred = await navigator.credentials.create({ publicKey: {
    rp: o.rp, user: { ...o.user, id: b64uToBuf(o.user.id) }, challenge: b64uToBuf(o.challenge), pubKeyCredParams: o.pubKeyCredParams, timeout: o.timeout,
    attestation: o.attestation, authenticatorSelection: o.authenticatorSelection, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
  } });
  const r = cred.response;
  return api('/passkey/register/verify', { method: 'POST', body: { label, response: {
    id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults?.() || {}, authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: bufToB64u(r.clientDataJSON), attestationObject: bufToB64u(r.attestationObject), transports: r.getTransports?.() || [] },
  } } });
}

// Eigene Passkeys ansehen, anlegen, loeschen
export async function openPasskeys() {
  const list = h('div', { class: 'list' });
  const label = h('input', { value: 'Mein Gerät', maxlength: 40 });
  const paint = async () => {
    const { passkeys } = await api('/passkey/mine');
    clear(list).append(...(passkeys.length ? passkeys.map((p) => h('div', { class: 'item row between' }, h('div', {}, h('b', {}, p.label), h('div', { class: 'tiny muted' }, `angelegt ${new Date(p.createdAt).toLocaleDateString('de-DE')}${p.lastUsed ? ` · zuletzt ${new Date(p.lastUsed).toLocaleDateString('de-DE')}` : ''}`)),
      h('button', { class: 'small bad', onclick: async () => { try { await api(`/passkey/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); paint(); } catch (e) { toast(e.message, true); } } }, 'Löschen'))) : [h('div', { class: 'muted small' }, 'Noch kein Passkey.')]));
  };
  const close = modal([h('h2', {}, 'Passkey'), h('p', { class: 'small muted' }, 'Damit meldest du dich auf diesem Gerät per Fingerabdruck, Gesicht oder Geräte-PIN an – ohne Code.'), list,
    h('label', { class: 'field' }, 'Name des Geräts', label),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { try { await passkeyRegister(label.value); toast('Passkey gespeichert'); paint(); } catch (e) { toast(e.name === 'NotAllowedError' ? 'Abgebrochen' : e.message, true); } } }, 'Für dieses Gerät anlegen'), h('button', { onclick: () => close() }, 'Schließen'))]);
  paint().catch(() => {});
}
