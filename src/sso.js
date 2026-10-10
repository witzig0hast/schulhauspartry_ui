import crypto from 'node:crypto';
import { getDb } from './db.js';
import { settings } from './settings.js';
import { decrypt, sha256 } from './security.js';
import { config } from './config.js';
import { isOn } from './features.js';

// Single Sign-On per OpenID Connect (Authorization-Code-Flow mit PKCE). Getestet fuer Authentik; geht mit jedem OIDC-Anbieter.
// Sicherheit: state + nonce + PKCE, Bindung an den Browser per Cookie, ID-Token wird auf Signatur, Aussteller, Zielgruppe,
// Ablauf und nonce geprueft ("none" wird abgelehnt). Zugang bekommt nur, wer per Gruppen-Zuordnung eine Rolle erhaelt.
const PRIORITY = ['admin', 'tech', 'mod', 'light', 'orga', 'display'];
const ALGS = ['RS256', 'PS256', 'ES256', 'HS256'];

export class SsoError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }

export function ssoConfig() {
  const c = settings().sso;
  const secret = c.clientSecret ? decrypt(c.clientSecret) : (process.env.SSO_CLIENT_SECRET || '');
  return { ...c, secret };
}
export const ssoReady = () => {
  const c = ssoConfig();
  return isOn('sso') && c.enabled && !!c.issuer && !!c.clientId && !!c.secret && !!config.publicUrl;
};
export const redirectUri = () => `${config.publicUrl}/api/sso/callback`;

const isLocal = (u) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);
const okUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && isLocal(u)); } catch { return false; } };
async function getJson(url, init = {}) {
  if (!okUrl(url)) throw new SsoError('config', `Adresse nicht erlaubt (HTTPS nötig): ${url}`);
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000), redirect: 'error' });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { /* kein JSON */ }
  return { ok: res.ok, status: res.status, json: j };
}

// ---------- Discovery & Schluessel (gemerkt) ----------
let discCache = { key: '', ts: 0, doc: null };
export async function discover(force = false) {
  const issuer = ssoConfig().issuer.replace(/\/+$/, '');
  if (!force && discCache.key === issuer && Date.now() - discCache.ts < 10 * 60000) return discCache.doc;
  const r = await getJson(`${issuer}/.well-known/openid-configuration`);
  if (!r.ok || !r.json) throw new SsoError('config', `Discovery fehlgeschlagen (HTTP ${r.status}). Stimmt die Issuer-URL?`);
  const d = r.json;
  if (String(d.issuer || '').replace(/\/+$/, '') !== issuer) throw new SsoError('config', 'Der Aussteller (issuer) der Discovery passt nicht zur eingetragenen URL.');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!okUrl(d[k])) throw new SsoError('config', `Discovery: ${k} fehlt oder ist nicht HTTPS.`);
  discCache = { key: issuer, ts: Date.now(), doc: d };
  return d;
}
let jwksCache = { uri: '', ts: 0, keys: [] };
async function jwkFor(uri, kid, alg) {
  const load = async () => { const r = await getJson(uri); if (!r.ok || !Array.isArray(r.json?.keys)) throw new SsoError('config', 'Schlüsselliste (JWKS) nicht abrufbar.'); jwksCache = { uri, ts: Date.now(), keys: r.json.keys }; };
  if (jwksCache.uri !== uri || Date.now() - jwksCache.ts > 10 * 60000) await load();
  const pick = () => jwksCache.keys.find((k) => (!kid || k.kid === kid) && (!k.use || k.use === 'sig') && (alg.startsWith('ES') ? k.kty === 'EC' : k.kty === 'RSA'));
  let k = pick();
  if (!k) { await load(); k = pick(); }   // Schluesselwechsel beim Anbieter
  return k || null;
}

// ---------- JWT pruefen ----------
export async function verifyJwt(token, { jwksUri, secret }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new SsoError('failed', 'Ungültiges Token');
  let header, payload;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); payload = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new SsoError('failed', 'Token nicht lesbar'); }
  const alg = header.alg;
  if (!ALGS.includes(alg)) throw new SsoError('failed', `Signatur-Verfahren nicht erlaubt: ${alg}`);   // schliesst "none" aus
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), sig = Buffer.from(parts[2], 'base64url');
  let ok = false;
  if (alg === 'HS256') {
    if (!secret) throw new SsoError('failed', 'Kein Client-Secret für HS256');
    const mac = crypto.createHmac('sha256', secret).update(data).digest();
    ok = mac.length === sig.length && crypto.timingSafeEqual(mac, sig);
  } else {
    const jwk = await jwkFor(jwksUri, header.kid, alg);
    if (!jwk) throw new SsoError('failed', 'Signaturschlüssel nicht gefunden');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    if (alg === 'RS256') ok = crypto.verify('sha256', data, key, sig);
    else if (alg === 'PS256') ok = crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig);
    else ok = crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
  }
  if (!ok) throw new SsoError('failed', 'Signatur ungültig');
  return payload;
}

