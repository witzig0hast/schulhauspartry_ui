import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { createRelay } from '../pi-relay/relay.js';

const TOKEN = 'test-token-test-token-1234';

test('Admin: X32-Adresse einstellen, Status vom Pi, nur Admin', async () => {
  const ctx = await startTestApp();
  const relay = createRelay({ x32Host: '127.0.0.1', x32Port: 9, token: TOKEN, bind: '127.0.0.1', port: 0, discoverTargets: [] });
  const port = await relay.start();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const tech = new Client(ctx.base); await tech.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'tech', label: 'T' })).json.code });
    let r = await admin.get('/api/admin/x32/status');
    assert.equal(r.status, 400); assert.match(r.json.error, /HTTP-Relay/);
    assert.equal((await tech.get('/api/admin/x32/status')).status, 403);
    assert.equal((await admin.post('/api/admin/settings', { x32: { host: '203.0.113.7' } })).status, 400, 'öffentliche Adresse abgelehnt');
    await admin.post('/api/admin/settings', { x32: { adapter: 'http', piUrl: `http://127.0.0.1:${port}`, piToken: TOKEN, host: '192.168.1.77', port: 10023 } });
    r = await admin.get('/api/admin/x32/status');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.host, r.json.port, r.json.source], ['192.168.1.77', 10023, 'admin']);
    assert.equal(relay.cfg.x32Host, '192.168.1.77');
    r = await admin.post('/api/admin/x32/discover');
    assert.deepEqual(r.json.found, []);
    const logs = (await admin.get('/api/logs?cats=verbindung')).json.logs;
    assert.ok(logs.some((e) => e.event === 'x32.host' && /192\.168\.1\.77/.test(e.msg)));
    assert.ok(logs.some((e) => e.event === 'x32.discover'));
  } finally { await relay.stop(); await ctx.close(); }
});
