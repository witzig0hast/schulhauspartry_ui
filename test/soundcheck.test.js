import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import * as rq from '../src/requests.js';
import { sendNotify } from '../src/notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Soundcheck-Modus: App steuert nichts (Fader, Wiedergabe, Automatik), Not-Aus bleibt, danach uebernimmt sie wieder', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const mod = new Client(ctx.base); await mod.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'mod', label: 'M' })).json.code });
    const e = ctx.engines.live; e.start();
    const t = (await e.spotify.search('uptown', 1))[0];
    rq.addAuto('live', t, null);
    await e.play(1);
    await sleep(300);
    assert.equal((await mod.post('/api/control/soundcheck', { on: true })).status, 403, 'nur Technik/Admin');

    let r = await admin.post('/api/control/soundcheck', { on: true });
    assert.equal(r.status, 200); assert.ok(r.json.hold.since);
    assert.equal(e.players[1].status().playing, false, 'Musik angehalten');
    assert.equal(e.state.wishMode, 'paused', 'Wünsche pausiert');
    const st = (await admin.get('/api/state')).json;
    assert.ok(st.hold, 'Technik sieht den Modus');

    // keine Fader-Befehle mehr, Knoepfe gesperrt
    const calls = []; const orig = e.x32.setPlayerLevel.bind(e.x32);
    e.x32.setPlayerLevel = (p, a, o) => { calls.push([p, a]); return orig(p, a, o); };
    e.setGain = e.setGain.bind(e);
    e.gain[1] = 0.3; await sleep(400);
    assert.equal(calls.length, 0, 'kein Fader bewegt');
    r = await admin.post('/api/control/play', { player: 1 });
    assert.equal(r.status, 400); assert.match(r.json.error, /Soundcheck-Modus/);
    assert.equal((await admin.post('/api/control/crossfade', {})).status, 400);
    assert.equal((await sendNotify({ title: 'x', message: 'y', key: 'down:x', env: 'live' })).reason, 'Soundcheck-Modus');

    // Not-Aus geht trotzdem (Fader sofort auf 0)
    const nonce = (await admin.post('/api/control/panic-arm')).json.nonce;
    assert.equal((await admin.post('/api/control/panic', { nonce })).status, 200);
    await sleep(300);
    assert.ok(calls.some(([, a]) => a === 0), 'Not-Aus setzt die Fader');
    await admin.post('/api/control/panic-clear');

    // Beenden: Wuensche wie vorher, Fader wieder von der App
    calls.length = 0;
    r = await admin.post('/api/control/soundcheck', { on: false });
    assert.equal(r.json.hold, null);
    assert.equal(e.state.wishMode, 'open');
    await sleep(400);
    assert.ok(calls.length > 0, 'App übernimmt die Fader wieder');
    const logs = (await admin.get('/api/logs?cats=pult')).json.logs;
    assert.ok(logs.some((x) => x.event === 'soundcheck.on') && logs.some((x) => x.event === 'soundcheck.off'));
  } finally { await ctx.close(); }
});
