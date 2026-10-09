import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, Client } from './helpers.js';
import { config } from '../src/config.js';
import { genKeys, parseConf, nextIp, peerBlock, addPeer, removePeer, clientConf, parseDump, NAME_RE } from '../wgctl/lib.js';

const SAMPLE = `[Interface]
Address = 10.8.0.1
ListenPort = 51820
PrivateKey = SERVERKEY
PostUp = iptables -A FORWARD -i wg0 -j ACCEPT

[Peer]
# peer_pi
PublicKey = PIPUB
PresharedKey = PIPSK
AllowedIPs = 10.8.0.2/32, 10.8.0.192/26

[Peer]
# peer_pc
PublicKey = PCPUB
PresharedKey = PCPSK
AllowedIPs = 10.8.0.3/32
`;

test('wgctl: Konfiguration lesen, Adresse vergeben, Peer anlegen und entfernen', () => {
  const c = parseConf(SAMPLE);
  assert.deepEqual(c.peers.map((p) => p.name), ['pi', 'pc']);
  assert.deepEqual(c.peers[0].allowedIps, ['10.8.0.2/32', '10.8.0.192/26']);
  assert.equal(nextIp(SAMPLE), '10.8.0.4');
  const k = genKeys();
  assert.equal(Buffer.from(k.pub, 'base64').length, 32); assert.equal(Buffer.from(k.priv, 'base64').length, 32);
  const withNew = addPeer(SAMPLE, peerBlock({ name: 'handy', pub: k.pub, psk: k.psk, ips: ['10.8.0.4/32'] }));
  const c2 = parseConf(withNew);
  assert.deepEqual(c2.peers.map((p) => p.name), ['pi', 'pc', 'handy']);
  assert.equal(nextIp(withNew), '10.8.0.5');
  const back = removePeer(withNew, k.pub);
  assert.deepEqual(parseConf(back).peers.map((p) => p.name), ['pi', 'pc']);
  assert.ok(back.includes('PostUp = iptables'));
  assert.equal(removePeer(SAMPLE, 'gibtsnicht'), null);
  const cc = clientConf({ ip: '10.8.0.4', priv: k.priv, serverPub: 'SPUB', psk: k.psk, endpoint: 'wg.example.de:51820' });
  assert.match(cc, /Address = 10\.8\.0\.4\/32/); assert.match(cc, /AllowedIPs = 10\.8\.0\.0\/24/); assert.match(cc, /PersistentKeepalive = 25/);
  assert.ok(NAME_RE.test('laptop-anna')); assert.ok(!NAME_RE.test('../etc')); assert.ok(!NAME_RE.test('A'));
  const d = parseDump('priv\tpub\t51820\toff\nPIPUB\tpsk\t1.2.3.4:5555\t10.8.0.2/32\t1700000000\t100\t200\t25\n');
  assert.equal(d[0].handshake, 1700000000); assert.equal(d[0].rx, 100);
});

test('VPN-Verwaltung in der App: nur Head-Admin, reicht an wgctl weiter, Audit', async () => {
  const calls = [];
  const fake = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify({ server: { endpoint: 'wg.example.de:51820' }, peers: [{ name: 'pi', ip: '10.8.0.2', online: true, allowedIps: ['10.8.0.2/32'], handshakeAgoSec: 5, rx: 1, tx: 2, hasConfig: true }] }));
    if (req.url === '/peers' && req.method === 'POST') return res.end(JSON.stringify({ name: 'handy', ip: '10.8.0.4', config: '[Interface]\n' }));
    res.statusCode = 404; res.end('{"error":"nope"}');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const mod = new Client(ctx.base);
    await mod.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'mod', label: 'M' })).json.code });
    assert.equal((await mod.get('/api/admin/vpn')).status, 403);
    assert.equal((await new Client(ctx.base).get('/api/admin/vpn')).status, 401);
    // ohne Token: nicht eingerichtet
    config.wgctlToken = ''; config.wgctlUrl = `http://127.0.0.1:${fake.address().port}`;
    assert.equal((await admin.get('/api/admin/vpn')).status, 503);
    config.wgctlToken = 'geheimes-wgctl-token-1234';
    const st = await admin.get('/api/admin/vpn');
    assert.equal(st.status, 200); assert.equal(st.json.peers[0].name, 'pi');
    const add = await admin.post('/api/admin/vpn/peers', { name: 'handy' });
    assert.equal(add.json.ip, '10.8.0.4');
    assert.ok(calls.every((c) => c.endsWith('Bearer geheimes-wgctl-token-1234')));
    assert.equal((await admin.get('/api/admin/vpn/peers/pi/config')).status, 404); // Fehler wird sauber durchgereicht
    assert.ok((await admin.get('/api/admin/security')).json.audit.some((a) => a.kind === 'vpn.peer.add'));
    // Funktion ausschalten
    await admin.post('/api/admin/settings', { features: { vpnAdmin: false } });
    assert.equal((await admin.get('/api/admin/vpn')).status, 404);
  } finally { await ctx.close(); fake.close(); config.wgctlToken = ''; }
});
