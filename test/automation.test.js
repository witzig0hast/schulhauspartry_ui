import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp, Client } from './helpers.js';
import * as rq from '../src/requests.js';
import { applyAutoOrder, currentPhase, localHHMM } from '../src/autoorder.js';
import { maybeFill } from '../src/filler.js';
import { applyPatch } from '../src/settings.js';

let ctx, admin, mod, tech, display, engine, tmp;
const PW = 'super-geheimes-passwort-123';
const login = async (role, label) => { const c = new Client(ctx.base); const code = (await admin.post('/api/admin/accounts', { role, label })).json.code; await c.post('/api/login', { secret: code }); return c; };
const guest = async () => { const g = new Client(ctx.base); await g.get('/api/guest/state'); return g; };
const wish = async (g, q) => (await g.post('/api/guest/request', { trackId: (await g.get(`/api/guest/search?q=${encodeURIComponent(q)}`)).json.tracks[0].id })).json;
const pendingOf = async (title) => (await mod.get('/api/state')).json.pending.find((p) => p.title === title);
const approve = async (title) => { const p = await pendingOf(title); await mod.post('/api/mod/decide', { id: p.id, action: 'approve' }); return p.id; };

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'party-test-'));
  ctx = await startTestApp({ dataDir: tmp });
  engine = ctx.engines.live;
  admin = new Client(ctx.base); await admin.post('/api/login', { secret: PW });
  await admin.post('/api/admin/settings', { limit: { count: 100, windowMin: 15 } });
  mod = await login('mod', 'Lisa'); tech = await login('tech', 'FOH'); display = await login('display', 'Anzeige');
});
test.after(async () => { await ctx.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Spaeter: Wunsch zurueckstellen, spaeter annehmen', async () => {
  const g = await guest();
  await wish(g, 'blinding');
  const p = await pendingOf('Blinding Lights');
  assert.equal((await mod.post('/api/mod/decide', { id: p.id, action: 'later' })).status, 200);
  let st = (await mod.get('/api/state')).json;
  assert.equal(st.pending.length, 0); assert.equal(st.later.length, 1); assert.equal(st.counts.later, 1);
  assert.equal((await g.get('/api/guest/state')).json.requests[0].status, 'pending', 'Gast sieht weiter "wartet"');
  assert.equal((await mod.post('/api/mod/decide', { id: p.id, action: 'approve' })).status, 200);
  st = (await mod.get('/api/state')).json;
  assert.equal(st.later.length, 0); assert.equal(st.upcoming.length, 1);
});

test('Chat: Name ist Pflicht, Nachrichten gehen an alle Mitarbeitenden', async () => {
  assert.equal((await mod.post('/api/chat', { name: '', text: 'hi' })).status, 400);
  assert.equal((await mod.post('/api/chat', { name: 'Lisa', text: '   ' })).status, 400);
  assert.equal((await mod.post('/api/chat', { name: 'Lisa', text: 'Bitte den nächsten Song ruhiger' })).status, 200);
  assert.equal((await display.post('/api/chat', { name: 'x', text: 'y' })).status, 403);
  const st = (await tech.get('/api/state')).json;
  assert.equal(st.chat.at(-1).name, 'Lisa'); assert.match(st.chat.at(-1).text, /ruhiger/);
  assert.equal((await display.get('/api/state')).json.chat, undefined, 'Anzeige sieht den Chat nicht');
});

test('Weiche Sperre: wer bearbeitet gerade, und wer ist online', async () => {
  const st0 = (await mod.get('/api/state')).json;
  const id = st0.upcoming[0].id;
  assert.equal((await mod.post('/api/mod/claim', { id })).status, 200);
  const st = (await tech.get('/api/state')).json;
  assert.ok(st.claims.some((c) => c.id === id && c.label === 'Lisa'));
  await mod.post('/api/mod/claim/release', { id });
  assert.equal((await tech.get('/api/state')).json.claims.length, 0);
});

