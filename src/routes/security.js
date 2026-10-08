import express from 'express';
import {
  requirePerm, adminIpGuard, newSession, setSessionCookie, clearSessionCookie, clientIp, listSessions, revokeSessionById, revokeAllSessions, changeAdminPassword,
} from '../auth.js';
import { adminIpAllowed } from '../ipallow.js';
import { requireFeature } from '../features.js';
import { audit, recentAudit } from '../audit.js';
import { settings } from '../settings.js';
import { RateLimiter } from '../security.js';
import * as pk from '../passkeys.js';
import { listDevices, blockDevice, unblockDevice, deviceOfRequest } from '../devices.js';

const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
const authLimiter = new RateLimiter(20, 10 * 60 * 1000);

const HOME = { admin: '/admin', tech: '/tech', mod: '/mod', orga: '/mod', display: '/foh' };

export function securityRouter(env, engine, hub) {
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  // ----- Passkey-Anmeldung (ohne Sitzung) -----
  r.post('/passkey/login/options', requireFeature('passkeys'), wrap(async (req, res) => {
    if (!authLimiter.check(`ip:${clientIp(req)}`).ok) return res.status(429).json({ error: 'Zu viele Versuche.' });
    res.json(await pk.authenticationOptions(req));
  }));
  r.post('/passkey/login/verify', requireFeature('passkeys'), wrap(async (req, res) => {
    const ip = clientIp(req);
    if (!authLimiter.check(`ip:${ip}`).ok) return res.status(429).json({ error: 'Zu viele Versuche.' });
    let out;
    try { out = await pk.verifyAuthentication(req, String(req.body?.cid || ''), req.body?.response); }
    catch (e) { audit('passkey.fail', null, ip, e.message); return res.status(401).json({ error: e.message }); }
    if (out.role === 'admin' && !adminIpAllowed(ip)) { audit('login.blocked', out.who, ip, 'IP nicht freigegeben (Passkey)'); return res.status(403).json({ error: 'Von dieser Adresse ist kein Admin-Login erlaubt.' }); }
    const token = newSession(out.accountId, out.role, ip, req.headers['user-agent']);
    audit('login.passkey', out.who, ip, `Rolle ${out.role}, ${out.passkeyLabel}`);
    setSessionCookie(req, res, token);
    res.json({ ok: true, role: out.role, home: settings().roleHome?.[out.role] || HOME[out.role] });
  }));

  // ----- Passkeys verwalten (angemeldet) -----
  const need = (req, res, next) => (req.session ? next() : res.status(401).json({ error: 'Nicht angemeldet' }));
  r.get('/passkey/mine', need, requireFeature('passkeys'), (req, res) => res.json({ passkeys: pk.listPasskeys({ accountId: req.session.accountId }) }));
  r.post('/passkey/register/options', need, requireFeature('passkeys'), wrap(async (req, res) => res.json(await pk.registrationOptions(req, req.session))));
  r.post('/passkey/register/verify', need, requireFeature('passkeys'), wrap(async (req, res) => {
    const out = await pk.verifyRegistration(req, req.session, req.body?.response, req.body?.label);
    audit('passkey.add', req.session.label, clientIp(req), String(req.body?.label || '').slice(0, 40));
    res.json({ ok: true, ...out });
  }));
  r.delete('/passkey/:id', need, wrap((req, res) => {
    const isAdmin = req.session.role === 'admin';
    if (isAdmin && req.session.accountId == null) {
      const mine = pk.listPasskeys({ accountId: null }).some((p) => p.id === req.params.id);
      if (mine && pk.countAdminPasskeys() <= 1 && settings().security.adminPasskeyOnly) throw new Error('Das ist der letzte Admin-Passkey, und „Admin nur mit Passkey“ ist an. Erst dort ausschalten.');
    }
    const ok = pk.removePasskey(req.params.id, { accountId: req.session.accountId, isAdmin });
    if (ok) audit('passkey.remove', req.session.label, clientIp(req), req.params.id.slice(0, 12));
    res.json({ ok });
  }));

  // ----- Admin: Sicherheit -----
  const adm = [adminIpGuard, requirePerm('viewAdmin')];
  r.get('/admin/security', ...adm, (req, res) => res.json({
    sessions: listSessions().map((s) => ({ ...s, hash: undefined, current: s.hash === req.session.tokenHash })),
    audit: recentAudit(200),
    passkeys: pk.listPasskeys({ all: true }),
    yourIp: clientIp(req),
    adminPasskeys: pk.countAdminPasskeys(),
  }));
  r.post('/admin/security/sessions/:id/revoke', ...adm, wrap((req, res) => {
    const ok = revokeSessionById(req.params.id, req.session.tokenHash);
    if (ok) { audit('session.revoke', req.session.label, clientIp(req), req.params.id); hub.kickAll?.(); }
    res.json({ ok });
  }));
  r.post('/admin/security/sessions/revoke-all', ...adm, wrap((req, res) => {
    const n = revokeAllSessions(req.session.tokenHash);
    audit('session.revoke-all', req.session.label, clientIp(req), `${n} Sitzungen`);
    hub.kickAll?.();
    res.json({ ok: true, count: n });
  }));
  r.post('/admin/security/password', ...adm, wrap((req, res) => {
    if (req.session.accountId != null) throw new Error('Nur der Head-Admin.');
    if (!authLimiter.check(`pw:${clientIp(req)}`).ok) return res.status(429).json({ error: 'Zu viele Versuche.' });
    changeAdminPassword(req.body?.current, req.body?.next);
    audit('password.change', req.session.label, clientIp(req));
    revokeAllSessions(req.session.tokenHash);
    res.json({ ok: true });
  }));
  r.post('/admin/security/logout-self', need, (req, res) => { clearSessionCookie(req, res); res.json({ ok: true }); });

  // ----- Gast-Geraete (Moderation darf sperren, Admin sieht alles) -----
  const modOnly = requirePerm('moderate');
  r.get('/mod/devices', requireFeature('deviceBlock'), modOnly, (req, res) => res.json({ devices: listDevices(env) }));
  r.post('/mod/device/block', requireFeature('deviceBlock'), modOnly, wrap((req, res) => {
    const id = req.body?.requestId ? deviceOfRequest(env, Number(req.body.requestId)) : String(req.body?.deviceId || '');
    if (!id || id === 'staff' || id === 'auto') throw new Error('Gerät nicht gefunden.');
    blockDevice(env, id, req.body?.reason);
    audit('device.block', req.session.label, clientIp(req), id.slice(0, 6));
    hub.pushEnv(env, { guests: true });
    res.json({ ok: true });
  }));
  r.post('/mod/device/unblock', requireFeature('deviceBlock'), modOnly, wrap((req, res) => {
    const ok = unblockDevice(env, String(req.body?.deviceId || ''));
    audit('device.unblock', req.session.label, clientIp(req), String(req.body?.deviceId || '').slice(0, 6));
    res.json({ ok });
  }));
  return r;
}
