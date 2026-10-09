import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';

let ctx, admin, mod, tech;
const PW = 'super-geheimes-passwort-123';
const login = async (role, label) => { const c = new Client(ctx.base); const code = (await admin.post('/api/admin/accounts', { role, label })).json.code; await c.post('/api/login', { secret: code }); return c; };
const guest = async () => { const g = new Client(ctx.base); await g.get('/api/guest/state'); return g; };
const wish = async (g, q, extra = {}) => { const t = (await g.get(`/api/guest/search?q=${encodeURIComponent(q)}`)).json.tracks[0]; return { t, res: await g.post('/api/guest/request', { trackId: t.id, ...extra }) }; };

test.before(async () => {
  ctx = await startTestApp();
  admin = new Client(ctx.base); await admin.post('/api/login', { secret: PW });
  await admin.post('/api/admin/settings', { limit: { count: 50, windowMin: 15 } });
  mod = await login('mod', 'Mod'); tech = await login('tech', 'Tech');
});
test.after(async () => { await ctx.close(); });

test('Funktionsschalter: nur Admin; ausgeschaltet = serverseitig gesperrt', async () => {
  const s = (await admin.get('/api/admin/settings')).json;
  assert.ok(s.features.list.length > 30);
  assert.equal((await mod.post('/api/admin/settings', { features: { viewBoard: false } })).status, 403);
  assert.equal((await admin.post('/api/admin/settings', { features: { viewAnalytics: false, voting: false, unbekannt: false } })).status, 200);
  assert.equal((await mod.get('/api/analytics')).status, 404);
  assert.equal((await mod.get('/analytics')).status, 404);
  const g = await guest();
  assert.equal((await g.get('/api/guest/state')).json.voting, null);
  await admin.post('/api/admin/settings', { features: { viewAnalytics: true, voting: true } });
  assert.equal((await mod.get('/api/analytics')).status, 200);
  assert.ok(!('unbekannt' in (await admin.get('/api/admin/settings')).json.features.flags));
});

test('Wunsch-Voting: +1 von anderen Geraeten, nicht doppelt, eigenes Limit', async () => {
  await admin.post('/api/admin/settings', { voting: { votesPerWindow: 2, windowMin: 15, sortByVotes: true } });
  const a = await guest(), b = await guest(), c = await guest();
  const { t } = await wish(a, 'blinding');
  const id = (await mod.get('/api/state')).json.pending[0].id;
  const st = (await b.get('/api/guest/state')).json;
  assert.equal(st.voting.list.length, 1);
  assert.equal(st.voting.list[0].mine, false);
  assert.equal((await b.post('/api/guest/vote', { id })).status, 200);
  assert.equal((await b.post('/api/guest/vote', { id })).status, 409);
  assert.equal((await a.post('/api/guest/vote', { id })).status, 409); // eigener Wunsch zaehlt schon
  assert.equal((await mod.get('/api/state')).json.pending[0].votes, 2);
  // Limit: 2 Votes pro Fenster
  const { res } = await wish(c, 'levitating');
  assert.equal(res.status, 200);
  const id2 = (await mod.get('/api/state')).json.pending.find((p) => p.id !== id).id;
  assert.equal((await b.post('/api/guest/vote', { id: id2 })).status, 200);
  const d = await guest();
  await wish(d, 'shape of you');
  const id3 = (await mod.get('/api/state')).json.pending.find((p) => p.id !== id && p.id !== id2).id;
  assert.equal((await b.post('/api/guest/vote', { id: id3 })).status, 429);
  assert.ok(t.id);
});

test('Geraet sperren: keine Wuensche, keine Votes mehr', async () => {
  const g = await guest();
  await wish(g, 'sunflower');
  const pend = (await mod.get('/api/state')).json.pending;
  const mine = pend.find((p) => p.title.toLowerCase().includes('sunflower'));
  assert.equal((await mod.post('/api/mod/device/block', { requestId: mine.id })).status, 200);
  const { res } = await wish(g, 'uptown funk');
  assert.equal(res.status, 403);
  assert.equal((await g.post('/api/guest/vote', { id: pend[0].id })).status, 403);
  const devs = (await mod.get('/api/mod/devices')).json.devices;
  const blocked = devs.find((d) => d.blocked);
  assert.ok(blocked);
  assert.equal((await mod.post('/api/mod/device/unblock', { deviceId: blocked.id })).json.ok, true);
});

test('Umfragen: nur Technik erstellt, Gaeste stimmen einmal ab', async () => {
  assert.equal((await mod.post('/api/poll', { question: 'Stil?', options: ['Pop', 'Rock'] })).status, 403);
  assert.equal((await tech.post('/api/poll', { question: 'Stil?', options: ['Pop'] })).status, 400);
  assert.equal((await tech.post('/api/poll', { question: 'Stil?', options: ['Pop', 'Rock'] })).status, 200);
  const g = await guest(), g2 = await guest();
  assert.equal((await g.post('/api/guest/poll-vote', { idx: 0 })).status, 200);
  assert.equal((await g.post('/api/guest/poll-vote', { idx: 1 })).status, 200); // aendern erlaubt, zaehlt nur einmal
  assert.equal((await g2.post('/api/guest/poll-vote', { idx: 7 })).status, 400);
  const p = (await g.get('/api/guest/public')).json.poll;
  assert.equal(p.total, 1); assert.deepEqual(p.counts, [0, 1]); assert.equal(p.mine, 1);
  await tech.post('/api/poll/close');
  assert.equal((await g2.post('/api/guest/poll-vote', { idx: 0 })).status, 404);
});