test('Auto-Ordnung: Genre-Balance bricht lange Serien gleicher Genres auf', async () => {
  rq.resetEnv('live'); engine.resetAll();
  const g = await guest();
  const pops = ['Shape of You', 'Dance Monkey', 'Watermelon Sugar', 'As It Was', 'Flowers'];
  for (const q of ['shape of', 'dance monkey', 'watermelon', 'as it was', 'flowers', 'lose yourself']) await wish(g, q); // fuenf reine Pop-Songs, dann ein Hip-Hop-Song
  for (const t of [...pops, 'Lose Yourself']) await approve(t);
  const titles = () => rq.upcoming('live').map((u) => u.title);
  // ohne Automatik laege Hip-Hop auf Platz 6; mit Balance (max. 2 Pop am Stueck) rueckt er auf Platz 3
  const idx = titles().indexOf('Lose Yourself');
  assert.equal(idx, 2, `Hip-Hop auf Platz ${idx + 1}: ${titles().join(' | ')}`);
  assert.deepEqual(titles().filter((t) => t !== 'Lose Yourself'), pops, 'Eingangsreihenfolge der anderen bleibt erhalten');
});

test('Auto-Ordnung: Stimmungskurve zieht passende Songs vor, Prioritaet bleibt', async () => {
  rq.resetEnv('live'); engine.resetAll();
  const hhmm = localHHMM(new Date());
  applyPatch({ autoOrder: { enabled: true, mood: true, maxRepeat: 5, phases: [{ name: 'Hip-Hop-Phase', from: '00:00', to: '23:59', prefer: ['Hip-Hop & Rap'] }] } }, { allow: ['autoOrder'] });
  assert.equal(currentPhase(new Date())?.name, 'Hip-Hop-Phase', hhmm);
  const g = await guest();
  for (const q of ['levitating', 'shape of', 'lose yourself']) await wish(g, q);
  for (const t of ['Levitating', 'Shape of You', 'Lose Yourself']) await approve(t);
  assert.equal(rq.upcoming('live')[0].title, 'Lose Yourself', 'passt zur Phase -> vorne');
  // priorisierter Song bleibt exakt dort, wo er ist
  const shape = rq.upcoming('live').find((u) => u.title === 'Shape of You');
  await mod.post('/api/mod/prioritize', { id: shape.id });
  const before = rq.upcoming('live').map((u) => u.title);
  applyAutoOrder('live', engine.current);
  assert.deepEqual(rq.upcoming('live').map((u) => u.title).indexOf('Shape of You'), before.indexOf('Shape of You'));
  applyPatch({ autoOrder: { phases: [] } }, { allow: ['autoOrder'] });
});

test('Luckenfueller: fuellt nur bei laufender Musik und leerer Queue, ohne Wiederholungen', async () => {
  rq.resetEnv('live'); engine.resetAll();
  applyPatch({ filler: { enabled: true, playlist: 'spotify:playlist:' + 'a'.repeat(22), minQueue: 1, avoidMin: 60 } }, { allow: ['filler'] });
  assert.equal(await maybeFill(engine, Date.now()), null, 'nichts laeuft -> nichts einreihen');
  const g = await guest(); await wish(g, 'levitating'); await approve('Levitating');
  const cf = await tech.post('/api/control/crossfade', { sec: 0.2 });
  assert.equal(cf.status, 200, JSON.stringify(cf.json));
  await new Promise((r) => setTimeout(r, 300)); await engine.tick();
  assert.ok(engine.current && engine.players[engine.current].status().playing, `current=${engine.current}`);
  await new Promise((r) => setTimeout(r, 50)); // der Takt der Engine reiht den Fueller selbst ein
  engine.lastFill = 0;
  const added = rq.upcoming('live').find((u) => u.deviceId === 'auto') || await maybeFill(engine, Date.now());
  assert.ok(added, 'Fueller eingereiht');
  assert.equal(added.deviceId, 'auto');
  assert.notEqual(added.title, 'Levitating', 'kein Song, der gerade lief');
  assert.equal(await maybeFill(engine, Date.now() + 25000), null, 'Queue nicht mehr leer');
  assert.equal(rq.upcoming('live').filter((u) => u.deviceId === 'auto').length, 1, 'nur ein Fueller');
  const st = (await mod.get('/api/state')).json;
  assert.equal(st.upcoming.find((u) => u.id === added.id).auto, true);
  applyPatch({ filler: { enabled: false } }, { allow: ['filler'] });
});

