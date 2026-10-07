import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { setSetting } from '../src/db.js';

let ctx;
test.before(async () => { ctx = await startTestApp(); });
test.after(async () => { await ctx.close(); });

const ADMIN_PW = 'super-geheimes-passwort-123';

test('Login: falsches Passwort wird abgelehnt, richtiges klappt', async () => {
  const c = new Client(ctx.base);
  assert.equal((await c.post('/api/login', { secret: 'falsch' })).status, 401);
  const ok = await c.post('/api/login', { secret: ADMIN_PW });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.role, 'admin');
});

test('Seiten sind geschuetzt', async () => {
  const c = new Client(ctx.base);
  const r = await c.get('/admin');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/login/);
  assert.equal((await c.get('/api/admin/settings')).status, 401);
  assert.equal((await c.get('/')).status, 200);
});

test('Komplettablauf: Wunsch -> Duplikat -> Approve -> Crossfade', async () => {
  const admin = new Client(ctx.base);
  await admin.post('/api/login', { secret: ADMIN_PW });
  const mk = await admin.post('/api/admin/accounts', { role: 'mod', label: 'Mod A' });
  assert.equal(mk.status, 200);
  const mod = new Client(ctx.base);
  assert.equal((await mod.post('/api/login', { secret: mk.json.code.toLowerCase() })).json.role, 'mod');
  assert.equal((await mod.get('/api/admin/settings')).status, 403);

  const g1 = new Client(ctx.base), g2 = new Client(ctx.base);
  await g1.get('/api/guest/state'); await g2.get('/api/guest/state');
  const s = await g1.get('/api/guest/search?q=blinding');
  assert.equal(s.json.tracks[0].title, 'Blinding Lights');
  const id = s.json.tracks[0].id;

  const w = await g1.post('/api/guest/request', { trackId: id });
  assert.equal(w.json.duplicate, false);
  const d = await g2.post('/api/guest/request', { trackId: id });
  assert.equal(d.json.duplicate, true);
  assert.match(d.json.info, /wartet noch auf Freigabe/);

  const st = await mod.get('/api/state');
  assert.equal(st.json.pending.length, 1);
  assert.equal(st.json.pending[0].votes, 2);
  const reqId = st.json.pending[0].id;

  // zwei Moderatoren gleichzeitig: nur der erste gewinnt
  const [a, b] = await Promise.all([
    mod.post('/api/mod/decide', { id: reqId, action: 'approve' }),
    mod.post('/api/mod/decide', { id: reqId, action: 'deny', reason: 'Zu explizit' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);

  const gs = await g1.get('/api/guest/state');
  assert.equal(gs.json.requests[0].status, 'approved');

  // Duplikat bei freigegebenem Song nennt die Position
  const d2 = await g2.post('/api/guest/request', { trackId: id });
  assert.equal(d2.json.duplicate, true);

  // Technik: Crossfade startet Song, Fade-In
  const tech = new Client(ctx.base);
  const tcode = (await admin.post('/api/admin/accounts', { role: 'tech', label: 'FOH' })).json.code;
  await tech.post('/api/login', { secret: tcode });
  const cf = await tech.post('/api/control/crossfade', { sec: 1 });
  assert.equal(cf.status, 200);
  await ctx.engines.live.tick();
  const snap = (await tech.get('/api/state')).json;
  assert.equal(snap.players[cf.json.player].title, 'Blinding Lights');
  assert.equal(snap.counts.played, 1);
});

test('Limit pro Geraet', async () => {
  const g = new Client(ctx.base);
  await g.get('/api/guest/state');
  const ids = [];
  for (const q of ['levitating', 'shape', 'uptown']) ids.push((await g.get(`/api/guest/search?q=${q}`)).json.tracks[0].id);
  assert.equal((await g.post('/api/guest/request', { trackId: ids[0] })).status, 200);
  assert.equal((await g.post('/api/guest/request', { trackId: ids[1] })).status, 200);
  const third = await g.post('/api/guest/request', { trackId: ids[2] });
  assert.equal(third.status, 429);
});

test('Explicit-Filter blockt Songs', async () => {
  const admin = new Client(ctx.base);
  await admin.post('/api/login', { secret: ADMIN_PW });
  await admin.post('/api/admin/settings', { explicitMode: 'block', limit: { count: 10, windowMin: 15 } });
  const g = new Client(ctx.base);
  const r = await g.get('/api/guest/search?q=bad guy');
  assert.equal(r.json.tracks[0].blocked, true);
  assert.equal((await g.post('/api/guest/request', { trackId: r.json.tracks[0].id })).status, 403);
  await admin.post('/api/admin/settings', { explicitMode: 'mark' });
});

test('Testmodus: Praefix nur aktiv, wenn eingeschaltet', async () => {
  const admin = new Client(ctx.base);
  await admin.post('/api/login', { secret: ADMIN_PW });
  const prefix = (await admin.get('/api/admin/settings')).json.settings.test.prefix;
  const anon = new Client(ctx.base);
  assert.equal((await anon.get(`/${prefix}/`)).status, 404);
  await admin.post('/api/admin/settings', { test: { enabled: true } });
  assert.equal((await anon.get(`/${prefix}/`)).status, 200);
  const t = new Client(ctx.base, `/${prefix}`);
  assert.equal((await t.get('/api/guest/state')).json.requests.length, 0); // getrennte Daten
  await admin.post('/api/admin/settings', { test: { enabled: false } });
  assert.equal((await anon.get(`/${prefix}/`)).status, 404);
});

test('Not-Aus braucht doppelte Bestaetigung', async () => {
  const admin = new Client(ctx.base);
  await admin.post('/api/login', { secret: ADMIN_PW });
  assert.equal((await admin.post('/api/control/panic', { nonce: 'x' })).status, 400);
  const arm = await admin.post('/api/control/panic-arm');
  assert.equal((await admin.post('/api/control/panic', { nonce: arm.json.nonce })).status, 200);
  assert.equal(ctx.engines.live.state.panic, true);
  await admin.post('/api/control/panic-clear');
});

test('CSV-Export und Bericht nur fuer Admin', async () => {
  const admin = new Client(ctx.base);
  await admin.post('/api/login', { secret: ADMIN_PW });
  const csv = await admin.get('/api/admin/setlist.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Blinding Lights/);
  const rep = await admin.get('/api/admin/report');
  assert.equal(rep.json.totals.requests >= 1, true);
  const anon = new Client(ctx.base);
  assert.equal((await anon.get('/api/admin/setlist.csv')).status, 401);
});

test('Zuruecksetzen: loescht Wuensche/Queue, behaelt Codes, live braucht Bestaetigung', async () => {
  const admin = new Client(ctx.base);
  await admin.post('/api/login', { secret: ADMIN_PW });
  const before = (await admin.get('/api/admin/accounts')).json.accounts.length;
  assert.ok(before >= 1);
  assert.ok((await admin.get('/api/state')).json.counts.played + (await admin.get('/api/state')).json.counts.approved + (await admin.get('/api/state')).json.counts.pending + (await admin.get('/api/state')).json.counts.denied > 0);
  assert.equal((await admin.post('/api/admin/reset', { env: 'live' })).status, 400);
  assert.equal((await admin.post('/api/admin/reset', { env: 'live', confirm: 'nein' })).status, 400);
  assert.equal((await admin.post('/api/admin/reset', { env: 'live', confirm: 'ZURÜCKSETZEN' })).status, 200);
  const st = (await admin.get('/api/state')).json;
  assert.deepEqual(st.counts, { pending: 0, approved: 0, denied: 0, played: 0 });
  assert.equal(st.upcomingTotal, 0);
  assert.equal(st.players[1].playing || st.players[2].playing, false);
  assert.equal((await admin.get('/api/admin/accounts')).json.accounts.length, before);
  // Gaeste duerfen wieder wuenschen (Limit zurueckgesetzt)
  const g = new Client(ctx.base);
  assert.equal((await g.get('/api/guest/state')).json.limit.used, 0);
  const tech = new Client(ctx.base);
  const tcode = (await admin.post('/api/admin/accounts', { role: 'tech', label: 'x' })).json.code;
  await tech.post('/api/login', { secret: tcode });
  assert.equal((await tech.post('/api/admin/reset', { env: 'test' })).status, 403);
});

test('Assets werden nicht gecacht (Updates sofort sichtbar)', async () => {
  const c = new Client(ctx.base);
  const r = await c.get('/assets/style.css');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-cache/);
  assert.equal(r.headers.get('cdn-cache-control'), 'no-store');
});

test('Login-Sperre nach zu vielen Fehlversuchen', async () => {
  const c = new Client(ctx.base);
  let last;
  for (let i = 0; i < 10; i++) last = await c.post('/api/login', { secret: 'falsch-' + i });
  assert.equal(last.status, 429);
});
