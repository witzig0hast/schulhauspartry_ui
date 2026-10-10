import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startTestApp, Client } from './helpers.js';
import { config } from '../src/config.js';

const CLIENT = 'party-app', SECRET = 'client-secret-123456';

// Ein kleiner Fake-Identity-Provider (wie Authentik): Discovery, Authorize, Token, JWKS
async function fakeIdp() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'k1';
  const idp = { codes: new Map(), next: {}, tokenCalls: 0 };
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = (payload, key) => { const d = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(payload)}`; return `${d}.${crypto.sign('sha256', Buffer.from(d), key).toString('base64url')}`; };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, idp.base);
    const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/o/app/.well-known/openid-configuration') return json({ issuer: `${idp.base}/o/app/`, authorization_endpoint: `${idp.base}/o/authorize`, token_endpoint: `${idp.base}/o/token`, jwks_uri: `${idp.base}/o/jwks`, token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    if (u.pathname === '/o/jwks') return json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] });
    if (u.pathname === '/o/authorize') {
      const code = crypto.randomBytes(8).toString('hex');
      idp.codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), claims: { ...idp.next } });
      const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { Location: back.toString() }); return res.end();
    }
    if (u.pathname === '/o/token' && req.method === 'POST') {
      let body = ''; req.on('data', (d) => { body += d; });
      req.on('end', () => {
        idp.tokenCalls++;
        const f = new URLSearchParams(body), c = idp.codes.get(f.get('code'));
        const basic = Buffer.from(String(req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
        if (!c || basic !== `${CLIENT}:${SECRET}`) return json({ error: 'invalid_grant' }, 400);
        if (crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') !== c.challenge) return json({ error: 'pkce' }, 400);
        idp.codes.delete(f.get('code'));
        const now = Math.floor(Date.now() / 1000);
        const o = c.claims;
        const payload = { iss: `${idp.base}/o/app/`, aud: CLIENT, sub: o.sub, iat: now, exp: now + 300, nonce: c.nonce, name: o.name, email: o.email, groups: o.groups, ...(o.override || {}) };
        json({ access_token: 'at', token_type: 'Bearer', id_token: sign(payload, o.badSig ? other.privateKey : privateKey) });
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  idp.base = `http://127.0.0.1:${server.address().port}`;
  idp.close = () => server.close();
  return idp;
}

