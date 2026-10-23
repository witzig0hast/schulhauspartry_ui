import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { shield } from '../src/shield.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Unter Last (ganze Testreihe parallel) dauert es unterschiedlich lange: warten, bis die Bedingung erfuellt ist
async function until(get, ok, ms = 25000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await get(); if (ok(v)) return v; await sleep(500); } return v; }

test('Generalprobe: simuliert Gaeste, Moderation und Wiedergabe im Testmodus und raeumt danach auf', async () => {
  shield.reset();
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    // ohne Testmodus: klare Meldung
    let r = await admin.post('/api/admin/rehearsal/start', { guests: 20, durationMin: 1 });
    assert.equal(r.status, 400); assert.match(r.json.error, /Testmodus/);
    await admin.post('/api/admin/settings', { test: { enabled: true }, limit: { count: 5, windowMin: 15 } });
    for (const e of Object.values(ctx.engines)) e.start();   // Engines laufen in Tests sonst nicht
    // nur Admin
    const mod = new Client(ctx.base); await mod.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'mod', label: 'M' })).json.code });
    assert.equal((await mod.post('/api/admin/rehearsal/start', {})).status, 403);

    r = await admin.post('/api/admin/rehearsal/start', { guests: 25, durationMin: 1, rampSec: 1, intensity: 'extrem', modDelaySec: 1, speed: 30, ipMode: 'many' });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.running, true);
    assert.equal((await admin.post('/api/admin/rehearsal/start', {})).status, 400);       // nicht doppelt
    const st = await until(async () => (await admin.get('/api/admin/rehearsal')).json, (x) => x.current && x.current.guests.joined === 25 && x.current.decisions.approved + x.current.decisions.denied > 0 && x.current.cats.Suche?.ok > 0 && x.current.ws.opened >= 20 && x.current.totals.n > 100);
    const c = st.current;
    assert.equal(c.guests.joined, 25);
    assert.ok(c.totals.n > 100, `Anfragen: ${c.totals.n}`);
    assert.ok(c.cats.Seite.ok >= 25 && c.cats.Suche.ok > 0 && c.cats.Wunsch.n > 0, JSON.stringify(c.cats));
    assert.ok(c.ws.opened >= 20, JSON.stringify(c.ws));
    assert.ok(c.decisions.approved + c.decisions.denied > 0, 'Moderations-Bot hat entschieden ' + JSON.stringify([c.cats.Team, c.cats.Wunsch, c.app]));
    assert.equal(c.totals.err, 0, 'keine Serverfehler');
    // Live-Party unberuehrt
    assert.equal((await admin.get('/api/state')).json.counts.pending, 0);

    const stopped = (await admin.post('/api/admin/rehearsal/stop')).json;
    assert.equal(stopped.running, false); assert.ok(stopped.last.findings.length);
    assert.ok(['ok', 'warn', 'bad'].includes(stopped.last.verdict));
    // aufgeraeumt: Bot-Zugang weg, Testdaten zurueckgesetzt
    assert.ok(!(await admin.get('/api/admin/accounts')).json.accounts.some((a) => a.label === 'Generalprobe-Bot'));
    assert.equal(ctx.engines.test.snapshot().counts.pending, 0);
    assert.equal(shield.status().bans.filter((b) => b.ip.startsWith('198.18.')).length, 0);
  } finally { await ctx.close(); shield.reset(); }
});

test('Generalprobe ueber eine Adresse zeigt Grenzen des Schutzes', async () => {
  shield.reset();
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { test: { enabled: true }, security: { shield: { guestPerMin: 30, banStrikes: 5000 } } });
    await admin.post('/api/admin/rehearsal/start', { guests: 40, durationMin: 1, rampSec: 0, intensity: 'extrem', ipMode: 'one', pages: false, live: false });
    await sleep(4000);
    const done = (await admin.post('/api/admin/rehearsal/stop')).json.last;
    assert.ok(done.totals.shield > 0, 'Schutz hat abgewiesen');
    assert.ok(done.findings.some((f) => /Schutz vor Überlastung/.test(f.text) && /Schul-WLAN/.test(f.hint)));
  } finally { await ctx.close(); shield.reset(); }
});

