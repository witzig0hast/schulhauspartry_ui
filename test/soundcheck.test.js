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

test('System startet aus: nur Admin schaltet ein; Playlist geht auch im Aus; Start-Playlist ohne lesbare Songs laeuft direkt', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const tech = new Client(ctx.base); await tech.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'tech', label: 'T' })).json.code });
    const e = ctx.engines.live; e.start();
    // "Alles löschen" in Live -> System wieder aus (Standard)
    await admin.post('/api/admin/reset', { env: 'live', confirm: 'ZURÜCKSETZEN' });
    assert.ok(e.held && e.state.hold.initial, 'nach dem Zurücksetzen aus');
    assert.ok((await admin.get('/api/admin/settings')).json.system.hold);
    let r = await tech.post('/api/control/soundcheck', { on: false });
    assert.equal(r.status, 403); assert.match(r.json.error, /nur ein Admin/);

    // Playlist im Aus: Spotify spielt, Fader bleiben unberuehrt
    const calls = []; const orig = e.x32.setPlayerLevel.bind(e.x32);
    e.x32.setPlayerLevel = (p, a, o) => { calls.push([p, a]); return orig(p, a, o); };
    r = await tech.post('/api/control/playlist', { uri: 'https://open.spotify.com/playlist/' + 'A'.repeat(22), player: 2, shuffle: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(e.players[2].status().playing, true);
    await sleep(300);
    assert.equal(calls.length, 0, 'kein Fader bewegt');
    assert.equal((await tech.get('/api/state')).json.playlist.player, 2);
    assert.equal((await admin.get('/api/admin/settings')).json.settings.playlistPlay.player, 2, 'zuletzt benutzte Playlist gemerkt');
    await tech.post('/api/control/playlist-stop');
    await sleep(100);
    assert.equal(e.players[2].status().playing, false);
    assert.equal((await tech.get('/api/state')).json.playlist, null);

    // Admin schaltet ein
    r = await admin.post('/api/control/soundcheck', { on: false });
    assert.equal(r.status, 200); assert.equal(e.held, false); assert.ok(e.state.activatedAt);

    // Start-Playlist: Spotify gibt die Songs nicht heraus -> trotzdem direkt abspielen
    await admin.post('/api/admin/settings', { start: { playlist: 'spotify:playlist:' + 'B'.repeat(22), minQueue: 3 } });
    e.spotify.getPlaylistTracks = async () => [];
    e.spotify.lastError = 'Playlist nicht lesbar (403)';
    r = await tech.post('/api/control/start-evening');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok([1, 2].some((p) => e.players[p].status().playing), 'Musik läuft');
    const logs = (await admin.get('/api/logs?cats=wiedergabe')).json.logs;
    assert.ok(logs.some((x) => x.event === 'start.playlist_direct' && /403/.test(x.msg)));
  } finally { await ctx.close(); }
});

test('Neue Installation: System startet deaktiviert, einmal eingeschaltet bleibt es an', async () => {
  const { createApp } = await import('../src/app.js');
  const { config } = await import('../src/config.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  config.adminPassword = 'super-geheimes-passwort-123'; config.secret = 'test-secret-test-secret-test-secret-1234';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-'));
  let ctx = createApp({ dataDir: dir, startEngines: false });
  try {
    assert.ok(ctx.engines.live.held, 'Standard: aus');
    assert.equal(ctx.engines.test.held, false, 'Testmodus nicht betroffen');
    ctx.engines.live.endHold({ by: 'Admin' });
  } finally { await ctx.close(); }
  ctx = createApp({ dataDir: dir, startEngines: false });
  try { assert.equal(ctx.engines.live.held, false, 'nach Neustart weiter an'); }
  finally { await ctx.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
