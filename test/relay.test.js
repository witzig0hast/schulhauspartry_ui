import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { createRelay } from '../pi-relay/relay.js';
import { encode, decode, encodeMeters } from '../pi-relay/osc.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'test-token-test-token-1234';

// Fake-X32: nimmt OSC entgegen und antwortet wie das Pult
async function fakeX32() {
  const sock = dgram.createSocket('udp4');
  const received = [];
  const meters = new Array(70).fill(0);
  const micOn = { 5: 1, 6: 0, 7: 1 };
  sock.on('message', (msg, rinfo) => {
    const m = decode(msg);
    received.push(m);
    const mm = /^\/ch\/(\d\d)\/mix\/on$/.exec(m.address);
    if (mm) sock.send(encode(m.address, [{ t: 'i', v: micOn[Number(mm[1])] ?? 1 }]), rinfo.port, rinfo.address);
    if (m.address === '/meters') sock.send(encode('/meters/1', [{ t: 'b', v: encodeMeters(meters) }]), rinfo.port, rinfo.address);
  });
  await new Promise((r) => sock.bind(0, '127.0.0.1', r));
  return { sock, received, meters, port: sock.address().port, close: () => sock.close() };
}

test('OSC: Encode/Decode Rundlauf', () => {
  const m = decode(encode('/ch/01/mix/fader', [{ t: 'f', v: 0.75 }]));
  assert.equal(m.address, '/ch/01/mix/fader');
  assert.ok(Math.abs(m.args[0] - 0.75) < 1e-6);
  assert.equal(decode(encode('/xremote', [])).address, '/xremote');
});

test('Relay: Fader setzen, Mics/Pegel lesen, Auth', async () => {
  const x32 = await fakeX32();
  const relay = createRelay({ x32Host: '127.0.0.1', x32Port: x32.port, token: TOKEN, bind: '127.0.0.1', port: 0 });
  const port = await relay.start();
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/x32/state`)).status, 401);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    const bad = await fetch(`${base}/x32/level`, { method: 'POST', headers: auth, body: JSON.stringify({ player: 1, channels: [99], fader: 0.5 }) });
    assert.equal(bad.status, 400);
    const bad2 = await fetch(`${base}/x32/level`, { method: 'POST', headers: auth, body: JSON.stringify({ player: 1, channels: [1], fader: 3 }) });
    assert.equal(bad2.status, 400);

    const ok = await fetch(`${base}/x32/level`, { method: 'POST', headers: auth, body: JSON.stringify({ player: 1, channels: [1, 2], fader: 0.5 }) });
    assert.equal(ok.status, 200);
    await sleep(100);
    const faders = x32.received.filter((m) => /\/mix\/fader$/.test(m.address) && m.args.length);
    assert.deepEqual(faders.map((m) => m.address), ['/ch/01/mix/fader', '/ch/02/mix/fader']);
    assert.ok(Math.abs(faders[0].args[0] - 0.5) < 1e-3);
    assert.ok(x32.received.some((m) => m.address === '/xremote'));

    // Mic 1 (Kanal 5) spricht, Mic 2 (Kanal 6) ist gemutet, Player 1 hat Pegel
    x32.meters[4] = 0.4; x32.meters[5] = 0.4; x32.meters[0] = 0.6;
    await sleep(4300); // naechster Keepalive fordert Meter an
    const st = await (await fetch(`${base}/x32/state`, { headers: auth })).json();
    assert.equal(st.mics[0].open, true);
    assert.equal(st.mics[1].open, false, 'gemutetes Mic zaehlt nie als offen');
    assert.ok(st.meters[1] > 0.5);
    assert.equal(st.x32.ok, true);
  } finally { await relay.stop(); x32.close(); }
});

test('Relay verlangt einen starken Token', () => {
  assert.throws(() => createRelay({ x32Host: '1.2.3.4', token: 'kurz' }));
});

test('App-Adapter (HttpX32) spricht mit dem Relay', async () => {
  const { HttpX32, ampToFader } = await import('../src/adapters/x32.js');
  const { loadSettings, applyPatch } = await import('../src/settings.js');
  const { openDb } = await import('../src/db.js');
  const { config } = await import('../src/config.js');
  config.secret = 'test-secret-test-secret-test-secret-1234';
  openDb(':memory:'); loadSettings();
  const x32 = await fakeX32();
  const relay = createRelay({ x32Host: '127.0.0.1', x32Port: x32.port, token: TOKEN, bind: '127.0.0.1', port: 0 });
  const port = await relay.start();
  try {
    applyPatch({ x32: { adapter: 'http', piUrl: `http://127.0.0.1:${port}`, piToken: TOKEN } }, { allow: ['x32'] });
    const a = new HttpX32();
    await a.setPlayerLevel(2, 1); // 0 dB -> Fader 0.75 auf Kanaelen 3+4
    await sleep(100);
    const f = x32.received.filter((m) => /\/mix\/fader$/.test(m.address) && m.args.length);
    assert.deepEqual(f.map((m) => m.address), ['/ch/03/mix/fader', '/ch/04/mix/fader']);
    assert.ok(Math.abs(f[0].args[0] - ampToFader(1)) < 1e-3, "auf das 1024er-Raster gerundet");
    const s = await a.readState();
    assert.equal(s.mics.length, 3);
    assert.equal(a.health().ok, true);
  } finally { await relay.stop(); x32.close(); }
});

