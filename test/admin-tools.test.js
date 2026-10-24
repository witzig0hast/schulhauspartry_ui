import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import * as rq from '../src/requests.js';
import { getDb } from '../src/db.js';

test('Admin/Technik legen Lieder selbst in die Warteschlange; Moderation nicht; gesperrt/doppelt abgelehnt', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const tech = new Client(ctx.base); await tech.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'mod', label: 'M' })).json.code });   // Moderation darf es nicht
    assert.equal((await tech.get('/api/queue/search?q=uptown')).status, 403);
    const found = (await admin.get('/api/queue/search?q=uptown')).json.tracks;
    assert.ok(found.length && found[0].id);
    assert.equal((await tech.post('/api/queue/add', { trackId: found[0].id })).status, 403);
    let r = await admin.post('/api/queue/add', { trackId: found[0].id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const st = (await admin.get('/api/state')).json;
    const u = st.upcoming.find((x) => x.id === r.json.id);
    assert.ok(u && u.team && !u.auto && !u.ai, 'als Team-Song markiert');
    assert.equal((await admin.post('/api/queue/add', { trackId: found[0].id })).status, 409, 'nicht doppelt');
    assert.equal((await admin.get('/api/queue/search?q=uptown')).json.tracks[0].queued, true);
    // vorziehen
    const lev = (await admin.get('/api/queue/search?q=levitating')).json.tracks[0];
    r = await admin.post('/api/queue/add', { trackId: lev.id, next: true });
    assert.equal(r.status, 200);
    const up2 = (await admin.get('/api/state')).json.upcoming;
    assert.equal(up2[0].trackId, lev.id, 'Als Nächstes = Platz 1'); assert.ok(up2[0].prioritized);
    const logs = (await admin.get('/api/logs?cats=moderation')).json.logs;
    assert.ok(logs.some((e) => e.event === 'queue.added' && /als Nächstes/.test(e.msg)));
    assert.equal((await admin.post('/api/queue/add', { trackId: 'gibtesnicht' })).status, 404);
    assert.equal((await admin.post('/api/queue/add', { trackId: '../x' })).status, 400);
  } finally { await ctx.close(); }
});

test('Zuruecksetzen: nur gespielte Lieder oder nur Statistik, Rest bleibt', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const e = ctx.engines.live;
    const [a, b, c] = await Promise.all(['uptown', 'levitating', 'believer'].map(async (q) => (await e.spotify.search(q, 1))[0]));
    const wa = rq.submitWish('live', a, 'dev-a'), wb = rq.submitWish('live', b, 'dev-b'); rq.submitWish('live', c, 'dev-c');
    getDb().prepare("UPDATE requests SET status = 'played', played_at = ? WHERE id = ?").run(Date.now(), wa.request.id);
    getDb().prepare("UPDATE requests SET status = 'approved', queue_pos = 1 WHERE id = ?").run(wb.request.id);
    assert.equal(rq.limitState('live', 'dev-a').used, 1);
    // Live braucht die Bestaetigung
    assert.equal((await admin.post('/api/admin/reset', { env: 'live', parts: ['played'] })).status, 400);
    let r = await admin.post('/api/admin/reset', { env: 'live', parts: ['played'], confirm: 'ZURÜCKSETZEN' });
    assert.equal(r.status, 200); assert.deepEqual(r.json.parts, ['played']);
    let n = rq.counts('live');
    assert.equal(n.played, 0); assert.equal(n.approved, 1); assert.equal(n.pending, 1, 'Rest bleibt');
    assert.equal(rq.limitState('live', 'dev-a').used, 1, 'Zähler bleiben');
    r = await admin.post('/api/admin/reset', { env: 'live', parts: ['stats'], confirm: 'ZURÜCKSETZEN' });
    assert.equal(r.status, 200);
    assert.equal(rq.limitState('live', 'dev-a').used, 0, 'Gäste haben wieder volle Wünsche');
    n = rq.counts('live'); assert.equal(n.approved + n.pending, 2, 'Wünsche bleiben');
    assert.equal((await admin.post('/api/admin/reset', { env: 'live', parts: ['quatsch'], confirm: 'ZURÜCKSETZEN' })).status, 400);
    r = await admin.post('/api/admin/reset', { env: 'live', parts: ['queue'], confirm: 'ZURÜCKSETZEN' });
    n = rq.counts('live'); assert.equal(n.approved + n.pending, 0);
  } finally { await ctx.close(); }
});
