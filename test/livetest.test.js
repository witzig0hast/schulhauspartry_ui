import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startTestApp, Client } from './helpers.js';
import { settings } from '../src/settings.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 20000, what = 'Bedingung') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Zeitüberschreitung: ${what}`);
    await sleep(150);
  }
}

test('Live-Test: spielt alle Schritte durch (simuliert), mit echtem Gast-Wunsch und Beamer, und stellt danach zurueck', async () => {
  const ctx = await startTestApp();
  let ws;
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    let r = await admin.post('/api/admin/livetest/start', {});
    assert.equal(r.status, 400); assert.match(r.json.error, /Testmodus/);
    await admin.post('/api/admin/settings', { test: { enabled: true }, auto: { enabled: true, crossfadeSec: 2 }, ducking: { enabled: true, db: -12 } });
    for (const e of Object.values(ctx.engines)) e.start();
    const tech = new Client(ctx.base); await tech.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'tech', label: 'T' })).json.code });
    assert.equal((await tech.post('/api/admin/livetest/start', {})).status, 403, 'nur Admin');

    r = await admin.post('/api/admin/livetest/start', { resetAfter: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.running, true); assert.equal(r.json.run.simulated, true);
    assert.equal(settings().test.realEnv, 'test', 'Testmodus bekommt waehrenddessen die echten Verbindungen');
    assert.equal((await admin.post('/api/admin/livetest/start', {})).status, 400, 'nicht doppelt');
    assert.equal((await admin.post('/api/admin/rehearsal/start', {})).status, 400, 'keine Generalprobe gleichzeitig');

    const status = async () => (await admin.get('/api/admin/livetest')).json;
    const answer = async (step, value) => {
      await waitFor(async () => (await status()).pending === step, 30000, `Schritt ${step} wartet`);
      const out = await admin.post('/api/admin/livetest/answer', { step, value });
      assert.equal(out.status, 200, JSON.stringify(out.json));
    };
    assert.equal((await admin.post('/api/admin/livetest/answer', { step: 'mics', value: 'yes' })).status, 400, 'nur der wartende Schritt');

    await answer('levels', 'done');
    // Wunsch ueber die echte Gaeste-Seite des Testmodus
    await waitFor(async () => (await status()).pending === 'wish', 40000, 'Wunsch-Schritt');
    const prefix = settings().test.prefix;
    const guest = new Client(ctx.base, `/${prefix}`);
    await guest.get('/');
    const tracks = (await guest.get('/api/guest/search?q=dua')).json.tracks;
    assert.ok(tracks.length);
    const w = await guest.post('/api/guest/request', { trackId: tracks[0].id });
    assert.equal(w.status, 200, JSON.stringify(w.json));
    await answer('approve', 'auto');
    // Beamer meldet sich ueber die Live-Verbindung
    await waitFor(async () => (await status()).pending === 'beamer', 10000, 'Beamer-Schritt');
    ws = new WebSocket(`${ctx.base.replace('http', 'ws')}/${prefix}/ws`, { headers: { Cookie: Object.entries(guest.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'hello', view: 'beamer' }));
    await waitFor(async () => (await status()).run?.steps.find((s) => s.id === 'beamer').question, 10000, 'Beamer-Frage');
    await answer('beamer', 'yes');

    const end = await waitFor(async () => { const s = await status(); return !s.running && s; }, 90000, 'Ende des Live-Tests');
    const by = Object.fromEntries(end.last.steps.map((s) => [s.id, s]));
    const bad = end.last.steps.filter((s) => s.status === 'fail');
    assert.equal(bad.length, 0, JSON.stringify(bad.map((s) => [s.id, s.detail, s.checks])));
    assert.equal(by.wish.status, 'ok', 'Wunsch vom (simulierten) Handy erkannt');
    assert.equal(by.approve.status, 'warn', 'automatisch angenommen = Hinweis');
    assert.equal(by.beamer.status, 'ok');
    for (const id of ['player1', 'player2', 'fader', 'crossfade', 'autofade', 'mics', 'panic', 'emergency']) assert.equal(by[id].status, 'ok', `${id}: ${by[id].detail} ${JSON.stringify(by[id].checks)}`);
    assert.ok(by.autofade.checks.some((c) => /von selbst/.test(c.label) && c.ok));
    assert.ok(by.mics.checks.some((c) => /Ducking/.test(c.label) && c.ok));
    assert.equal(by.connections.status, 'warn', 'simuliert = Hinweis');
    assert.equal(end.last.verdict, 'Bereit mit Hinweisen');
    // aufgeraeumt
    assert.equal(settings().test.realEnv, 'live', 'echte Verbindungen wieder bei Live');
    assert.equal(ctx.engines.test.liveTest, null);
    assert.ok(![1, 2].some((n) => ctx.engines.test.players[n].status().playing), 'Musik aus');
    assert.equal(ctx.engines.test.state.panic, false);
    assert.equal(ctx.engines.test.snapshot().counts.approved, 0, 'Testdaten geleert');
    assert.equal((await admin.get('/api/state')).json.counts.pending, 0, 'Live unberuehrt');
    // Ergebnis in der Vorbereitung
    const prep = (await admin.get('/api/prep/status')).json.checks.find((c) => c.id === 'livetest');
    assert.match(prep.detail, /Bereit mit Hinweisen/);
  } finally { ws?.close(); await ctx.close(); }
});

test('Live-Test: Abbrechen blendet aus und stellt die echten Verbindungen zurueck; Schritte abwaehlen und ueberspringen', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { test: { enabled: true } });
    for (const e of Object.values(ctx.engines)) e.start();
    // nur ausgewaehlte Schritte
    let r = await admin.post('/api/admin/livetest/start', { skip: ['levels', 'connections', 'player2', 'fader', 'wish', 'approve', 'beamer', 'crossfade', 'autofade', 'mics', 'panic', 'emergency', 'notify', 'backup'] });
    assert.equal(r.status, 200);
    assert.equal(r.json.run.steps.filter((s) => s.status === 'skipped').length, 14);
    const end = await waitFor(async () => { const s = (await admin.get('/api/admin/livetest')).json; return !s.running && s; }, 20000, 'Ende');
    assert.equal(end.last.steps.find((s) => s.id === 'player1').status, 'ok');

    r = await admin.post('/api/admin/livetest/start', {});
    await waitFor(async () => (await admin.get('/api/admin/livetest')).json.pending === 'levels', 5000, 'levels wartet');
    await admin.post('/api/admin/livetest/answer', { step: 'levels', value: 'skip' });
    await waitFor(async () => (await admin.get('/api/admin/livetest')).json.pending === 'wish', 40000, 'wish wartet');
    const st = (await admin.get('/api/admin/livetest')).json;
    assert.equal(st.run.steps.find((s) => s.id === 'levels').status, 'skipped');
    assert.ok(st.run.steps.find((s) => s.id === 'wish').links[0].path.endsWith(`/${settings().test.prefix}/`));
    r = await admin.post('/api/admin/livetest/stop', {});
    const stopped = await waitFor(async () => { const s = (await admin.get('/api/admin/livetest')).json; return !s.running && s; }, 10000, 'abgebrochen');
    assert.equal(stopped.last.verdict, 'abgebrochen');
    assert.equal(settings().test.realEnv, 'live');
    assert.ok(![1, 2].some((n) => ctx.engines.test.players[n].status().playing));
  } finally { await ctx.close(); }
});