test('Relay: Kanalzuordnung kommt aus der App (POST /x32/config) und wird validiert', async () => {
  const { HttpX32 } = await import('../src/adapters/x32.js');
  const { loadSettings, applyPatch, settings } = await import('../src/settings.js');
  const { openDb } = await import('../src/db.js');
  const { config } = await import('../src/config.js');
  config.secret = 'test-secret-test-secret-test-secret-1234';
  openDb(':memory:'); loadSettings();
  const x32 = await fakeX32();
  const relay = createRelay({ x32Host: '127.0.0.1', x32Port: x32.port, token: TOKEN, bind: '127.0.0.1', port: 0 });
  const port = await relay.start();
  const base = `http://127.0.0.1:${port}`, auth = { Authorization: `Bearer ${TOKEN}` };
  try {
    assert.equal((await fetch(`${base}/x32/config`, { method: 'POST', headers: auth, body: JSON.stringify({ p1: [99] }) })).status, 400);
    assert.equal((await fetch(`${base}/x32/config`, { method: 'POST', body: '{}' })).status, 401);
    applyPatch({ x32: { adapter: 'http', piUrl: base, piToken: TOKEN, micNames: ['Moderator', '', 'DJ'], channels: { p1: [10], p2: [11, 12], mics: [20, 21, ''] } } }, { allow: ['x32'] });
    assert.deepEqual(settings().x32.channels.p1, [10]);
    assert.deepEqual(settings().x32.channels.mics, [20, 21]);
    assert.deepEqual(settings().x32.micNames, ['Moderator', 'Mic 2', 'DJ']);
    const a = new HttpX32();
    const st = await a.readState();
    assert.deepEqual(relay.cfg.mics, [20, 21]);
    assert.deepEqual(relay.cfg.players[2], [11, 12]);
    assert.equal(st.mics[0].name, 'Moderator');
    await a.setPlayerLevel(1, 1);
    await sleep(100);
    assert.deepEqual(x32.received.filter((m) => /\/mix\/fader$/.test(m.address) && m.args.length).map((m) => m.address), ['/ch/10/mix/fader']);
  } finally { await relay.stop(); x32.close(); }
});

test('App-Adapter: mehrere Pi-URLs, nimmt die erreichbare', async () => {
  const { HttpX32 } = await import('../src/adapters/x32.js');
  const { loadSettings, applyPatch } = await import('../src/settings.js');
  const { openDb } = await import('../src/db.js');
  const { config } = await import('../src/config.js');
  config.secret = 'test-secret-test-secret-test-secret-1234';
  openDb(':memory:'); loadSettings();
  const x32 = await fakeX32();
  const relay = createRelay({ x32Host: '127.0.0.1', x32Port: x32.port, token: TOKEN, bind: '127.0.0.1', port: 0 });
  const port = await relay.start();
  try {
    applyPatch({ x32: { adapter: 'http', piUrl: `http://127.0.0.1:9, http://127.0.0.1:${port}/`, piToken: TOKEN } }, { allow: ['x32'] });
    const a = new HttpX32();
    const s = await a.readState();
    assert.equal(s.mics.length, 3);
    assert.equal(a.idx, 1);
    assert.equal(a.health().ok, true);
  } finally { await relay.stop(); x32.close(); }
});

