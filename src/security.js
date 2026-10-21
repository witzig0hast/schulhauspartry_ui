import crypto from 'node:crypto';
import { config } from './config.js';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

// Codes ohne verwechselbare Zeichen, z. B. K7QM-9XPA-2WTD
export function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 11) out += '-';
  }
  return out;
}

export const normalizeCode = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function sign(value) {
  const mac = crypto.createHmac('sha256', config.secret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsign(signed) {
  if (typeof signed !== 'string') return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const expected = sign(value);
  const a = Buffer.from(expected);
  const b = Buffer.from(signed);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

// AES-256-GCM fuer gespeicherte Spotify-Tokens
const key = () => crypto.createHash('sha256').update('enc:' + config.secret).digest();
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decrypt(payload) {
  try {
    const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Cookies mit __Host--Praefix (nur HTTPS, Pfad /, keine Subdomain-Verbreitung) bevorzugen
export const cookieName = (base, secure) => (secure ? `__Host-${base}` : base);
export const readCookie = (cookies, base) => cookies[`__Host-${base}`] || cookies[base];

export function cookieString(name, value, { maxAgeSec, secure, httpOnly = true, sameSite = 'Strict' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=/; SameSite=${sameSite}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (maxAgeSec != null) s += `; Max-Age=${maxAgeSec}`;
  return s;
}

// Private/lokale Adressen (Docker, Nginx Proxy Manager, localhost)
export function isPrivateIp(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || a === '::1' || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);
}
// Echte Client-Adresse. Weitergeleitete Header (Cloudflare/X-Forwarded-For) zaehlen NUR, wenn die direkte Verbindung von einer
// privaten Zwischenstation kommt (Nginx Proxy Manager). Wer den Server direkt anspricht, kann seine Adresse so nicht faelschen.
export function clientIp(req) {
  const peer = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
  if (!isPrivateIp(peer)) return peer;
  if (config.trustCloudflare) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim().slice(0, 64);
  }
  // X-Forwarded-For von rechts lesen: die erste nicht-private Adresse ist der Client
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = xff.length - 1; i >= 0; i--) if (!isPrivateIp(xff[i])) return xff[i].slice(0, 64);
  return xff[0] || peer;
}

export function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

// Einfacher Sliding-Window-Limiter im Speicher
export class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  check(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterMs: this.windowMs - (now - arr[0]) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true };
  }
  // Nur pruefen, ohne einen Treffer zu zaehlen
  peek(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    return arr.length < this.max ? { ok: true } : { ok: false, retryAfterMs: this.windowMs - (now - arr[0]) };
  }
  hit(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    arr.push(now); this.hits.set(key, arr);
  }
  sweep(now = Date.now()) {
    for (const [k, arr] of this.hits) {
      const f = arr.filter((t) => now - t < this.windowMs);
      if (f.length) this.hits.set(k, f); else this.hits.delete(k);
    }
  }
}