test('Smart-Outro: Crossfade startet am Songausklang, wenn bekannt', async () => {
  rq.resetEnv('live'); engine.resetAll();
  applyPatch({ auto: { enabled: true, crossfadeSec: 0.5, smartOutro: true, startBeforeEndSec: { 1: 60, 2: 60 } } }, { allow: ['auto'] });
  const g = await guest(); await wish(g, 'levitating'); await wish(g, 'uptown');
  await approve('Levitating'); await approve('Uptown Funk');
  await tech.post('/api/control/crossfade', { sec: 0.2 });
  await new Promise((r) => setTimeout(r, 300));
  const cur = engine.current;
  const meta = (await import('../src/trackmeta.js')).getMeta(engine.trackIdOf[cur]);
  assert.ok(meta?.outro_ms, 'Outro-Zeit geladen (Mock-Analyse)');
  const dur = engine.players[cur].status().durationMs;
  // 30 s vor Ende: bei fester Vorlaufzeit 60 s waere der Wechsel laengst passiert; Smart wartet auf den Ausklang (10-24 s)
  engine.players[cur].seekTo(dur - 40000);
  await engine.tick();
  assert.equal(engine.crossfade, null, 'noch kein Wechsel, Song klingt noch nicht aus');
  engine.players[cur].seekTo(dur - 8000);
  await engine.tick();
  assert.ok(engine.crossfade, 'jetzt (Ausklang) startet der Uebergang');
  applyPatch({ auto: { enabled: false } }, { allow: ['auto'] });
});

test('Notfall-Playlist: startet auf dem gewaehlten Player, Not-Aus hebt sie auf', async () => {
  rq.resetEnv('live'); engine.resetAll();
  applyPatch({ emergency: { playlist: '', player: 2, shuffle: true } }, { allow: ['emergency'] });
  assert.equal((await tech.post('/api/control/emergency')).status, 200); // Mock braucht keine echte Playlist
  const st = (await tech.get('/api/state')).json;
  assert.equal(st.emergency, true);
  assert.equal(engine.players[2].status().title, 'Notfall-Playlist');
  assert.equal(engine.current, 2);
  assert.equal((await mod.post('/api/control/emergency')).status, 403);
  await tech.post('/api/control/emergency-clear');
  assert.equal((await tech.get('/api/state')).json.emergency, false);
});

test('Benachrichtigung (ntfy): JSON-Publish, Test, Alarm nach Ausfall und Entwarnung', async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end('{}'); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await admin.post('/api/admin/notify/test')).status, 400, 'ohne Topic kein Versand');
    await admin.post('/api/admin/settings', { notify: { enabled: true, url, topic: 'party-test', token: 'tk_secret', downSec: 5 } });
    assert.equal((await admin.post('/api/admin/notify/test')).status, 200);
    assert.equal(got.at(-1).body.topic, 'party-test'); assert.equal(got.at(-1).auth, 'Bearer tk_secret');
    assert.equal((await admin.get('/api/admin/settings')).json.settings.notify.token, '***', 'Token nie im Klartext');
    // Not-Aus -> sofortiger Alarm mit hoher Prioritaet
    const arm = await tech.post('/api/control/panic-arm');
    await tech.post('/api/control/panic', { nonce: arm.json.nonce });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(got.some((g) => /NOT-AUS/.test(g.body.title) && g.body.priority === 5));
    await tech.post('/api/control/panic-clear');
    // Ausfall: Spotify "kaputt" melden -> erst nach downSec ein Alarm, dann Entwarnung
    const mon = ctx.monitor; engine.realConnections = true;
    const origHealth = engine.spotify.health.bind(engine.spotify);
    engine.spotify.health = () => ({ ok: false, detail: 'Spotify-Test-Ausfall' });
    await mon.tick();
    const n0 = got.length;
    mon.state.get('live:spotify').since -= 6000; // Stoerung dauert schon > downSec
    await mon.tick();
    assert.ok(got.length > n0 && got.at(-1).body.message.includes('Spotify-Test-Ausfall'));
    const n1 = got.length;
    await mon.tick(); assert.equal(got.length, n1, 'kein zweiter Alarm fuer dieselbe Stoerung');
    engine.spotify.health = origHealth; engine.realConnections = false;
    engine.spotify.health = () => ({ ok: true, detail: 'ok' }); engine.realConnections = true;
    await mon.tick();
    assert.match(got.at(-1).body.title, /Wieder/);
  } finally { engine.realConnections = false; srv.close(); await admin.post('/api/admin/settings', { notify: { enabled: false } }); }
});

