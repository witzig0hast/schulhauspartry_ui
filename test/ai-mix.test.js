import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, Client } from './helpers.js';
import * as rq from '../src/requests.js';
import { makeMix, mixInfo, mixTrimDb, mixPlan } from '../src/ai.js';

// Nachgebautes Ollama: Analyse je nach Titel
function fakeOllama() {
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}'), user = JSON.parse(j.messages?.[1]?.content || '{}');
      const c = /Uptown/i.test(user.titel) ? { lautheit_lufs_ca: -6, intro_s: 2, outro_s: 12, ende: 'fade', energie: 6, song_bekannt: true }
        : { lautheit_lufs_ca: -12, intro_s: 0, outro_s: 0, ende: 'hart', energie: 9, song_bekannt: true };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: JSON.stringify(c) }, done: true }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('KI-Uebergaenge: Analyse, Pegel-Ausgleich, Plan, automatischer Crossfade danach; Standard-Fade-Zeit', async () => {
  const ctx = await startTestApp();
  const ol = await fakeOllama();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { ai: { enabled: true, url: ol.url, model: 'm' }, auto: { enabled: true, crossfadeSec: 8, fadeSec: 3 } });
    const e = ctx.engines.live;
    const a = (await e.spotify.search('uptown', 1))[0], b = (await e.spotify.search('levitating', 1))[0];
    await makeMix({ trackId: a.id, title: a.title, artist: a.artist, durationMs: a.durationMs });
    await makeMix({ trackId: b.id, title: b.title, artist: b.artist, durationMs: b.durationMs });
    assert.equal(mixInfo(a.id).ending, 'fade');
    // laut (-6 LUFS) -> 3 dB leiser; leise (-12) bleibt (der Grundpegel ist das Maximum)
    assert.equal(mixTrimDb(a.id), -3); assert.equal(mixTrimDb(b.id), 0);
    await admin.post('/api/admin/settings', { ai: { mixMaxCutDb: 2 } });
    assert.equal(mixTrimDb(a.id), -2, 'Obergrenze für die Absenkung');
    await admin.post('/api/admin/settings', { ai: { mixMaxCutDb: 6 } });
    // Plan: A blendet aus, B hat deutlich mehr Energie -> zuegig
    const plan = mixPlan({ curId: a.id, nextId: b.id, durationMs: a.durationMs, baseSec: 8 });
    assert.equal(plan.durSec, 5); assert.match(plan.why, /blendet aus.*Energie/);
    assert.ok(plan.leadMs >= 5500 && plan.leadMs <= 7000, String(plan.leadMs));
    // ohne naechsten Song: Laenge aus dem Ausblenden
    assert.equal(mixPlan({ curId: a.id, nextId: null, durationMs: a.durationMs, baseSec: 8 }).durSec, 12);

    // Engine: A spielt mit KI-Pegel, Auto-Crossfade startet zum geplanten Zeitpunkt mit geplanter Laenge
    rq.addAuto('live', a, null); rq.addAuto('live', b, null);
    await e.play(1);
    assert.ok(Math.abs(e.trackMul[1] - Math.pow(10, -3 / 20)) < 1e-6, 'KI-Pegel-Ausgleich angewendet');
    assert.equal(e.snapshot().mix.trim[1], -3);
    const dur = e.players[1].status().durationMs;
    e.players[1].seekTo(dur - 9000);
    await e.tick();
    assert.equal(e.crossfade, null, 'noch zu früh');
    e.players[1].seekTo(dur - 6000);
    await e.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(e.crossfade, 'Crossfade gestartet');
    assert.equal(e.crossfade.dur, 5);
    const logs = (await admin.get('/api/logs?cats=wiedergabe')).json.logs;
    assert.ok(logs.some((x) => x.event === 'crossfade.ai' && /KI-Übergang: 5 s/.test(x.msg)));

    // Standard-Fade-Zeit gilt fuer die Knoepfe ohne Angabe
    assert.equal((await admin.get('/api/state')).json.auto.fadeSec, 3);
    // KI aus: keine Absenkung, kein Plan
    await admin.post('/api/admin/settings', { ai: { autoMix: false } });
    assert.equal(mixTrimDb(a.id), null);
    assert.equal(e.snapshot().mix, null);
  } finally { ol.server.close(); await ctx.close(); }
});
