import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import * as rq from '../src/requests.js';
import { cacheInfo } from '../src/apicache.js';

const ID = 'Q'.repeat(22), ID2 = 'R'.repeat(22), ID3 = 'S'.repeat(22);
const track = (id, cover) => ({ id, uri: `spotify:track:${id}`, title: `Song ${id[0]}`, artist: 'X', durationMs: 200000, cover });

test('Dashboards: Ton/Orga je nach Rolle, Startansicht pro Code, Gaeste online im Status', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const code = async (role, home) => (await admin.post('/api/admin/accounts', { role, label: `${role}-${home || 'std'}`, home })).json;
    const login = async (c) => { const cl = new Client(ctx.base); const r = await cl.post('/api/login', { secret: c.code }); return { cl, home: r.json.home }; };

    const ton = await login(await code('tech', '/ton'));
    assert.equal(ton.home, '/ton', 'Technik-Code fuer die Tonleute landet im Ton-Dashboard');
    assert.equal((await ton.cl.get('/api/me')).json.home, '/ton');
    assert.equal((await ton.cl.get('/ton')).status, 200);
    assert.equal((await ton.cl.get('/orga')).status, 200);
    const licht = await login(await code('light', '/tech'));      // darf die Technik nicht -> Standard der Rolle
    assert.equal(licht.home, '/light');
    assert.equal((await licht.cl.get('/ton')).status, 403);
    assert.equal((await licht.cl.get('/orga')).status, 403);
    const mod = await login(await code('mod'));
    assert.equal(mod.home, '/mod');
    assert.equal((await mod.cl.get('/orga')).status, 200);
    assert.equal((await mod.cl.get('/ton')).status, 403);

    // Startansicht nachtraeglich aendern, nur erlaubte
    const accs = (await admin.get('/api/admin/accounts')).json.accounts;
    const lichtAcc = accs.find((a) => a.role === 'light');
    assert.equal((await admin.post(`/api/admin/accounts/${lichtAcc.id}/home`, { home: '/ton' })).status, 400);
    const modAcc = accs.find((a) => a.role === 'mod');
    assert.equal((await admin.post(`/api/admin/accounts/${modAcc.id}/home`, { home: '/orga' })).status, 200);
    assert.equal((await mod.cl.get('/api/me')).json.home, '/orga');
    assert.equal((await admin.post(`/api/admin/accounts/${modAcc.id}/home`, { home: '' })).status, 200);
    assert.equal((await mod.cl.get('/api/me')).json.home, '/mod');
    const st = (await admin.get('/api/admin/settings')).json;
    assert.ok(st.roles.find((r) => r.id === 'tech').views.includes('/ton'));
    assert.ok(!st.roles.find((r) => r.id === 'light').views.includes('/ton'));

    // Status fuer die Dashboards
    const guest = new Client(ctx.base); await guest.get('/api/guest/state');
    const s = (await ton.cl.get('/api/state')).json;
    assert.equal(typeof s.guestsOnline, 'number');
    assert.ok('trackId' in s.players[1]);
    assert.ok(Array.isArray(s.schedule));

    // ausschaltbar
    await admin.post('/api/admin/settings', { features: { viewTon: false } });
    assert.equal((await ton.cl.get('/ton')).status, 404);
    assert.equal((await ton.cl.get('/api/me')).json.home, '/tech', 'ausgeschaltetes Dashboard -> Standard');
  } finally { await ctx.close(); }
});

test('Album-Cover: einmal geladen und gemerkt, nur fuer bekannte Songs, nur von Spotifys Bildserver', async () => {
  const ctx = await startTestApp();
  const realFetch = globalThis.fetch;
  const cdn = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://i.scdn.co/') || String(url).startsWith('https://evil.example/')) { cdn.push(String(url)); return new Response(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }); }
    return realFetch(url, opts);
  };
  try {
    rq.submitWish('live', track(ID, 'https://i.scdn.co/image/ab67616d00001e02aaaa'), 'dev-1');
    rq.submitWish('live', track(ID2, 'https://evil.example/x.jpg'), 'dev-2');
    rq.submitWish('live', track(ID3, null), 'dev-3');
    const anon = new Client(ctx.base);
    let r = await anon.get(`/cover/${ID}`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.match(r.headers.get('cache-control'), /max-age=604800/);
    r = await anon.get(`/cover/${ID}`);
    assert.equal(r.status, 200);
    assert.equal(cdn.length, 1, 'zweiter Abruf kommt aus dem Speicher');
    assert.equal(cacheInfo().covers, 1);
    assert.equal((await anon.get(`/cover/${ID2}`)).status, 404, 'fremder Bildserver wird nie abgefragt');
    assert.equal((await anon.get(`/cover/${ID3}`)).status, 404);
    assert.equal((await anon.get(`/cover/${'Z'.repeat(22)}`)).status, 404, 'unbekannter Song: keine Abfrage');
    assert.equal((await anon.get('/cover/..%2F..%2Fetc')).status, 404);
    assert.equal(cdn.length, 1);
    // Gaeste-Wunschliste und Staff-Warteschlange liefern die Track-ID fuer das Cover
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    assert.ok((await admin.get('/api/state')).json.pending.some((p) => p.trackId === ID));
    await admin.post('/api/admin/settings', { features: { covers: false } });
    assert.equal((await anon.get(`/cover/${ID}`)).status, 404);
  } finally { globalThis.fetch = realFetch; await ctx.close(); }
});

test('Auswertungen werden kurz gemerkt und nach neuen Wuenschen neu berechnet', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const a = (await admin.get('/api/stats')).json;
    const b = (await admin.get('/api/stats')).json;
    assert.deepEqual(a, b);
    rq.submitWish('live', track(ID, null), 'dev-x');
    const c = (await admin.get('/api/stats')).json;
    assert.equal(c.total, a.total + 1, 'neuer Wunsch -> neu berechnet');
    const an = (await admin.get('/api/analytics?range=0')).json;
    assert.ok(an);
  } finally { await ctx.close(); }
});