test('Zeitplan & Uebergabe-Notiz', async () => {
  assert.equal((await mod.post('/api/schedule', { at: '20:00', title: 'X' })).status, 403);
  assert.equal((await tech.post('/api/schedule', { at: '25:00', title: 'X' })).status, 400);
  assert.equal((await tech.post('/api/schedule', { at: '21:30', title: 'Siegerehrung', public: true })).status, 200);
  const pub = (await (await guest()).get('/api/guest/public')).json;
  assert.equal(pub.schedule.length, 1);
  assert.equal((await mod.post('/api/handover', { text: 'Bitte Mic 2 prüfen' })).status, 200);
  assert.equal((await mod.get('/api/state')).json.handover.text, 'Bitte Mic 2 prüfen');
});

test('Pausen-Modus pausiert Wuensche und zeigt Hinweis', async () => {
  assert.equal((await mod.post('/api/control/pause-mode', { on: true })).status, 403);
  assert.equal((await tech.post('/api/control/pause-mode', { on: true })).status, 200);
  const g = await guest();
  const st = (await g.get('/api/guest/state')).json;
  assert.equal(st.wishMode, 'paused'); assert.ok(st.pause);
  await tech.post('/api/control/pause-mode', { on: false });
  assert.equal((await g.get('/api/guest/state')).json.wishMode, 'open');
});

test('Sicherheit: Sitzungen, Protokoll, Passwort aendern (nur Admin)', async () => {
  assert.equal((await mod.get('/api/admin/security')).status, 403);
  const d = (await admin.get('/api/admin/security')).json;
  assert.ok(d.sessions.length >= 3);
  assert.ok(d.audit.some((a) => a.kind === 'login.ok'));
  assert.ok(d.audit.some((a) => a.kind === 'settings.change'));
  const other = d.sessions.find((s) => !s.current && s.role === 'mod');
  assert.equal((await admin.post(`/api/admin/security/sessions/${other.id}/revoke`)).json.ok, true);
  assert.equal((await mod.get('/api/state')).status, 401);
  mod = await login('mod', 'Mod2');
  // schlechtes Passwort
  assert.equal((await admin.post('/api/admin/security/password', { current: 'falsch', next: 'neues-langes-passwort-1' })).status, 400);
  assert.equal((await admin.post('/api/admin/security/password', { current: PW, next: 'kurz' })).status, 400);
  assert.equal((await admin.post('/api/admin/security/password', { current: PW, next: 'neues-langes-passwort-1' })).status, 200);
  const fresh = new Client(ctx.base);
  assert.equal((await fresh.post('/api/login', { secret: PW })).status, 401);
  assert.equal((await fresh.post('/api/login', { secret: 'neues-langes-passwort-1' })).status, 200);
  assert.equal((await admin.get('/api/admin/security')).status, 200); // aktuelle Sitzung bleibt
});

test('Admin-IP-Liste sperrt andere Adressen aus', async () => {
  const adm = new Client(ctx.base); await adm.post('/api/login', { secret: 'neues-langes-passwort-1' });
  assert.equal((await adm.post('/api/admin/settings', { security: { adminIpAllow: ['10.99.0.0/16'] } })).status, 200);
  assert.equal((await adm.get('/api/admin/settings')).status, 403);
  const x = new Client(ctx.base);
  assert.equal((await x.post('/api/login', { secret: 'neues-langes-passwort-1' })).status, 403);
  // Liste direkt zuruecksetzen (der Admin selbst ist ausgesperrt)
  const { settings } = await import('../src/settings.js');
  settings().security.adminIpAllow = [];
  assert.equal((await adm.get('/api/admin/settings')).status, 200);
});

test('Rueckblick: geheimer Link, Token pruefen, Admin kann erneuern', async () => {
  const adm = new Client(ctx.base); await adm.post('/api/login', { secret: 'neues-langes-passwort-1' });
  const { token } = (await adm.get('/api/admin/recap')).json;
  const pub = new Client(ctx.base);
  assert.equal((await pub.get(`/api/recap/${token}`)).status, 200);
  assert.equal((await pub.get('/api/recap/falsch')).status, 404);
  assert.equal((await pub.get(`/recap/${token}`)).status, 200);
  const fresh = (await adm.post('/api/admin/recap/regenerate')).json.token;
  assert.notEqual(fresh, token);
  assert.equal((await pub.get(`/api/recap/${token}`)).status, 404);
});

test('Passkeys: Registrierung braucht Anmeldung, Optionen kommen mit Challenge', async () => {
  const anon = new Client(ctx.base);
  assert.equal((await anon.post('/api/passkey/register/options')).status, 401);
  const lo = (await anon.post('/api/passkey/login/options')).json;
  assert.ok(lo.cid && lo.options.challenge);
  mod = await login('mod', 'Mod3');
  const ro = await mod.post('/api/passkey/register/options');
  assert.equal(ro.status, 200); assert.ok(ro.json.challenge);
  assert.equal((await anon.post('/api/passkey/login/verify', { cid: lo.cid, response: { id: 'nix' } })).status, 401);
  await (async () => { const a = new Client(ctx.base); await a.post('/api/login', { secret: 'neues-langes-passwort-1' }); await a.post('/api/admin/settings', { features: { passkeys: false } }); assert.equal((await anon.post('/api/passkey/login/options')).status, 404); await a.post('/api/admin/settings', { features: { passkeys: true } }); })();
});
