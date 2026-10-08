import { getDb, getSetting, setSetting } from './db.js';
import {
  sha256, randomToken, randomCode, normalizeCode, hashPassword, verifyPassword,
  parseCookies, cookieString, clientIp, isSecure, RateLimiter, cookieName, readCookie,
} from './security.js';
import { audit } from './audit.js';
import { settings } from './settings.js';
import { adminIpAllowed } from './ipallow.js';
import { sendNotify } from './notify.js';
import { config } from './config.js';

export const ROLES = ['admin', 'tech', 'mod', 'orga', 'display'];
export const ROLE_LABELS = { admin: 'Head-Admin', tech: 'Technik', mod: 'Moderation', orga: 'Orga (nur lesen)', display: 'FOH-Anzeige' };

// Wer darf was
export const PERMS = {
  viewTech: ['admin', 'tech'],
  viewMod: ['admin', 'tech', 'mod', 'orga'],
  viewFoh: ['admin', 'tech', 'orga', 'display'],
  viewBoard: ['admin', 'tech', 'mod', 'orga', 'display'],
  viewStats: ['admin', 'tech', 'mod', 'orga', 'display'],
  viewTicker: ['admin', 'tech', 'orga', 'display'],
  viewPrep: ['admin', 'tech'],
  viewStage: ['admin', 'tech', 'mod', 'orga', 'display'],
  viewSchedule: ['admin', 'tech', 'mod', 'orga', 'display'],
  viewActivity: ['admin', 'tech', 'mod', 'orga'],
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
  if (config.adminPassword && !getSetting('adminPasswordManaged')) { // wurde das Passwort im Admin geaendert, gilt nicht mehr die Umgebungsvariable
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

function newSession(accountId, role, ip, ua) {
  const token = randomToken(32);
  const now = Date.now();
  getDb().prepare('INSERT INTO sessions(token_hash, account_id, role, created_at, expires_at, ip, ua, last_seen) VALUES(?,?,?,?,?,?,?,?)')
    .run(sha256(token), accountId, role, now, now + settings().security.maxHours * 3600 * 1000, String(ip || '').slice(0, 60), String(ua || '').slice(0, 160), now);
  return token;
}
export { newSession };

export function login(secret, ip, ua = '') {
  const key = `ip:${ip}`;
  if (!loginLimiter.peek(key).ok || !globalLoginLimiter.peek('all').ok) {
    audit('login.locked', null, ip, 'zu viele Fehlversuche');
    return { ok: false, status: 429, error: 'Zu viele Versuche. Bitte später erneut versuchen.' };
  }
  const db = getDb();
  const code = normalizeCode(secret);
  const acc = code && db.prepare('SELECT * FROM accounts WHERE code_hash = ? AND revoked = 0').get(sha256(code));
  let session;
  if (acc) {
    session = { accountId: acc.id, role: acc.role, who: acc.label };
    db.prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(Date.now(), acc.id);
  } else if (secret && verifyPassword(String(secret), getSetting('adminPasswordHash'))) {
    if (settings().security.adminPasskeyOnly && process.env.ADMIN_RECOVERY !== '1') {
      audit('login.blocked', 'Head-Admin', ip, 'Passwort-Login ist ausgeschaltet (nur Passkey)');
      return { ok: false, status: 403, error: 'Der Admin-Login ist nur mit Passkey erlaubt.' };
    }
    if (!adminIpAllowed(ip)) { audit('login.blocked', 'Head-Admin', ip, 'IP nicht freigegeben'); return { ok: false, status: 403, error: 'Von dieser Adresse ist kein Admin-Login erlaubt.' }; }
    session = { accountId: null, role: 'admin', who: 'Head-Admin' };
  } else {
    loginLimiter.hit(key); globalLoginLimiter.hit('all');
    audit('login.fail', null, ip, 'falscher Code/Passwort');
    // Mehrere Fehlversuche in kurzer Zeit -> Warnung aufs Handy
    if (loginLimiter.hits.get(key)?.length >= 5) sendNotify({ title: '🔐 Viele Fehl-Logins', message: `Mehrere falsche Anmeldeversuche von ${ip}.`, priority: 4, tags: ['lock'], key: `loginfail:${ip}` }).catch(() => {});
    return { ok: false, status: 401, error: 'Code oder Passwort falsch.' };
  }
  const token = newSession(session.accountId, session.role, ip, ua);
  audit('login.ok', session.who, ip, `Rolle ${session.role}`);
  return { ok: true, token, role: session.role, accountId: session.accountId };
}

export function logout(token) {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function sessionFromToken(token) {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT s.role, s.account_id, s.expires_at, s.last_seen, a.revoked, a.label
    FROM sessions s LEFT JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  const now = Date.now();
  const idle = settings().security.idleMinutes * 60000;
  if (row.expires_at < now || row.revoked || (row.last_seen && now - row.last_seen > idle)) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  if (!row.last_seen || now - row.last_seen > 30000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, sha256(token));
  return { role: row.role, accountId: row.account_id, label: row.label || (row.role === 'admin' ? 'Head-Admin' : row.role), tokenHash: sha256(token) };
}

export function sessionFromRequest(req) {
  return sessionFromToken(readCookie(parseCookies(req.headers.cookie || ''), 'sid'));
}

export function listSessions() {
  return getDb().prepare(`SELECT s.token_hash, s.role, s.account_id, s.created_at, s.last_seen, s.ip, s.ua, a.label
    FROM sessions s LEFT JOIN accounts a ON a.id = s.account_id ORDER BY s.last_seen DESC`).all()
    .map((r) => ({ id: r.token_hash.slice(0, 16), hash: r.token_hash, role: r.role, label: r.label || (r.role === 'admin' ? 'Head-Admin' : r.role), createdAt: r.created_at, lastSeen: r.last_seen, ip: r.ip, ua: r.ua }));
}
export function revokeSessionById(shortId, exceptHash = null) {
  const row = getDb().prepare('SELECT token_hash FROM sessions WHERE substr(token_hash, 1, 16) = ?').get(String(shortId));
  if (!row || row.token_hash === exceptHash) return false;
  getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
  return true;
}
export function revokeAllSessions(exceptHash = null) {
  return getDb().prepare('DELETE FROM sessions WHERE token_hash != ?').run(exceptHash || '').changes;
}

export function changeAdminPassword(current, next) {
  if (!verifyPassword(String(current || ''), getSetting('adminPasswordHash'))) throw new Error('Das aktuelle Passwort stimmt nicht.');
  const n = String(next || '');
  if (n.length < 12) throw new Error('Das neue Passwort muss mindestens 12 Zeichen lang sein.');
  if (/^(.)\1+$/.test(n)) throw new Error('Bitte ein besseres Passwort wählen.');
  setSetting('adminPasswordHash', hashPassword(n));
  setSetting('adminPasswordManaged', true);
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

// Admin-Bereich nur von freigegebenen Adressen (wenn eine Liste gesetzt ist)
export function adminIpGuard(req, res, next) {
  if (adminIpAllowed(clientIp(req))) return next();
  audit('admin.blocked', null, clientIp(req), req.path);
  return res.status(403).json({ error: 'Der Admin-Bereich ist von dieser Adresse aus gesperrt.' });
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
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return res.status(403).json({ error: 'Ungültige Herkunft' });
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
  const secure = isSecure(req);
  res.append('Set-Cookie', cookieString(cookieName('sid', secure), token, { maxAgeSec: settings().security.maxHours * 3600, secure }));
}
export function clearSessionCookie(req, res) {
  const secure = isSecure(req);
  res.append('Set-Cookie', cookieString(cookieName('sid', secure), '', { maxAgeSec: 0, secure }));
  if (secure) res.append('Set-Cookie', cookieString('sid', '', { maxAgeSec: 0, secure }));
}
export { clientIp };