test('Generalprobe live: nur leer und bestaetigt, simuliert Spotify/Pult, keine Alarme, raeumt komplett auf', async () => {
  shield.reset();
  const { sendNotify } = await import('../src/notify.js');
  const { createRehearsal } = await import('../src/rehearsal.js');
  const { getSetting, setSetting } = await import('../src/db.js');
  const rq = await import('../src/requests.js');
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { limit: { count: 5, windowMin: 15 }, notify: { enabled: true, topic: 'probe-test', url: 'http://127.0.0.1:9' } });
    for (const e of Object.values(ctx.engines)) e.start();
    const live = ctx.engines.live;
    live.setWishMode('paused');
    assert.equal(live.realConnections, true, 'Live hat in Tests die echten Verbindungen (ohne Zugangsdaten simuliert)');

    let r = await admin.post('/api/admin/rehearsal/start', { target: 'live', guests: 20, durationMin: 1 });
    assert.equal(r.status, 400); assert.match(r.json.error, /LIVE eintippen/);
    const t = (await live.spotify.search('uptown', 1))[0];
    rq.submitWish('live', t, 'echter-gast');
    r = await admin.post('/api/admin/rehearsal/start', { target: 'live', confirm: 'LIVE', guests: 20, durationMin: 1 });
    assert.equal(r.status, 400); assert.match(r.json.error, /leerer Live-Umgebung/);
    rq.resetEnv('live');

    r = await admin.post('/api/admin/rehearsal/start', { target: 'live', confirm: 'LIVE', guests: 20, durationMin: 1, rampSec: 1, intensity: 'extrem', modDelaySec: 1, speed: 30 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(live.realConnections, false, 'waehrend der Probe simuliert');
    await admin.post('/api/admin/settings', { test: { realEnv: 'live' } });
    live.setReal(true);
    assert.equal(live.realConnections, false, 'bleibt simuliert, auch wenn jemand umschaltet');
    assert.ok(getSetting('rehearsalLive'));
    assert.equal((await sendNotify({ title: 'x', message: 'y', env: 'live' })).reason, 'Generalprobe läuft', 'keine Alarme fuer Live');
    const c = await until(async () => (await admin.get('/api/admin/rehearsal')).json.current, (x) => x && x.cats.Wunsch?.n > 0 && x.cats.Seite?.ok >= 20 && x.app.pending + x.app.queue + x.app.played > 0);
    assert.equal(c.opt.target, 'live');
    assert.ok(c.cats.Wunsch.n > 0 && c.cats.Seite.ok >= 20, JSON.stringify(c.cats));
    assert.ok(c.app.pending + c.app.queue + c.app.played > 0, 'Wünsche sind in Live angekommen');
    assert.equal(c.totals.err, 0);

    const done = (await admin.post('/api/admin/rehearsal/stop')).json;
    assert.equal(done.running, false);
    assert.equal(rq.counts('live').pending + rq.counts('live').approved + rq.counts('live').played, 0, 'Live wieder leer');
    assert.equal(live.realConnections, true, 'echte Verbindungen wie vorher');
    assert.equal(live.state.wishMode, 'paused', 'Freischaltung wie vorher');
    assert.equal(getSetting('rehearsalLive'), null);
    assert.notEqual((await sendNotify({ title: 'x', message: 'y', env: 'live' })).reason, 'Generalprobe läuft');
    assert.ok(!(await admin.get('/api/admin/accounts')).json.accounts.some((a) => a.label === 'Generalprobe-Bot'));

    // Server-Neustart mitten in der Probe: beim Start wird Live aufgeraeumt
    rq.submitWish('live', t, 'probe-gast');
    setSetting('rehearsalLive', Date.now());
    createRehearsal({ server: ctx.server, engines: ctx.engines });
    assert.equal(rq.counts('live').pending, 0);
    assert.equal(getSetting('rehearsalLive'), null);
  } finally { await ctx.close(); shield.reset(); }
});