test('SSO (OpenID Connect): Anmeldung, Rollen aus Gruppen, Schutz gegen Faelschungen', async () => {
  const idp = await fakeIdp();
  const ctx = await startTestApp();
  config.publicUrl = ctx.base;
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const cfg = { sso: { enabled: true, issuer: `${idp.base}/o/app/`, clientId: CLIENT, clientSecret: SECRET, roleMap: [{ group: 'party-tech', role: 'tech' }, { group: 'party-mod', role: 'mod' }, { group: 'party-admin', role: 'admin' }], defaultRole: '' } };
    assert.equal((await admin.post('/api/admin/settings', cfg)).status, 200);
    assert.equal((await admin.get('/api/admin/settings')).json.settings.sso.clientSecret, '***');   // Secret nie im Klartext
    assert.equal((await new Client(ctx.base).get('/api/sso/config')).json.enabled, true);

    // Verbindung testen (nur Admin)
    const t = await admin.post('/api/admin/sso/test');
    assert.equal(t.json.ok, true); assert.equal(t.json.keys, 1); assert.match(t.json.redirectUri, /\/api\/sso\/callback$/);

    const login = async (client, claims, { tamper, next = '/tech' } = {}) => {
      idp.next = claims;
      const start = await client.get(`/api/sso/login${next ? `?next=${next}` : ''}`);
      assert.equal(start.status, 302);
      const loc = new URL(start.headers.get('location'));
      assert.equal(loc.searchParams.get('code_challenge_method'), 'S256'); assert.ok(loc.searchParams.get('nonce')); assert.equal(loc.searchParams.get('redirect_uri'), `${ctx.base}/api/sso/callback`);
      const a = await fetch(loc, { redirect: 'manual' });
      const cb = new URL(a.headers.get('location'));
      if (tamper) tamper(cb);
      return client.get(cb.pathname + cb.search);
    };

    // 1) Erfolg: Gruppe party-tech -> Rolle Technik
    const anna = new Client(ctx.base);
    const ok = await login(anna, { sub: 'u-anna', name: 'Anna', email: 'anna@school.de', groups: ['party-tech', 'andere'] });
    assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), '/tech');
    assert.equal((await anna.get('/api/me')).json.role, 'tech');
    assert.equal((await anna.get('/api/me')).json.label, 'Anna');
    const acc = (await admin.get('/api/admin/accounts')).json.accounts.find((a) => a.label === 'Anna');
    assert.ok(acc.sso); assert.equal(acc.role, 'tech');
    assert.ok((await admin.get('/api/admin/security')).json.audit.some((a) => a.kind === 'login.sso'));

    // 2) gleicher Benutzer, neue Gruppe -> gleiche Person, neue Rolle
    const anna2 = new Client(ctx.base);
    assert.equal((await login(anna2, { sub: 'u-anna', name: 'Anna S.', groups: ['party-mod'] })).status, 302);
    assert.equal((await anna2.get('/api/me')).json.role, 'mod');
    const list = (await admin.get('/api/admin/accounts')).json.accounts.filter((a) => a.sso);
    assert.equal(list.length, 1);

    // 3) Admin per SSO nur, wenn ausdruecklich erlaubt
    const boss = new Client(ctx.base);
    let r = await login(boss, { sub: 'u-boss', name: 'Boss', groups: ['party-admin'] });
    assert.equal(r.headers.get('location'), '/login?error=norole');
    await admin.post('/api/admin/settings', { sso: { allowAdmin: true } });
    r = await login(boss, { sub: 'u-boss', name: 'Boss', groups: ['party-admin'] }, { next: '' });
    assert.equal(r.headers.get('location'), '/admin');
    assert.equal((await boss.get('/api/admin/settings')).status, 200);
    assert.equal((await boss.get('/api/admin/vpn')).status, 403);          // SSO-Admin ist nicht der Head-Admin
    await admin.post('/api/admin/settings', { sso: { allowAdmin: false } });

    // 4) ohne passende Gruppe kein Zugang
    const nobody = new Client(ctx.base);
    assert.equal((await login(nobody, { sub: 'u-x', name: 'X', groups: ['irgendwas'] })).headers.get('location'), '/login?error=norole');
    assert.equal((await nobody.get('/api/me')).json.role, null);

    // 5) Faelschungen und Fehler
    const err = async (claims, tamper) => (await login(new Client(ctx.base), { sub: 'u-evil', name: 'E', groups: ['party-mod'], ...claims }, { tamper })).headers.get('location');
    assert.equal(await err({ badSig: true }), '/login?error=failed');                                         // falsche Signatur
    assert.equal(await err({ override: { aud: 'andere-app' } }), '/login?error=failed');                      // falsche Zielgruppe
    assert.equal(await err({ override: { nonce: 'x' } }), '/login?error=failed');                             // falsche nonce
    assert.equal(await err({ override: { exp: 1 } }), '/login?error=expired');                               // abgelaufen
    assert.equal(await err({ override: { iss: 'https://evil.example/' } }), '/login?error=failed');          // falscher Aussteller
    assert.equal(await err({}, (cb) => cb.searchParams.set('state', 'erfunden')), '/login?error=expired');    // unbekannter state
    // anderer Browser (ohne Cookie) kann einen fremden Anmeldevorgang nicht abschliessen
    idp.next = { sub: 'u-evil', groups: ['party-mod'] };
    const victim = new Client(ctx.base);
    const loc = (await victim.get('/api/sso/login')).headers.get('location');
    const cb = new URL((await fetch(loc, { redirect: 'manual' })).headers.get('location'));
    assert.equal((await new Client(ctx.base).get(cb.pathname + cb.search)).headers.get('location'), '/login?error=failed');
    // state ist nur einmal verwendbar
    const c2 = new Client(ctx.base);
    const first = await login(c2, { sub: 'u-r', name: 'R', groups: ['party-mod'] }, { tamper: (u) => { idp.replay = u.pathname + u.search; } });
    assert.equal(first.status, 302);
    assert.equal((await c2.get(idp.replay)).headers.get('location'), '/login?error=expired');
    assert.equal((await new Client(ctx.base).get('/api/me')).json.role, null);

    // 6) gesperrtes Konto
    const lock = (await admin.get('/api/admin/accounts')).json.accounts.find((a) => a.sso && a.label === 'R');
    await admin.post(`/api/admin/accounts/${lock.id}/revoke`);
    assert.equal((await login(new Client(ctx.base), { sub: 'u-r', name: 'R', groups: ['party-mod'] })).headers.get('location'), '/login?error=locked');

    // 7) Rechte: nur Admin darf testen/einstellen; Funktion ausschaltbar
    assert.equal((await anna2.post('/api/admin/sso/test')).status, 403);
    await admin.post('/api/admin/settings', { features: { sso: false } });
    assert.equal((await new Client(ctx.base).get('/api/sso/login')).status, 404);
    assert.equal((await new Client(ctx.base).get('/api/sso/config')).json.enabled, false);
  } finally { await ctx.close(); idp.close(); config.publicUrl = ''; }
});