test('Backups: automatisch/manuell, Download nur Admin, vor dem Reset', async () => {
  assert.equal((await admin.post('/api/admin/backups')).status, 200);
  const list = (await admin.get('/api/admin/backups')).json.backups;
  assert.ok(list.length >= 1 && /^party-\d{8}-\d{6}/.test(list[0].name));
  const dl = await admin.get(`/api/admin/backups/${list[0].name}`);
  assert.equal(dl.status, 200);
  assert.equal((await admin.get('/api/admin/backups/..%2Fsecret.db')).status, 404, 'kein Pfad-Trick');
  assert.equal((await tech.get('/api/admin/backups')).status, 403);
  const n = list.length;
  await admin.post('/api/admin/reset', { env: 'live', confirm: 'ZURÜCKSETZEN' });
  assert.ok((await admin.get('/api/admin/backups')).json.backups.length > n, 'Sicherung vor dem Reset');
});

test('Vorbereitung: Checkliste, Testaktionen, nur Technik/Admin', async () => {
  rq.resetEnv('live'); engine.resetAll();
  assert.equal((await mod.get('/api/prep/status')).status, 403);
  const s = (await tech.get('/api/prep/status')).json;
  const byId = Object.fromEntries(s.checks.map((c) => [c.id, c]));
  for (const id of ['codes', 'backup', 'notify', 'player1', 'x32', 'testrun', 'livedata', 'emergency', 'wish']) assert.ok(byId[id], id);
  assert.equal(byId.codes.status, 'ok');
  assert.equal(byId.x32.status, 'info', 'ohne Pi: simuliert');
  assert.equal((await tech.post('/api/prep/action', { id: 'fader-test' })).status, 200);
  assert.equal((await tech.post('/api/prep/action', { id: 'backup-now' })).status, 200);
  assert.equal((await tech.post('/api/prep/action', { id: 'nope' })).status, 400);
  assert.equal((await tech.post('/api/prep/action', { id: 'player-test:1' })).status, 200);
  assert.equal((await tech.get('/prep')).status, 200);
  assert.equal((await mod.get('/prep')).status, 403);
});

test('Design: Name, Farbe, Logo (nur echte Bilder), CSS, PDF-Export', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = (buf, type = 'image/png') => fetch(`${ctx.base}/api/admin/brand/logo`, { method: 'POST', headers: { 'Content-Type': type, Cookie: Object.entries(admin.cookies).map(([k, v]) => `${k}=${v}`).join('; ') }, body: buf });
  assert.equal((await up(Buffer.from('<html><script>alert(1)</script>'))).status, 400, 'kein Bild');
  assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml')).status, 400, 'SVG mit Skript');
  assert.equal((await up(png)).status, 200);
  const logo = await fetch(`${ctx.base}/brand/logo`);
  assert.equal(logo.status, 200); assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.match(logo.headers.get('content-security-policy'), /sandbox/);
  await admin.post('/api/admin/settings', { brand: { name: 'Gymnasium <b>Fest</b>', tagline: 'Sommerparty', accent: '#e11d48' } });
  const html = (await new Client(ctx.base).get('/')).text;
  assert.ok(html.includes('data-brand-name="Gymnasium &lt;b&gt;Fest&lt;/b&gt;"'), 'Name HTML-escaped');
  assert.match(html, /data-brand-logo="\/brand\/logo\?v=\d+"/);
  const css = await (await fetch(`${ctx.base}/brand.css`)).text();
  assert.match(css, /--ink:#e11d48/); assert.match(css, /prefers-color-scheme: dark/);
  assert.equal((await admin.post('/api/admin/settings', { brand: { accent: 'rot' } })).status, 200);
  assert.match(await (await fetch(`${ctx.base}/brand.css`)).text(), /keine eigene Farbe/, 'ungueltige Farbe wird verworfen');
  // PDF
  const pdf = await fetch(`${ctx.base}/api/admin/setlist.pdf?env=live`, { headers: { Cookie: Object.entries(admin.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await new Client(ctx.base).get('/api/admin/setlist.pdf')).status, 401);
});
