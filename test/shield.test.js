import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startTestApp, Client } from './helpers.js';
import { shield } from '../src/shield.js';
import { clientIp, isPrivateIp } from '../src/security.js';
import { config } from '../src/config.js';

const PW = 'super-geheimes-passwort-123';
const setup = async () => {
  shield.reset();
  const ctx = await startTestApp();
  const admin = new Client(ctx.base); await admin.post('/api/login', { secret: PW });
  const tune = (o) => admin.post('/api/admin/settings', { security: { shield: o } });
  return { ctx, admin, tune };
};
const many = async (n, fn) => { const out = []; for (let i = 0; i < n; i++) out.push(await fn(i)); return out; };

test('Absender-Adresse laesst sich nicht faelschen', () => {
  const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });
  const old = config.trustCloudflare;
  config.trustCloudflare = true;
  try {
    assert.equal(clientIp(req('203.0.113.9', { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' })), '203.0.113.9');      // direkt aus dem Internet: Header zaehlen nicht
    assert.equal(clientIp(req('172.18.0.5', { 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');                                   // ueber den Proxy: Cloudflare-Header
    config.trustCloudflare = false;
    assert.equal(clientIp(req('::ffff:10.0.0.2', { 'x-forwarded-for': '9.9.9.9, 198.51.100.8, 10.0.0.1' })), '198.51.100.8');          // von rechts: erste oeffentliche Adresse
    assert.equal(clientIp(req('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' })), '203.0.113.9');
    assert.ok(isPrivateIp('192.168.178.5') && isPrivateIp('::1') && !isPrivateIp('8.8.8.8'));
  } finally { config.trustCloudflare = old; }
});

test('Limits pro Adresse (Dateien, Gaeste-API), Healthcheck bleibt frei, Fehler ohne Details', async () => {
  const { ctx, admin, tune } = await setup();
  try {
    await tune({ assetPerMin: 30, guestPerMin: 30, banStrikes: 5000 });
    const c = new Client(ctx.base);
    const codes = (await many(60, () => c.get('/assets/theme-init.js'))).map((r) => r.status);
    assert.ok(codes.includes(429), 'Dateien werden irgendwann abgewiesen');
    assert.ok(codes.filter((x) => x === 200).length >= 25);
    assert.equal((await c.get('/healthz')).status, 200);                                  // Ueberwachung nie blockieren
    const g = await many(60, () => c.get('/api/guest/state'));
    assert.ok(g.some((r) => r.status === 429));
    assert.ok(g.find((r) => r.status === 429).headers.get('retry-after'));
    shield.reset();
    // kaputtes JSON: knappe Antwort, kein Stacktrace
    const bad = await fetch(`${ctx.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{kaputt' });
    assert.equal(bad.status, 400); assert.deepEqual(await bad.json(), { error: 'Ungültige Anfrage.' });
    void admin;
  } finally { await ctx.close(); shield.reset(); }
});

test('Pro Geraet, neue Geraete und Wuensche pro Adresse sind begrenzt', async () => {
  const { ctx, tune } = await setup();
  try {
    await tune({ devicePerMin: 20, newDevicesPerMin: 5, wishesPerIp: 5, guestPerMin: 5000 });
    // ein Geraet, zu viele Anfragen
    const g = new Client(ctx.base); await g.get('/api/guest/state');
    assert.ok((await many(40, () => g.get('/api/guest/state'))).some((r) => r.status === 429));
    shield.reset();
    // Cookie wegwerfen und neu anfangen: nur wenige neue Geraete pro Adresse
    const st = (await many(10, async () => (await new Client(ctx.base).get('/api/guest/state')).status));
    assert.equal(st.filter((s) => s === 200).length, 5); assert.ok(st.includes(429));
    shield.reset();
    // Wuensche pro Adresse (auch mit immer neuem Geraet)
    await tune({ newDevicesPerMin: 300 });
    const res = await many(8, async (i) => { const d = new Client(ctx.base); await d.get('/api/guest/state'); const t = (await d.get(`/api/guest/search?q=${['blinding', 'levitating', 'sunflower', 'uptown', 'havana', 'believer', 'shape', 'closer'][i]}`)).json?.tracks?.[0]; return t ? (await d.post('/api/guest/request', { trackId: t.id })).status : 0; });
    assert.ok(res.filter((s) => s === 200).length <= 5, JSON.stringify(res));
    assert.ok(res.includes(429), JSON.stringify(res));
    assert.equal(shield.pendingFull(10), false); assert.equal(shield.pendingFull(400), true);
  } finally { await ctx.close(); shield.reset(); }
});

test('Dauerfeuer fuehrt zur Sperre; Team mit Anmeldung bleibt bedienbar und kann entsperren', async () => {
  const { ctx, admin, tune } = await setup();
  try {
    await tune({ assetPerMin: 30, banStrikes: 20, banMin: 5 });
    const bot = new Client(ctx.base);
    await many(120, () => bot.get('/assets/theme-init.js'));
    assert.equal((await bot.get('/')).status, 429);                                          // Seite gesperrt
    assert.equal((await bot.get('/api/guest/state')).status, 429);
    const st = (await admin.get('/api/admin/shield')).json;                                  // Admin (angemeldet) kommt durch
    assert.ok(st.bans.length === 1 && st.blocked.total > 20 && st.offenders[0].n > 0);
    assert.equal((await admin.post('/api/admin/shield/unban', { ip: st.bans[0].ip })).json.ok, true);
    assert.equal((await new Client(ctx.base).get('/')).status, 200);
    // nur Admin
    const mod = new Client(ctx.base); await mod.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'mod', label: 'M' })).json.code });
    assert.equal((await mod.get('/api/admin/shield')).status, 403);
    // Angriffsmodus: Grenzen auf 20 %
    await tune({ attackMode: true });
    assert.equal((await admin.get('/api/admin/shield')).json.cfg.attackMode, true);
  } finally { await ctx.close(); shield.reset(); }
});

test('Live-Verbindungen: ohne Cookie abgewiesen, pro Adresse begrenzt, Nachrichtenflut beendet', async () => {
  const { ctx, tune } = await setup();
  try {
    await tune({ wsPerIp: 5 });
    const url = ctx.base.replace('http', 'ws') + '/ws';
    const open = (headers) => new Promise((resolve) => { const w = new WebSocket(url, { headers }); w.on('open', () => resolve(w)); w.on('error', () => resolve(null)); w.on('unexpected-response', () => { resolve(null); w.terminate(); }); w.on('close', () => resolve(null)); });
    assert.equal(await open({}), null);                                                      // ohne Geraete-Cookie keine Verbindung
    const g = new Client(ctx.base); await g.get('/api/guest/state');
    const cookie = Object.entries(g.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const socks = [];
    for (let i = 0; i < 4; i++) { const d = new Client(ctx.base); await d.get('/api/guest/state'); socks.push(await open({ Cookie: Object.entries(d.cookies).map(([k, v]) => `${k}=${v}`).join('; ') })); }
    const fifth = await open({ Cookie: cookie }); socks.push(fifth);
    assert.ok(fifth, 'fuenfte Verbindung ok');
    const sixth = await open({ Cookie: cookie });
    assert.equal(sixth, null, 'sechste Verbindung von derselben Adresse wird abgewiesen');
    // Nachrichtenflut: Verbindung wird beendet
    const closed = new Promise((r) => fifth.on('close', (code) => r(code)));
    for (let i = 0; i < 45; i++) fifth.send(JSON.stringify({ type: 'ping', ts: i }));
    assert.equal(await closed, 1008);
    socks.forEach((s) => s?.terminate());
  } finally { await ctx.close(); shield.reset(); }
});