// ---------- Anmeldung starten / abschliessen ----------
const pending = new Map(); // state -> { nonce, verifier, bind, next, exp }
const sweep = () => { const n = Date.now(); for (const [k, v] of pending) if (v.exp < n) pending.delete(k); };
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');

export async function startLogin(next, link = null) {
  const c = ssoConfig(), d = await discover();
  sweep();
  const state = rnd(), nonce = rnd(), verifier = rnd(48), bind = rnd();
  pending.set(state, { nonce, verifier, bind, link, next: typeof next === 'string' ? next : '', exp: Date.now() + 10 * 60000 });
  const u = new URL(d.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri(), scope: c.scopes || 'openid profile email', state, nonce,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString();
  return { url: u.toString(), bind };
}

export function mapRole(claims, c = ssoConfig()) {
  const raw = claims[c.groupsClaim || 'groups'];
  const groups = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((g) => String(g?.name ?? g));
  const roles = new Set();
  for (const r of c.roleMap || []) if (groups.includes(r.group)) roles.add(r.role);
  if (!roles.size && c.defaultRole) roles.add(c.defaultRole);
  if (!c.allowAdmin) roles.delete('admin');                           // Admin per SSO nur, wenn ausdruecklich erlaubt
  return PRIORITY.find((r) => roles.has(r)) || null;
}

export async function completeLogin({ code, state, bind }) {
  const c = ssoConfig(), d = await discover();
  const p = pending.get(String(state));
  pending.delete(String(state));                                      // nur einmal verwendbar
  if (!p || p.exp < Date.now()) throw new SsoError('expired', 'Anmeldung abgelaufen');
  const a = Buffer.from(String(bind || '')), b = Buffer.from(p.bind);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new SsoError('failed', 'Anmeldung gehört nicht zu diesem Browser');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri(), code_verifier: p.verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const methods = d.token_endpoint_auth_methods_supported;
  if (Array.isArray(methods) && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) { form.set('client_id', c.clientId); form.set('client_secret', c.secret); }
  else headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.secret)}`).toString('base64')}`;
  const t = await getJson(d.token_endpoint, { method: 'POST', headers, body: form });
  if (!t.ok || !t.json?.id_token) throw new SsoError('failed', `Token-Austausch fehlgeschlagen (HTTP ${t.status})`);
  const claims = await verifyJwt(t.json.id_token, { jwksUri: d.jwks_uri, secret: c.secret });
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (String(claims.iss || '').replace(/\/+$/, '') !== String(d.issuer).replace(/\/+$/, '')) throw new SsoError('failed', 'Falscher Aussteller');
  if (!aud.includes(c.clientId) || (aud.length > 1 && claims.azp !== c.clientId)) throw new SsoError('failed', 'Token ist nicht für diese App');
  if (!(claims.exp > now - 60)) throw new SsoError('expired', 'Token abgelaufen');
  if (claims.iat && claims.iat > now + 300) throw new SsoError('failed', 'Token aus der Zukunft');
  if (claims.nonce !== p.nonce) throw new SsoError('failed', 'nonce stimmt nicht');
  if (!claims.sub) throw new SsoError('failed', 'Kein Benutzer im Token');
  // fehlen die Gruppen im ID-Token, aus dem Userinfo-Endpunkt nachladen (mit dem gleichen "sub")
  const gk = c.groupsClaim || 'groups';
  if (claims[gk] == null && d.userinfo_endpoint && t.json.access_token) {
    const u = await getJson(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${t.json.access_token}`, Accept: 'application/json' } }).catch(() => null);
    if (u?.ok && u.json?.sub === claims.sub) Object.assign(claims, { ...u.json, ...claims });
  }
  return { claims, next: p.next, issuer: d.issuer, link: p.link };
}

// ---------- Konto anlegen/aktualisieren ----------
export function provision(issuer, claims, role) {
  const db = getDb();
  const hash = `sso:${sha256(`${issuer}|${claims.sub}`)}`;   // kein gueltiger Code-Hash -> per Code-Login nie nutzbar
  const label = String(claims.name || claims.preferred_username || claims.email || claims.sub).slice(0, 40);
  const row = db.prepare('SELECT * FROM accounts WHERE code_hash = ?').get(hash);
  if (row) {
    if (row.revoked) throw new SsoError('locked', 'Konto gesperrt');
    db.prepare('UPDATE accounts SET role = ?, label = ?, last_seen = ? WHERE id = ?').run(role, label, Date.now(), row.id);
    return { id: row.id, label };
  }
  const info = db.prepare('INSERT INTO accounts(role, label, code_hash, created_at, last_seen) VALUES(?,?,?,?,?)').run(role, label, hash, Date.now(), Date.now());
  return { id: Number(info.lastInsertRowid), label };
}

// Fuer "Verbindung testen" im Admin
export async function testConnection() {
  const c = ssoConfig();
  if (!c.issuer) throw new SsoError('config', 'Issuer-URL fehlt.');
  if (!config.publicUrl) throw new SsoError('config', 'PUBLIC_URL ist nicht gesetzt (nötig für die Rückkehr-Adresse).');
  const d = await discover(true);
  const r = await getJson(d.jwks_uri);
  return { issuer: d.issuer, authorization: d.authorization_endpoint, token: d.token_endpoint, keys: Array.isArray(r.json?.keys) ? r.json.keys.length : 0, groupsSupported: (d.claims_supported || []).includes('groups') || undefined, redirectUri: redirectUri(), secretSet: !!c.secret };
}


// ---------- Bestehende Konten mit SSO verbinden ----------
// Ein SSO-Benutzer (Aussteller + "sub") kann mit einem bestehenden Code-Zugang oder dem Head-Admin verknuepft werden.
// Dann meldet er sich per SSO unter diesem Konto an (Rolle und Verlauf bleiben), statt ein neues Konto zu bekommen.
export const findLink = (issuer, sub) => getDb().prepare('SELECT * FROM sso_links WHERE issuer = ? AND sub = ?').get(issuer, String(sub)) || null;
export const linksOf = (accountId) => getDb().prepare(accountId == null ? "SELECT * FROM sso_links WHERE kind = 'head'" : "SELECT * FROM sso_links WHERE kind = 'account' AND account_id = ?").all(...(accountId == null ? [] : [accountId]));
export const unlinkFor = (accountId) => getDb().prepare(accountId == null ? "DELETE FROM sso_links WHERE kind = 'head'" : "DELETE FROM sso_links WHERE kind = 'account' AND account_id = ?").run(...(accountId == null ? [] : [accountId])).changes;

export function linkIdentity(issuer, claims, target) {   // target: { accountId } (null = Head-Admin)
  const db = getDb();
  const existing = findLink(issuer, claims.sub);
  const same = existing && (target.accountId == null ? existing.kind === 'head' : existing.kind === 'account' && existing.account_id === target.accountId);
  if (existing && !same) throw new SsoError('taken', 'Dieses SSO-Konto ist schon mit einem anderen Zugang verbunden.');
  if (target.accountId != null) {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(target.accountId);
    if (!acc) throw new SsoError('failed', 'Konto nicht gefunden');
    if (String(acc.code_hash).startsWith('sso:')) throw new SsoError('failed', 'Dieses Konto wird schon per SSO verwaltet.');
  }
  if (!same) {
    db.prepare('INSERT INTO sso_links(issuer, sub, kind, account_id, email, name, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(issuer, String(claims.sub), target.accountId == null ? 'head' : 'account', target.accountId ?? null, claims.email ? String(claims.email).toLowerCase().slice(0, 120) : null, String(claims.name || claims.preferred_username || '').slice(0, 60) || null, Date.now());
  }
  // Gab es fuer diese Person schon ein automatisch angelegtes SSO-Konto, wandert dessen Verlauf zum verbundenen Zugang
  const auto = db.prepare('SELECT id FROM accounts WHERE code_hash = ?').get(`sso:${sha256(`${issuer}|${claims.sub}`)}`);
  if (auto && target.accountId != null && auto.id !== target.accountId) {
    db.prepare('UPDATE requests SET decided_by = ? WHERE decided_by = ?').run(target.accountId, auto.id);
    db.prepare('UPDATE requests SET prioritized_by = ? WHERE prioritized_by = ?').run(target.accountId, auto.id);
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(auto.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(auto.id);
  } else if (auto && target.accountId == null) {
    db.prepare('DELETE FROM sessions WHERE account_id = ?').run(auto.id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(auto.id);
  }
}

// Wer meldet sich an? Reihenfolge: bestehende Verknuepfung -> E-Mail-Zuordnung (nur wenn erlaubt) -> neues Konto (nur wenn erlaubt)
export function resolveLogin(issuer, claims, c = ssoConfig()) {
  const db = getDb();
  const link = findLink(issuer, claims.sub);
  if (link) {
    if (link.kind === 'head') return { kind: 'head' };
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(link.account_id);
    if (acc) return { kind: 'account', account: acc };
    db.prepare('DELETE FROM sso_links WHERE issuer = ? AND sub = ?').run(issuer, String(claims.sub));   // Konto wurde geloescht
  }
  if (c.autoLinkEmail && claims.email && claims.email_verified !== false) {
    const rows = db.prepare("SELECT * FROM accounts WHERE lower(email) = ? AND code_hash NOT LIKE 'sso:%' AND revoked = 0").all(String(claims.email).toLowerCase());
    if (rows.length === 1) { linkIdentity(issuer, claims, { accountId: rows[0].id }); return { kind: 'account', account: rows[0] }; }
  }
  if (c.autoCreate === false) return { kind: 'deny', code: 'nolink' };
  const role = mapRole(claims, c);
  return role ? { kind: 'new', role } : { kind: 'deny', code: 'norole' };
}
