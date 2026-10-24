import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import * as rq from '../src/requests.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Stopptanz & Co.: Stopp/Weiter sofort still, Pause+Play setzt fort, Jetzt spielen, Als Naechstes, gesperrt von', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const tech = new Client(ctx.base); await tech.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'tech', label: 'Tom' })).json.code });
    const mod = new Client(ctx.base); await mod.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'mod', label: 'Mia' })).json.code });
    const e = ctx.engines.live; e.start();
    const mutes = []; const origMute = e.x32.setMute.bind(e.x32); e.x32.setMute = async (p, m) => { mutes.push([p, m]); return origMute(p, m); };

    // Jetzt spielen, ohne dass etwas laeuft
    const up = (await tech.get('/api/queue/search?q=uptown')).json.tracks[0];
    let r = await tech.post('/api/queue/play-now', { trackId: up.id });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await sleep(200);
    assert.equal(e.players[e.current].status().title, 'Uptown Funk');
    assert.equal((await mod.post('/api/queue/play-now', { trackId: up.id })).status, 403, 'Moderation nicht');

    // Stopp: sofort Mute + Pause, Weiter: Fortsetzen an derselben Stelle + Mute auf
    const p = e.current;
    await sleep(300);
    r = await tech.post('/api/control/stop');
    assert.equal(r.status, 200);
    assert.deepEqual(mutes.at(-1), [p, true], 'sofort still über das Pult');
    assert.equal(e.players[p].status().playing, false);
    const pos = e.players[p].status().positionMs;
    assert.ok((await tech.get('/api/state')).json.quickStopped);
    await sleep(300);
    r = await tech.post('/api/control/go');
    assert.equal(r.status, 200);
    assert.equal(e.players[p].status().playing, true);
    assert.equal(e.players[p].status().title, 'Uptown Funk', 'derselbe Song');
    assert.ok(Math.abs(e.players[p].status().positionMs - pos) < 400, 'an derselben Stelle');
    assert.deepEqual(mutes.at(-1), [p, false]);

    // Pause + Play (normale Knoepfe) setzt den angehaltenen Song fort, auch wenn er nicht aus der Warteschlange kam
    rq.addAuto('live', (await e.spotify.search('believer', 1))[0], e.current);   // es wartet ein anderer Song
    await tech.post('/api/control/pause', { player: p });
    e.trackIdOf[p] = null;   // so, als waere der Song direkt in Spotify gestartet worden
    await tech.post('/api/control/play', { player: p });
    assert.equal(e.players[p].status().title, 'Uptown Funk', 'fortgesetzt, nicht der nächste Song');

    // Stopp, dann Play-Knopf: wirkt wie Weiter (Kanal wieder auf)
    await tech.post('/api/control/stop'); mutes.length = 0;
    await tech.post('/api/control/play', { player: p });
    assert.deepEqual(mutes, [[p, false]]); assert.equal(e.players[p].status().playing, true);

    // Jetzt spielen, waehrend Musik laeuft: kurzer Crossfade zum neuen Song
    const lev = (await tech.get('/api/queue/search?q=levitating')).json.tracks[0];
    r = await tech.post('/api/queue/play-now', { trackId: lev.id, sec: 1 });
    assert.equal(r.status, 200);
    assert.ok(e.crossfade, 'Crossfade läuft');
    await sleep(1400);
    assert.equal(e.players[e.current].status().title, 'Levitating');

    // Als Naechstes: Platz 1 (vor dem wartenden Believer)
    const th = (await tech.get('/api/queue/search?q=thunder')).json.tracks[0];
    await tech.post('/api/queue/add', { trackId: th.id, next: true });
    assert.equal((await tech.get('/api/state')).json.upcoming[0].trackId, th.id);
    // Song aus der Warteschlange sofort spielen
    const bel = (await tech.get('/api/state')).json.upcoming.find((u) => u.title === 'Believer');
    r = await tech.post('/api/queue/play-now', { id: bel.id, sec: 0.5 });
    assert.equal(r.status, 200); await sleep(900);
    assert.equal(e.players[e.current].status().title, 'Believer');

    // Sperrliste: wer hat gesperrt
    await mod.post('/api/mod/blacklist', { kind: 'track', trackId: th.id, title: 'Thunder', artist: 'Imagine Dragons', reason: 'Test' });
    const bl = (await admin.get('/api/state')).json.blacklist;
    assert.equal(bl.find((b) => b.title === 'Thunder').by, 'Mia');
    const logs = (await admin.get('/api/logs?cats=wiedergabe')).json.logs;
    assert.ok(logs.some((x) => x.event === 'play.now') && logs.some((x) => x.event === 'control.stop') && logs.some((x) => x.event === 'control.go'));
  } finally { await ctx.close(); }
});
