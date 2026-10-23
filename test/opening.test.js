import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { maybeFill } from '../src/filler.js';

test('Freischaltung: Wuensche bleiben zu bis Knopf oder Uhrzeit; Start-Playlist laeuft bis zu den ersten Wuenschen', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { limit: { count: 50, windowMin: 15 } });
    const mk = async (role, label) => { const c = new Client(ctx.base); await c.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role, label })).json.code }); return c; };
    const tech = await mk('tech', 'Tech'), mod = await mk('mod', 'Mod');
    const guest = async () => { const g = new Client(ctx.base); await g.get('/api/guest/state'); return g; };
    const wish = async (g, q) => { const t = (await ctx.engines.live.spotify.search(q, 1))[0]; return g.post('/api/guest/request', { trackId: t.id }); };
    const live = ctx.engines.live;

    // Freischaltung scharf stellen: Wuensche sofort zu, mit Hinweistext
    assert.equal((await admin.post('/api/admin/settings', { opening: { enabled: true, at: '23:59', auto: true, message: 'Wünsche ab {zeit} Uhr!' }, start: { playlist: 'spotify:playlist:' + 'a'.repeat(22), minQueue: 3 } })).status, 200);
    const g1 = await guest();
    let gs = (await g1.get('/api/guest/state')).json;
    assert.equal(gs.wishMode, 'closed'); assert.equal(gs.message, 'Wünsche ab 23:59 Uhr!');
    assert.equal((await wish(g1, 'blinding')).status, 423);
    assert.equal((await g1.get('/api/guest/search?q=blinding')).status, 423, 'Suche aus, solange die Wünsche zu sind');

    // Start-Playlist: Warteschlange mit Fuelltiteln, Player 1 spielt
    assert.equal((await mod.post('/api/control/start-evening')).status, 403);
    assert.equal((await tech.post('/api/control/start-evening')).status, 200);
    const st = (await tech.get('/api/state')).json;
    assert.ok(st.players[1].playing || st.players[2].playing);
    assert.equal(st.opening.started, true);
    assert.ok(st.opening.awaiting);
    assert.ok(st.upcoming.length >= 1 && st.upcoming.every((u) => u.auto));          // nur Start-Playlist-Songs

    // Nur wer darf, schaltet frei (Technik/Admin), die Moderation nicht
    assert.equal((await mod.post('/api/control/open-wishes')).status, 403);
    assert.equal((await tech.post('/api/control/open-wishes')).status, 200);
    gs = (await g1.get('/api/guest/state')).json;
    assert.equal(gs.wishMode, 'open'); assert.equal(gs.opensAt, null);
    assert.equal((await wish(g1, 'uptown')).status, 200);   // nicht in der (simulierten) Start-Playlist, sonst waere es ein Duplikat

    // Angenommener Wunsch kommt VOR die Fuelltitel
    const pend = (await mod.get('/api/state')).json.pending[0];
    assert.equal((await mod.post('/api/mod/decide', { id: pend.id, action: 'approve' })).status, 200);
    const up = (await mod.get('/api/state')).json.upcoming;
    assert.equal(up[0].title, pend.title); assert.equal(up[0].auto, false);
    const g2 = await guest(); await wish(g2, 'levitating');
    const p2 = (await mod.get('/api/state')).json.pending[0];
    await mod.post('/api/mod/decide', { id: p2.id, action: 'approve' });
    const up2 = (await mod.get('/api/state')).json.upcoming;
    assert.deepEqual(up2.slice(0, 2).map((u) => u.title), [pend.title, p2.title]);    // Reihenfolge der Wuensche bleibt
    assert.ok(up2.slice(2).every((u) => u.auto));

    // Uhrzeit: automatisch freischalten
    await admin.post('/api/admin/settings', { opening: { enabled: false } });
    await admin.post('/api/admin/settings', { opening: { enabled: true, at: '23:59' } });
    assert.equal(live.state.wishMode, 'closed');
    live.state.openAtTs = Date.now() - 1000;
    await live.tick();
    assert.equal(live.state.wishMode, 'open'); assert.equal(live.state.awaitOpen, false);
    // ohne Freischaltung wieder ausschalten: Wuensche offen
    await admin.post('/api/admin/settings', { opening: { enabled: false } });
    await admin.post('/api/admin/settings', { opening: { enabled: true } });
    assert.equal(live.state.wishMode, 'closed');
    await admin.post('/api/admin/settings', { opening: { enabled: false } });
    assert.equal(live.state.wishMode, 'open');
    // Funktion ausschaltbar
    await admin.post('/api/admin/settings', { features: { startPlaylist: false } });
    assert.equal((await tech.post('/api/control/start-evening')).status, 404);
  } finally { await ctx.close(); }
});

test('Start-Playlist fuellt nach, solange noch kein Wunsch angenommen wurde', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { start: { playlist: 'spotify:playlist:' + 'b'.repeat(22), minQueue: 4 } });
    const tech = new Client(ctx.base); await tech.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'tech', label: 'T' })).json.code });
    const live = ctx.engines.live;
    await tech.post('/api/control/start-evening');
    const before = (await tech.get('/api/state')).json.upcoming.length;
    // Eintrag verbrauchen -> Warteschlange kleiner als minQueue -> Nachfuellen aus der Start-Playlist
    const first = (await tech.get('/api/state')).json.upcoming[0];
    await tech.post('/api/mod/remove', { id: first.id });
    live.lastFill = 0;
    const added = await maybeFill(live, Date.now() + 60000);
    assert.ok(added && added.deviceId === 'auto');
    assert.ok((await tech.get('/api/state')).json.upcoming.length >= before - 1);
  } finally { await ctx.close(); }
});
