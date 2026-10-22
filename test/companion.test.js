import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { settings } from '../src/settings.js';

const call = (base, path, token, method = 'POST') => fetch(base + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('Companion: Token, Aktionen, Status, Not-Aus nur doppelt, Protokoll', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const tech = new Client(ctx.base); await tech.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'tech', label: 'T' })).json.code });
    assert.equal((await call(ctx.base, '/api/companion/state', 'x', 'GET')).status, 404, 'aus, solange kein Token');
    assert.equal((await tech.post('/api/admin/companion/token')).status, 403, 'nur Admin');
    const { token } = (await admin.post('/api/admin/companion/token')).json;
    assert.ok(token.length >= 30);
    assert.match(settings().companion.tokenHash, /^[0-9a-f]{64}$/, 'nur als Hash gespeichert');
    assert.ok(!JSON.stringify((await admin.get('/api/admin/settings')).json).includes(settings().companion.tokenHash));

    assert.equal((await call(ctx.base, '/api/companion/state', 'falsch', 'GET')).status, 401);
    let r = await call(ctx.base, '/api/companion/state', token, 'GET');
    assert.equal(r.status, 200); assert.equal(r.json.wish_mode, 'open'); assert.equal(r.json.panic, false);

    // Aktionen
    assert.equal((await call(ctx.base, '/api/companion/action/wishes-close', token)).status, 200);
    assert.equal(ctx.engines.live.state.wishMode, 'closed');
    assert.equal((await call(ctx.base, '/api/companion/action/crossfade', token)).status, 409, 'leere Warteschlange: verständlicher Fehler');
    const before = settings().auto.enabled;
    r = await call(ctx.base, '/api/companion/action/auto-toggle', token);
    assert.equal(settings().auto.enabled, !before); assert.equal(r.json.result, before ? 'aus' : 'an');
    assert.equal((await call(ctx.base, '/api/companion/action/rm-rf', token)).status, 404);

    // Not-Aus: erster Druck macht nur scharf, zweiter loest aus
    r = await call(ctx.base, '/api/companion/action/panic', token);
    assert.match(r.json.result, /scharf/); assert.equal(ctx.engines.live.state.panic, false);
    assert.equal((await call(ctx.base, '/api/companion/state', token, 'GET')).json.panic_armed, true);
    r = await call(ctx.base, '/api/companion/action/panic', token);
    assert.equal(r.json.result, 'ausgelöst'); assert.equal(ctx.engines.live.state.panic, true);
    await call(ctx.base, '/api/companion/action/panic-clear', token);
    assert.equal(ctx.engines.live.state.panic, false);

    // Testmodus hat eigene Adresse
    await admin.post('/api/admin/settings', { test: { enabled: true } });
    assert.equal((await call(ctx.base, `/${settings().test.prefix}/api/companion/action/wishes-pause`, token)).status, 200);
    assert.equal(ctx.engines.test.state.wishMode, 'paused');
    assert.equal(ctx.engines.live.state.wishMode, 'closed');

    // Protokoll
    const logs = (await tech.get('/api/logs?cats=companion')).json.logs;
    assert.ok(logs.some((e) => e.event === 'companion.panic' && /ausgelöst/.test(e.msg)));
    assert.ok(logs.some((e) => e.event === 'companion.denied'));
    // Ausschalten / neuer Token macht den alten ungueltig
    const { token: t2 } = (await admin.post('/api/admin/companion/token')).json;
    assert.equal((await call(ctx.base, '/api/companion/state', token, 'GET')).status, 401);
    assert.equal((await call(ctx.base, '/api/companion/state', t2, 'GET')).status, 200);
    await admin.post('/api/admin/settings', { companion: { enabled: false } });
    assert.equal((await call(ctx.base, '/api/companion/state', t2, 'GET')).status, 404);
  } finally { await ctx.close(); }
});