test('X32-Adresse aus dem Admin: nur lokales Netz, wird ans Relay gegeben, ueberlebt Neustart, Suche per /xinfo', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { HttpX32 } = await import('../src/adapters/x32.js');
  const { loadSettings, applyPatch, settings } = await import('../src/settings.js');
  const { openDb } = await import('../src/db.js');
  const { config } = await import('../src/config.js');
  config.secret = 'test-secret-test-secret-test-secret-1234';
  openDb(':memory:'); loadSettings();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const stateFile = path.join(dir, 'x32.json');
  const a32 = await fakeX32(), b32 = await fakeX32();
  // b32 antwortet auf /xinfo wie ein echtes Pult
  b32.sock.on('message', (msg, rinfo) => { if (decode(msg).address === '/xinfo') b32.sock.send(encode('/xinfo', [{ t: 's', v: '127.0.0.1' }, { t: 's', v: 'Aula-X32' }, { t: 's', v: 'X32' }, { t: 's', v: '4.06' }]), rinfo.port, rinfo.address); });
  let relay = createRelay({ x32Host: '127.0.0.1', x32Port: a32.port, token: TOKEN, bind: '127.0.0.1', port: 0, stateFile, discoverTargets: ['127.0.0.1'], discoverPort: b32.port });
  let port = await relay.start();
  try {
    // Einstellungen: nur IPv4 im lokalen Netz
    assert.throws(() => applyPatch({ x32: { host: '8.8.8.8' } }, { allow: ['x32'] }), /lokalen Netz/);
    assert.throws(() => applyPatch({ x32: { host: 'x32.local; rm -rf /' } }, { allow: ['x32'] }));
    const base = `http://127.0.0.1:${port}`, auth = { Authorization: `Bearer ${TOKEN}` };
    assert.equal((await fetch(`${base}/x32/config`, { method: 'POST', headers: auth, body: JSON.stringify({ host: '1.1.1.1' }) })).status, 400, 'Relay prueft selbst');
    assert.equal((await fetch(`${base}/x32/config`, { method: 'POST', headers: auth, body: JSON.stringify({ host: '192.168.1.5', port: 99999 }) })).status, 400);

    applyPatch({ x32: { adapter: 'http', piUrl: base, piToken: TOKEN, host: '127.0.0.1', port: b32.port } }, { allow: ['x32'] });
    const a = new HttpX32();
    await a.readState();
    assert.equal(relay.cfg.x32Port, b32.port); assert.equal(relay.cfg.hostSource, 'admin');
    await a.setPlayerLevel(1, 1);
    await sleep(100);
    assert.ok(b32.received.some((m) => /\/mix\/fader$/.test(m.address)), 'Fader geht ans neue Pult');
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { host: '127.0.0.1', port: b32.port });
    const st = await a.readState();
    assert.equal(a.desk.source, 'admin'); assert.equal(a.desk.port, b32.port); assert.ok(st);

    // Suche
    const found = await a.discover();
    assert.deepEqual(found.map((f) => [f.host, f.name, f.model, f.version]), [['127.0.0.1', 'Aula-X32', 'X32', '4.06']]);

    // Neustart des Relays: Adresse aus der Datei
    await relay.stop();
    relay = createRelay({ x32Host: '127.0.0.1', x32Port: a32.port, token: TOKEN, bind: '127.0.0.1', port: 0, stateFile });
    assert.equal(relay.cfg.x32Port, b32.port);
    port = await relay.start();
    // Zuruecksetzen: leer = .env-Wert, Datei weg
    applyPatch({ x32: { piUrl: `http://127.0.0.1:${port}`, host: '' } }, { allow: ['x32'] });
    await new HttpX32().readState();
    assert.equal(relay.cfg.x32Port, a32.port); assert.equal(relay.cfg.hostSource, 'pi');
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(settings().x32.host, '');
  } finally { await relay.stop(); a32.close(); b32.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Fader-Schonung: sanftes Anfahren, Hand hat Vorrang, Not-Aus sofort, App buendelt Befehle', async () => {
  const x32 = await fakeX32();
  let relayAddr = null;
  x32.sock.on('message', (msg, rinfo) => {
    relayAddr = rinfo;
    const m = decode(msg);
    if (/^\/ch\/\d\d\/mix\/fader$/.test(m.address) && !m.args.length) x32.sock.send(encode(m.address, [{ t: 'f', v: 0.2 }]), rinfo.port, rinfo.address);   // Stellung abfragen
  });
  const relay = createRelay({ x32Host: '127.0.0.1', x32Port: x32.port, token: TOKEN, bind: '127.0.0.1', port: 0, manualHoldMs: 600 });
  const port = await relay.start();
  const base = `http://127.0.0.1:${port}`, auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const sent = (ch) => x32.received.filter((m) => m.address === `/ch/0${ch}/mix/fader` && m.args.length).map((m) => m.args[0]);
  try {
    await sleep(150);
    assert.ok(Math.abs(relay.fad.cur[1] - 0.2) < 1e-6, 'Stellung beim Start abgefragt');
    await fetch(`${base}/x32/level`, { method: 'POST', headers: auth, body: JSON.stringify({ player: 1, channels: [1, 2], fader: 0.8, speed: 1.2 }) });
    await sleep(250);
    let v = sent(1);
    assert.ok(v.length >= 3 && v.at(-1) < 0.8, `faehrt noch (${v.at(-1)})`);
    for (let i = 1; i < v.length; i++) assert.ok(v[i] > v[i - 1] && v[i] - v[i - 1] <= 1.2 * 0.04 + 1e-6, 'kleine, gleichmaessige Schritte');
    await sleep(500);
    assert.ok(Math.abs(sent(1).at(-1) - 0.8) < 1e-3, 'Ziel erreicht');

    // Hand am Fader: Pult meldet von sich aus eine neue Stellung -> Relay haelt still, danach sanft zurueck
    x32.sock.send(encode('/ch/01/mix/fader', [{ t: 'f', v: 0.3 }]), relayAddr.port, relayAddr.address);
    await sleep(100);
    const n = sent(1).length;
    const st = await (await fetch(`${base}/x32/state`, { headers: auth })).json();
    assert.deepEqual(st.manual, [1]);
    const hm = st.hand.find((x) => x.ch === 1);
    assert.ok(hm && Math.abs(hm.v - 0.3) < 1e-6 && hm.seq >= 1 && hm.ageMs >= 0, 'Handbewegung mit Wert und Nummer gemeldet');
    await sleep(300);
    assert.equal(sent(1).length, n, 'waehrend der Handbewegung keine Befehle');
    await sleep(900);
    assert.equal(sent(1).length, n, 'auch danach kein Zurückfahren: die Hand-Stellung gilt');
    assert.ok(Math.abs(relay.fad.target[1] - 0.3) < 1e-6);
    // erst ein neuer Wert der App bewegt den Fader wieder – sanft von der Hand-Stellung aus
    await fetch(`${base}/x32/level`, { method: 'POST', headers: auth, body: JSON.stringify({ player: 1, channels: [1, 2], fader: 0.6, speed: 1.2 }) });
    await sleep(200);
    v = sent(1).slice(n);
    assert.ok(v.length && v[0] > 0.3 && v[0] < 0.4, 'fährt von der Hand-Stellung aus los');

    // Not-Aus: sofort auf 0
    await fetch(`${base}/x32/level`, { method: 'POST', headers: auth, body: JSON.stringify({ player: 1, channels: [1, 2], fader: 0, instant: true }) });
    await sleep(60);
    assert.equal(sent(2).at(-1), 0);

    // Kanalinfo und Anwaehlen
    const ch = await (await fetch(`${base}/x32/channels`, { headers: auth })).json();
    assert.equal(ch.channels.length, 32);
    assert.equal((await fetch(`${base}/x32/select`, { method: 'POST', headers: auth, body: '{"channel":5}' })).status, 200);
    await sleep(50);
    assert.ok(x32.received.some((m) => m.address === '/-stat/selidx' && m.args[0] === 4));
    assert.equal((await fetch(`${base}/x32/select`, { method: 'POST', headers: auth, body: '{"channel":40}' })).status, 400);

    // App: viele Werte schnell hintereinander -> wenige Anfragen, letzter Wert kommt an, Reihenfolge stimmt
    const { HttpX32 } = await import('../src/adapters/x32.js');
    const { loadSettings, applyPatch } = await import('../src/settings.js');
    const { openDb } = await import('../src/db.js');
    const { config } = await import('../src/config.js');
    config.secret = 'test-secret-test-secret-test-secret-1234';
    openDb(':memory:'); loadSettings();
    applyPatch({ x32: { adapter: 'http', piUrl: base, piToken: TOKEN, faderSpeed: 'schnell' } }, { allow: ['x32'] });
    const realFetch = globalThis.fetch; let posts = 0;
    globalThis.fetch = (url, o) => { if (String(url).endsWith('/x32/level')) posts++; return realFetch(url, o); };
    try {
      const a = new HttpX32();
      const all = [];
      for (let i = 1; i <= 20; i++) { all.push(a.setPlayerLevel(2, i / 20).catch(() => {})); await sleep(10); }
      await Promise.all(all); await a.q[2].run;
      assert.ok(posts <= 5, `gebuendelt: ${posts} Anfragen statt 20`);
      await sleep(400);
      const { ampToFader } = await import('../src/adapters/x32.js');
      assert.ok(Math.abs(relay.fad.target[3] - ampToFader(1)) < 1e-3, 'letzter Wert gilt');
    } finally { globalThis.fetch = realFetch; }
  } finally { await relay.stop(); x32.close(); }
});
