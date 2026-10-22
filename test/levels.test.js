import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { settings } from '../src/settings.js';
import { ampToFader } from '../src/adapters/x32.js';

test('Pegel-Fenster: Grundpegel am Fader, Spotify-Lautstaerke, Mic-Fader, Testmusik – nur fuer Technik/Admin', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const code = async (role) => (await admin.post('/api/admin/accounts', { role, label: role })).json.code;
    const tech = new Client(ctx.base); await tech.post('/api/login', { secret: await code('tech') });
    const mod = new Client(ctx.base); await mod.post('/api/login', { secret: await code('mod') });
    assert.equal((await mod.post('/api/control/levels', { levels: { playerDb: { 1: -6 } } })).status, 403);

    // Staff-Status enthaelt die Werte fuer das Fenster
    const st = (await tech.get('/api/state')).json;
    assert.deepEqual(st.levels.playerDb, { 1: 0, 2: 0 });
    assert.deepEqual(st.channels.p1, [1, 2]);
    assert.equal((await mod.get('/api/state')).json.levels, undefined);

    const e = ctx.engines.live;
    e.applyLevels();
    assert.ok(Math.abs(e.x32.levels[1] - 1) < 1e-9);
    let r = await tech.post('/api/control/levels', { levels: { playerDb: { 1: -6, 2: 99 }, spotifyVol: { 1: 70 } }, maxGain: 0.8, duckDb: -18, crossfadeSec: 5 });
    assert.equal(r.status, 200);
    assert.equal(settings().levels.playerDb[1], -6);
    assert.equal(settings().levels.playerDb[2], 6, 'auf +6 dB begrenzt');
    assert.equal(settings().limits.maxGain, 0.8); assert.equal(settings().ducking.db, -18); assert.equal(settings().auto.crossfadeSec, 5);
    e.applyLevels();
    assert.ok(Math.abs(e.x32.levels[1] - 0.8 * Math.pow(10, -6 / 20)) < 1e-6, `Fader P1 ${e.x32.levels[1]}`);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(e.players[1].volume, 70, 'Spotify-Lautstaerke am Player gesetzt');

    // Mic-Fader nur, wenn eingeschaltet
    await tech.post('/api/control/levels', { levels: { micDb: [-10, 0, 3] } });
    assert.equal(e.x32.faders, undefined);
    await tech.post('/api/control/levels', { levels: { micControl: true, micDb: [-10, 0, 3] } });
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(Math.abs(e.x32.faders[5] - ampToFader(Math.pow(10, -10 / 20))) < 1e-9 && Math.abs(e.x32.faders[7] - ampToFader(Math.pow(10, 3 / 20))) < 1e-9);

    // Bestaetigen merkt sich Zeit und Person
    assert.equal(settings().levels.confirmedAt, 0);
    await tech.post('/api/control/levels', { levels: { confirm: true } });
    assert.ok(settings().levels.confirmedAt > 0); assert.equal(settings().levels.confirmedBy, 'tech');

    // Testmusik: spielt bis Stopp, normale Wiedergabe beendet nur die Verwaltung (der Song laeuft weiter)
    r = await tech.post('/api/control/level-test', { player: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.ok(r.json.title);
    assert.equal(e.levelTestOn, 2); assert.equal(e.players[2].status().playing, true);
    assert.equal((await tech.post('/api/control/level-test', { player: 1 })).status, 200, 'umschalten zwischen den Playern geht');
    assert.equal(e.players[2].status().playing, false); assert.equal(e.levelTestOn, 1);
    await tech.post('/api/control/level-test', { stop: true });
    assert.equal(e.levelTestOn, null); assert.equal(e.players[1].status().playing, false);
    // bei laufender Musik keine Testmusik
    await e.playDirect(1, (await e.spotify.search('a', 1))[0]);
    assert.equal((await tech.post('/api/control/level-test', { player: 2 })).status, 400);
  } finally { await ctx.close(); }
});
