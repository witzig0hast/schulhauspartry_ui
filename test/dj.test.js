import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';

test('Wunschlisten-Modus: Admin schaltet um, DJ markiert Songs von Hand, App spielt nichts', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { limit: { count: 50, windowMin: 15 } });
    const mk = async (role, label) => { const c = new Client(ctx.base); await c.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role, label })).json.code }); return c; };
    const dj = await mk('dj', 'DJ Max'), tech = await mk('tech', 'Tech'), mod = await mk('mod', 'Mod');
    const wish = async (q) => { const g = new Client(ctx.base); await g.get('/api/guest/state'); const t = (await g.get(`/api/guest/search?q=${q}`)).json.tracks[0]; await g.post('/api/guest/request', { trackId: t.id }); return g; };

    // Normalbetrieb: DJ-Markierungen sind gesperrt
    const g1 = await wish('blinding');
    const id1 = (await dj.get('/api/state')).json.pending[0].id;
    assert.equal((await dj.post('/api/dj/now', { id: id1 })).status, 409);

    // nur der Admin darf die Betriebsart aendern
    assert.equal((await tech.post('/api/admin/settings', { operation: { mode: 'wishlist' } })).status, 403);
    assert.equal((await admin.post('/api/admin/settings', { operation: { mode: 'kaputt' } })).status, 200);
    assert.equal((await dj.get('/api/state')).json.mode, 'full');
    assert.equal((await admin.post('/api/admin/settings', { operation: { mode: 'wishlist' } })).status, 200);
    assert.equal((await dj.get('/api/state')).json.mode, 'wishlist');

    // Der DJ darf Wuensche annehmen/ablehnen (kein Player zugewiesen)
    const a = await dj.post('/api/mod/decide', { id: id1, action: 'approve' });
    assert.equal(a.status, 200); assert.equal(a.json.request.player, null);
    await wish('levitating');
    const id2 = (await dj.get('/api/state')).json.pending[0].id;
    assert.equal((await dj.post('/api/mod/decide', { id: id2, action: 'deny', reason: 'Zu explizit' })).status, 200);

    // Die App spielt nichts: Wiedergabe-Steuerung ist gesperrt
    assert.equal((await tech.post('/api/control/play', { player: 1 })).status, 409);
    assert.equal((await tech.post('/api/control/crossfade', { sec: 5 })).status, 409);
    assert.equal((await tech.post('/api/control/wishmode', { mode: 'open' })).status, 200);       // Wuensche oeffnen/schliessen geht weiter

    // Gast sieht "angenommen" ohne Platz in der Warteschlange
    const mine = (await g1.get('/api/guest/state')).json.requests[0];
    assert.equal(mine.status, 'approved'); assert.equal(mine.ahead, null); assert.equal(mine.position, null);

    // DJ markiert: laeuft jetzt -> alle sehen es; dann gespielt; Setlist enthaelt es
    assert.equal((await dj.post('/api/dj/now', { id: id1 })).json.status, 'playing');
    const gs = (await g1.get('/api/guest/state')).json;
    assert.equal(gs.nowPlaying.title, mine.title); assert.equal(gs.mode, 'wishlist');
    assert.equal((await dj.post('/api/dj/played', { id: id1 })).json.status, 'played');
    assert.equal((await g1.get('/api/guest/state')).json.nowPlaying, null);
    const csv = (await admin.get('/api/admin/setlist.csv?env=live')).text;
    assert.match(csv, new RegExp(mine.title));
    // versehentlich: zurueck in die Liste
    assert.equal((await dj.post('/api/dj/undo', { id: id1 })).json.status, 'approved');
    assert.equal((await dj.get('/api/state')).json.upcoming.length, 1);
    // Marken nur fuer angenommene Songs, nicht doppelt
    assert.equal((await dj.post('/api/dj/played', { id: 99999 })).status, 409);
    assert.equal((await dj.post('/api/dj/played', { id: id1 })).status, 200);
    assert.equal((await dj.post('/api/dj/played', { id: id1 })).status, 409);

    // Rechte: DJ hat keinen Admin-Zugang; Moderation darf mitmarkieren; Seite ist erreichbar
    assert.equal((await dj.get('/api/admin/settings')).status, 403);
    assert.equal((await dj.get('/dj')).status, 200);
    assert.equal((await mod.get('/dj')).status, 200);
    assert.equal((await new Client(ctx.base).post('/api/dj/now', { id: id1 })).status, 401);

    // zurueck in den Normalbetrieb
    await admin.post('/api/admin/settings', { operation: { mode: 'full' } });
    assert.equal((await tech.post('/api/control/pause', { player: 1 })).status, 200);
    // Funktion DJ-Ansicht ausschaltbar
    await admin.post('/api/admin/settings', { features: { viewDj: false } });
    assert.equal((await dj.get('/dj')).status, 404);
  } finally { await ctx.close(); }
});
