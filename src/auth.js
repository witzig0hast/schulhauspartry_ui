import { getDb, getSetting, setSetting } from './db.js';
import {
  sha256, randomToken, randomCode, normalizeCode, hashPassword, verifyPassword,
  parseCookies, cookieString, clientIp, isSecure, RateLimiter,
} from './security.js';
import { config } from './config.js';

export const ROLES = ['admin', 'tech', 'mod', 'orga', 'display'];
export const ROLE_LABELS = { admin: 'Head-Admin', tech: 'Technik', mod: 'Moderation', orga: 'Orga (nur lesen)', display: 'FOH-Anzeige' };
const SESSION_TTL_MS = 12 * 3600 * 1000;

// Wer darf was
export const PERMS = {
  viewTech: ['admin', 'tech'],
  viewMod: ['admin', 'tech', 'mod', 'orga'],
  viewFoh: ['admin', 'tech', 'orga', 'display'],
  viewBoard: ['admin', 'tech', 'mod', 'orga', 'display'],
  viewStats: ['admin', 'tech', 'mod', 'orga', 'display'],
  viewTicker: ['admin', 'tech', 'orga', 'display'],
  viewPrep: ['admin', 'tech'],
  chatWrite: ['admin', 'tech', 'mod'],
  viewAdmin: ['admin'],
  moderate: ['admin', 'tech', 'mod'],
  prioritize: ['admin', 'tech', 'mod'],
  control: ['admin', 'tech'],       // Fader, Fades, Crossfade, Ducking, Not-Aus, Ende
  wishMode: ['admin', 'tech'],      // Wuensche sperren / pausieren
  notice: ['admin', 'tech'],        // Orga-Hinweis
  connections: ['admin', 'tech', 'display'], // Mics, Verbindungsampel
};
export const can = (role, perm) => !!role && (PERMS[perm] || []).includes(role);

const loginLimiter = new RateLimiter(8, 10 * 60 * 1000);
const globalLoginLimiter = new RateLimiter(120, 10 * 60 * 1000);

export function ensureAdminPassword() {
  if (config.adminPassword) {
    const stored = getSetting('adminPasswordHash');
    if (!stored || !verifyPassword(config.adminPassword, stored)) setSetting('adminPasswordHash', hashPassword(config.adminPassword));
  } else if (!getSetting('adminPasswordHash')) {
    console.warn('[auth] Kein ADMIN_PASSWORD gesetzt - Admin-Login ist gesperrt, bis eines gesetzt wird.');
  }
}

export function createAccount(role, label) {
  if (!ROLES.includes(role) || role === 'admin') throw new Error('Ungültige Rolle');
  const code = randomCode();
  const db = getDb();
  const info = db.prepare('INSERT INTO accounts(role,label,code_hash,created_at) VALUES(?,?,?,?)')
    .run(role, String(label || '').slice(0, 40) || role, sha256(normalizeCode(code)), Date.now());
  return { id: Number(info.lastInsertRowid), role, code };
}

export function login(secret, ip) {
  const key = `ip:${ip}`;
  if (!loginLimiter.peek(key).ok || !globalLoginLimiter.peek('all').ok) {
    return { ok: false, status: 429, error: 'Zu viele Versuche. Bitte später erneut versuchen.' };
  }
  const db = getDb();
  const code = normalizeCode(secret);
  const acc = code && db.prepare('SELECT * FROM accounts WHERE code_hash = ? AND revoked = 0').get(sha256(code));
  let session;
  if (acc) {
    session = { accountId: acc.id, role: acc.role };
    db.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(Date.now(), acc.id);
  } else if (secret && verifyPassword(String(secret), getSetting('adminPasswordHash'))) {
    session = { accountId: null, role: 'admin' };
  } else {
    loginLimiter.hit(key); globalLoginLimiter.hit('all');
    return { ok: false, status: 401, error: 'Code oder Passwort falsch.' };
  }
  const token = randomToken(32);
  const now = Date.now();
  db.prepare('INSERT INTO sessions(token_hash, account_id, role, created_at, expires_at) VALUES(?,?,?,?,?)')
    .run(sha256(token), session.accountId, session.role, now, now + SESSION_TTL_MS);
  return { ok: true, token, role: session.role, accountId: session.accountId };
}

export function logout(token) {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function sessionFromToken(token) {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT s.role, s.account_id, s.expires_at, a.revoked, a.label
    FROM sessions s LEFT JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now() || row.revoked) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return { role: row.role, accountId: row.account_id, label: row.label || (row.role === 'admin' ? 'Head-Admin' : row.role) };
}

export function sessionFromRequest(req) {
  return sessionFromToken(parseCookies(req.headers.cookie || '').sid);
}

export function revokeAccount(id) {
  const db = getDb();
  db.prepare('UPDATE accounts SET revoked = 1 WHERE id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE account_id = ?').run(id);
}

export function deleteAccount(id) {
  const db = getDb();
  revokeAccount(id);
  // Entscheidungen bleiben (anonymisiert) erhalten, der Code selbst wird geloescht.
  db.prepare('UPDATE requests SET decided_by = NULL WHERE decided_by = ?').run(id);
  db.prepare('UPDATE requests SET prioritized_by = NULL WHERE prioritized_by = ?').run(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

export function sweepSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  loginLimiter.sweep(); globalLoginLimiter.sweep();
}

// --- Express-Middleware ---
export function attachSession(req, _res, next) {
  req.session = sessionFromRequest(req);
  next();
}

export function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (!can(req.session.role, perm)) return res.status(403).json({ error: 'Keine Berechtigung' });
    next();
  };
}

export function requireAnyPerm(...perms) {
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'Nicht angemeldet' });
    if (!perms.some((p) => can(req.session.role, p))) return res.status(403).json({ error: 'Keine Berechtigung' });
    next();
  };
}

// CSRF-Schutz: SameSite=Strict plus Origin-Pruefung bei schreibenden Requests
export function originCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    const own = req.headers['x-forwarded-host'] || req.headers.host;
    if (host !== own) return res.status(403).json({ error: 'Ungültige Herkunft' });
  }
  next();
}

export function setSessionCookie(req, res, token) {
  res.append('Set-Cookie', cookieString('sid', token, { maxAgeSec: SESSION_TTL_MS / 1000, secure: isSecure(req) }));
}
export function clearSessionCookie(req, res) {
  res.append('Set-Cookie', cookieString('sid', '', { maxAgeSec: 0, secure: isSecure(req) }));
}
export { clientIp };
