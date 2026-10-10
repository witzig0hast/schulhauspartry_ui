import express from 'express';
import { parseCookies, cookieString, cookieName, readCookie, isSecure, clientIp, RateLimiter } from '../security.js';
import { newSession, setSessionCookie } from '../auth.js';
import { adminIpAllowed } from '../ipallow.js';
import { settings } from '../settings.js';
import { audit } from '../audit.js';
import { requireFeature } from '../features.js';
import { ssoReady, ssoConfig, startLogin, completeLogin, mapRole, provision, SsoError } from '../sso.js';

const HOME = { admin: '/admin', tech: '/tech', mod: '/mod', orga: '/mod', display: '/foh', light: '/light' };
const limiter = new RateLimiter(30, 10 * 60 * 1000);
const safeNext = (n) => (typeof n === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(n) && !n.startsWith('//') ? n : '');

// SSO-Anmeldung (nur live; die Rueckkehr-Adresse beim Anbieter ist PUBLIC_URL/api/sso/callback)
export function ssoRouter() {
  const r = express.Router();
  r.get('/sso/config', (req, res) => res.json({ enabled: ssoReady(), label: settings().sso.buttonLabel }));

  r.get('/sso/login', requireFeature('sso'), async (req, res) => {
    if (!limiter.check(`ip:${clientIp(req)}`).ok) return res.status(429).type('text').send('Zu viele Versuche.');
    if (!ssoReady()) return res.redirect('/login?error=config');
    try {
      const { url, bind } = await startLogin(safeNext(req.query.next));
      // Lax: der Anbieter leitet per Top-Level-Weiterleitung zurueck, Strict-Cookies kaemen dort nicht an
      res.append('Set-Cookie', cookieString(cookieName('sso', isSecure(req)), bind, { maxAgeSec: 600, secure: isSecure(req), sameSite: 'Lax' }));
      res.redirect(url);
    } catch (e) { audit('sso.fail', null, clientIp(req), `Start: ${e.message}`); res.redirect('/login?error=config'); }
  });

  r.get('/sso/callback', requireFeature('sso'), async (req, res) => {
    const ip = clientIp(req), secure = isSecure(req);
    const fail = (code, detail) => { audit('sso.fail', null, ip, `${code}: ${detail || ''}`); res.append('Set-Cookie', cookieString(cookieName('sso', secure), '', { maxAgeSec: 0, secure, sameSite: 'Lax' })); return res.redirect(`/login?error=${code}`); };
    if (!limiter.check(`ip:${ip}`).ok) return fail('failed', 'Rate-Limit');
    if (!ssoReady()) return fail('config');
    if (req.query.error) return fail('denied', String(req.query.error).slice(0, 60));
    if (!req.query.code || !req.query.state) return fail('failed', 'Parameter fehlen');
    try {
      const bind = readCookie(parseCookies(req.headers.cookie || ''), 'sso');
      const { claims, next, issuer } = await completeLogin({ code: req.query.code, state: req.query.state, bind });
      const role = mapRole(claims, ssoConfig());
      if (!role) return fail('norole', `${claims.email || claims.sub} hat keine zugeordnete Gruppe`);
      if (role === 'admin' && !adminIpAllowed(ip)) return fail('adminip', claims.email || claims.sub);
      const acc = provision(issuer, claims, role);
      const token = newSession(acc.id, role, ip, req.headers['user-agent']);
      audit('login.sso', acc.label, ip, `Rolle ${role}${claims.email ? `, ${claims.email}` : ''}`);
      setSessionCookie(req, res, token);
      res.append('Set-Cookie', cookieString(cookieName('sso', secure), '', { maxAgeSec: 0, secure, sameSite: 'Lax' }));
      res.redirect(next || settings().roleHome?.[role] || HOME[role]);
    } catch (e) {
      if (e instanceof SsoError) return fail(e.code === 'locked' ? 'locked' : e.code === 'expired' ? 'expired' : 'failed', e.message);
      return fail('failed', e.message);
    }
  });
  return r;
}
