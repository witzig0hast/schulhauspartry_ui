import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { shield } from '../src/shield.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(11000);
    const st = (await admin.get('/api/admin/rehearsal')).json;
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
