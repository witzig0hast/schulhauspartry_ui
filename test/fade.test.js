import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { startTestApp } from './helpers.js';
import { ampToFader, faderToAmp } from '../src/adapters/x32.js';
import { createRelay } from '../pi-relay/relay.js';
import { encode, decode } from '../pi-relay/osc.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('faderToAmp ist die Umkehrung von ampToFader', () => {
  for (const a of [1, 0.5, 0.1, 0.01, 0.001, 0.0001]) assert.ok(Math.abs(faderToAmp(ampToFader(a)) - a) / a < 1e-6, String(a));
  assert.equal(faderToAmp(0), 0);
});

test('Fade-out: gleichmaessig am Fader, danach Kanal stumm und Fader auf null; Fade-in gibt den Kanal wieder frei', async () => {
  const ctx = await startTestApp();
  try {
    const e = ctx.engines.live;
    e.start();
    const t = (await e.spotify.search('uptown', 1))[0];
    await e.playDirect(1, t, 1);
    await sleep(300);
    const samples = [];
    e.fadeOut(1, 1);
    const t0 = Date.now();
    while (Date.now() - t0 < 950) { samples.push([Date.now() - t0, ampToFader(e.x32.levels[1])]); await sleep(100); }
    // Fader-Stellung faellt linear mit der Zeit (nicht erst langsam, dann schnell)
    const f0 = ampToFader(1);
    for (const [ms, f] of samples.filter(([ms]) => ms > 150 && ms < 850)) assert.ok(Math.abs(f - f0 * (1 - ms / 1000)) < 0.08, `bei ${ms} ms: ${f.toFixed(3)} statt ${(f0 * (1 - ms / 1000)).toFixed(3)}`);
    await sleep(500);
    assert.equal(e.x32.mutes?.[1], true, 'Kanal stumm');
    assert.equal(e.muted[1], true);
    assert.equal(e.players[1].status().playing, false, 'Player pausiert');
    assert.equal(e.gain[1], 0, 'Fader bleibt unten');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(e.x32.levels[1], 0, 'eine halbe Sekunde nach dem Muten steht der Fader auf null');

    // Fade-in: erst Fader auf 0, dann Kanal frei, dann hoch
    const rq = await import('../src/requests.js');
    const t2 = (await e.spotify.search('levitating', 1))[0];
    rq.addAuto('live', t2, null);
    const calls = [];
    const origLevel = e.x32.setPlayerLevel.bind(e.x32), origMute = e.x32.setMute.bind(e.x32);
    e.x32.setPlayerLevel = (p, amp, o) => { calls.push(['level', p, amp, !!o?.instant]); return origLevel(p, amp, o); };
    e.x32.setMute = (p, m) => { calls.push(['mute', p, m]); return origMute(p, m); };
    await e.fadeIn(1, 0.5);
    const iMute = calls.findIndex((c) => c[0] === 'mute' && c[2] === false);
    assert.ok(iMute > 0, 'Kanal freigegeben');
    assert.deepEqual(calls[iMute - 1], ['level', 1, 0, true], 'vorher Fader sofort auf 0');
    assert.equal(e.muted[1], false);
    await sleep(800);
    assert.ok(Math.abs(e.gain[1] - 1) < 1e-6);

    // abschaltbar
    ctx.engines.live.x32.mutes[1] = false;
    const { applyPatch } = await import('../src/settings.js');
    applyPatch({ x32: { muteAfterFade: false } }, { allow: ['x32'] });
    e.fadeOut(1, 0.2); await sleep(700);
    assert.equal(e.muted[1], false, 'ohne Stummschalten');
    assert.equal(e.gain[1], 1, 'ohne Stummschalten faehrt der Fader zurück in die Grundstellung');
    applyPatch({ x32: { muteAfterFade: true } }, { allow: ['x32'] });
  } finally { await ctx.close(); }
});

test('Relay: Mute-Befehl und gleichmaessige Fahrt ohne Stufen bei einem Strom von Werten', async () => {
  const sock = dgram.createSocket('udp4'); const got = [];
  sock.on('message', (msg, rinfo) => { const m = decode(msg); got.push({ ...m, t: Date.now() }); if (/^\/ch\/\d\d\/mix\/fader$/.test(m.address) && !m.args.length) sock.send(encode(m.address, [{ t: 'f', v: 0.75 }]), rinfo.port, rinfo.address); });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  const TOKEN = 'test-token-test-token-1234';
  const relay = createRelay({ x32Host: '127.0.0.1', x32Port: sock.address().port, token: TOKEN, bind: '127.0.0.1', port: 0 });
  const port = await relay.start();
  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
  try {
    await sleep(150);
    assert.equal((await post('/x32/mute', { channels: [1, 2], muted: true })).status, 200);
    await sleep(50);
    assert.deepEqual(got.filter((m) => /mix\/on$/.test(m.address) && m.args.length && ['/ch/01/mix/on', '/ch/02/mix/on'].includes(m.address)).map((m) => m.args[0]), [0, 0]);
    assert.equal((await post('/x32/mute', { channels: [40], muted: true })).status, 400);
    // Blende ueber 1 s: alle 125 ms ein neuer Wert -> das Relay faehrt dazwischen ohne Stillstand
    const start = got.length;
    for (let i = 1; i <= 8; i++) { await post('/x32/level', { channels: [1], fader: 0.75 - 0.75 * i / 8, speed: 3 }); await sleep(125); }
    await sleep(200);
    const moves = got.slice(start).filter((m) => m.address === '/ch/01/mix/fader' && m.args.length).map((m) => m.args[0]);
    const steps = moves.slice(1).map((v, i) => moves[i] - v);
    assert.ok(moves.length >= 20, `viele kleine Schritte (${moves.length})`);
    const big = Math.max(...steps);
    assert.ok(big < 0.06, `kein Sprung (groesster Schritt ${big.toFixed(3)})`);
    assert.ok(Math.abs(moves.at(-1)) < 1e-3, 'unten angekommen');
  } finally { await relay.stop(); sock.close(); }
});
