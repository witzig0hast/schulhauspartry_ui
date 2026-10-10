import express from 'express';
import { parseCookies, cookieString, cookieName, readCookie, isSecure, clientIp, RateLimiter } from '../security.js';
import { newSession, setSessionCookie, sessionFromRequest } from '../auth.js';
import { adminIpAllowed } from '../ipallow.js';
import { settings } from '../settings.js';
import { getDb } from '../db.js';
import { audit } from '../audit.js';
import { requireFeature } from '../features.js';
import { ssoReady, ssoConfig, startLogin, completeLogin, resolveLogin, provision, linkIdentity, linksOf, unlinkFor, SsoError } from '../sso.js';

const HOME = { admin: '/admin', tech: '/tech', mod: '/mod', orga: '/mod', display: '/foh', light: '/light', dj: '/dj' };
const limiter = new RateLimiter(150, 10 * 60 * 1000);   // viele Mitarbeitende hinter derselben Schul-Adresse
const safeNext = (n) => (typeof n === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(n) && !n.startsWith('//') ? n : '');
const homeOf = (role) => settings().roleHome?.[role] || HOME[role] || '/';

// SSO-Anmeldung und -Verknuepfung (nur live; die Rueckkehr-Adresse beim Anbieter ist PUBLIC_URL/api/sso/callback)
export function ssoRouter() {
  const r = express.Router();
  r.get('/sso/config', (req, res) => res.json({ enabled: ssoReady(), label: settings().sso.buttonLabel }));

  const begin = async (req, res, link) => {
    try {
      const { url, bind } = await startLogin(safeNext(req.query.next), link);
      // Lax: der Anbieter leitet per Top-Level-Weiterleitung zurueck, Strict-Cookies kaemen dort nicht an
      res.append('Set-Cookie', cookieString(cookieName('sso', isSecure(req)), bind, { maxAgeSec: 600, secure: isSecure(req), sameSite: 'Lax' }));
      res.redirect(url);
    } catch (e) { audit('sso.fail', null, clientIp(req), `Start: ${e.message}`); res.redirect(link ? `${homeOf(req.session?.role)}?sso=failed` : '/login?error=config'); }
  };

  r.get('/sso/login', requireFeature('sso'), async (req, res) => {
    if (!limiter.check(`ip:${clientIp(req)}`).ok) return res.status(429).type('text').send('Zu viele Versuche.');
    if (!ssoReady()) return res.redirect('/login?error=config');
    await begin(req, res, null);
  });

  // Eingeloggte Person verbindet ihren bestehenden Zugang mit ihrem SSO-Konto
  r.get('/sso/link', requireFeature('sso'), async (req, res) => {
    if (!req.session) return res.redirect('/login');
    if (!limiter.check(`ip:${clientIp(req)}`).ok) return res.status(429).type('text').send('Zu viele Versuche.');
    if (!ssoReady()) return res.redirect(`${homeOf(req.session.role)}?sso=failed`);
    const head = req.session.accountId == null;
    if (head && req.session.role !== 'admin') return res.status(403).type('text').send('Nicht möglich');
    await begin(req, res, { sessionHash: req.session.tokenHash, accountId: req.session.accountId ?? null });
  });

  r.get('/sso/status', (req, res) => {
    if (!req.session) return res.status(401).json({ error: 'Nicht angemeldet' });
    const linked = linksOf(req.session.accountId ?? null).map((l) => ({ name: l.name, email: l.email, since: l.created_at }));
    const managed = req.session.accountId != null && !!getDb().prepare("SELECT 1 FROM accounts WHERE id = ? AND code_hash LIKE 'sso:%'").get(req.session.accountId);
    res.json({ enabled: ssoReady(), linked, managed });
  });
  r.delete('/sso/link', express.json({ limit: '1kb' }), (req, res) => {
    if (!req.session) return res.status(401).json({ error: 'Nicht angemeldet' });
    const n = unlinkFor(req.session.accountId ?? null);
    if (n) audit('sso.unlink', req.session.label, clientIp(req), 'selbst');
    res.json({ ok: true, removed: n });
  });

  r.get('/sso/callback', requireFeature('sso'), async (req, res) => {
    const ip = clientIp(req), secure = isSecure(req);
    const clearCookie = () => res.append('Set-Cookie', cookieString(cookieName('sso', secure), '', { maxAgeSec: 0, secure, sameSite: 'Lax' }));
    const fail = (code, detail, to = '/login') => { audit('sso.fail', null, ip, `${code}: ${detail || ''}`); clearCookie(); return res.redirect(`${to}${to.includes('?') ? '&' : '?'}${to === '/login' ? 'error' : 'sso'}=${code}`); };
    if (!limiter.check(`ip:${ip}`).ok) return fail('failed', 'Rate-Limit');
    if (!ssoReady()) return fail('config');
    if (req.query.error) return fail('denied', String(req.query.error).slice(0, 60));
    if (!req.query.code || !req.query.state) return fail('failed', 'Parameter fehlen');
    try {
      const bind = readCookie(parseCookies(req.headers.cookie || ''), 'sso');
      const { claims, next, issuer, link } = await completeLogin({ code: req.query.code, state: req.query.state, bind });

      // ---- Verknuepfen (eingeloggt) ----
      if (link) {
        const cur = sessionFromRequest(req);
        const back = cur ? homeOf(cur.role) : '/login';
        if (!cur || cur.tokenHash !== link.sessionHash || (cur.accountId ?? null) !== link.accountId) return fail('failed', 'Sitzung passt nicht zur Verknüpfung', back);
        try { linkIdentity(issuer, claims, { accountId: link.accountId }); }
        catch (e) { if (e instanceof SsoError) return fail(e.code === 'taken' ? 'taken' : 'failed', e.message, back); throw e; }
        audit('sso.link', cur.label, ip, `${claims.email || claims.sub}`);
        clearCookie();
        return res.redirect(`${back}?sso=linked`);
      }

      // ---- Anmelden ----
      const who = resolveLogin(issuer, claims, ssoConfig());
      if (who.kind === 'deny') return fail(who.code, `${claims.email || claims.sub}`);
      let accountId, role, label;
      if (who.kind === 'head') {
        if (!adminIpAllowed(ip)) return fail('adminip', 'Head-Admin');
        if (settings().security.adminPasskeyOnly && process.env.ADMIN_RECOVERY !== '1') return fail('passkeyonly', 'Head-Admin');
        accountId = null; role = 'admin'; label = 'Head-Admin';
      } else if (who.kind === 'account') {
        if (who.account.revoked) return fail('locked', who.account.label);
        if (who.account.role === 'admin' && !adminIpAllowed(ip)) return fail('adminip', who.account.label);
        getDb().prepare('UPDATE accounts SET last_seen = ? WHERE id = ?').run(Date.now(), who.account.id);
        accountId = who.account.id; role = who.account.role; label = who.account.label;
      } else {
        if (who.role === 'admin' && !adminIpAllowed(ip)) return fail('adminip', claims.email || claims.sub);
        const acc = provision(issuer, claims, who.role);
        accountId = acc.id; role = who.role; label = acc.label;
      }
      const token = newSession(accountId, role, ip, req.headers['user-agent']);
      audit('login.sso', label, ip, `Rolle ${role}${who.kind === 'new' ? ' (neues Konto)' : ' (verbundener Zugang)'}${claims.email ? `, ${claims.email}` : ''}`);
      setSessionCookie(req, res, token);
      clearCookie();
      res.redirect(next || homeOf(role));
    } catch (e) {
      if (e instanceof SsoError) return fail(e.code === 'locked' ? 'locked' : e.code === 'expired' ? 'expired' : 'failed', e.message);
      return fail('failed', e.message);
    }
  });
  return r;
}
