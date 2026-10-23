import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startTestApp, Client } from './helpers.js';
import * as L from '../src/log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Live-Protokoll: Mensch und Maschine, Rechte, Filter, Export, Live-Nachschub', async () => {
  const ctx = await startTestApp();
  let ws;
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const mk = async (role, label) => { const c = new Client(ctx.base); await c.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role, label })).json.code }); return c; };
    const tech = await mk('tech', 'Tom (Technik)'), mod = await mk('mod', 'Mia');
    assert.equal((await mod.get('/api/logs')).status, 403, 'Moderation sieht das Protokoll nicht');
    assert.equal((await mod.get('/logs')).status, 403);
    assert.equal((await tech.get('/logs')).status, 200);

    // Live-Abo per WebSocket (Technik)
    const got = [];
    ws = new WebSocket(`${ctx.base.replace('http', 'ws')}/ws`, { headers: { Cookie: Object.entries(tech.cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
    ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'logs') got.push(...m.data); });
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'logs', on: true }));
    await sleep(100);

    // Ablauf: Wunsch -> Annehmen -> Play
    await admin.post('/api/admin/settings', { limit: { count: 20, windowMin: 15 } });
    const guest = new Client(ctx.base); await guest.get('/api/guest/state');
    const t = (await guest.get('/api/guest/search?q=uptown')).json.tracks[0];
    await guest.post('/api/guest/request', { trackId: t.id });
    const id = (await mod.get('/api/state')).json.pending[0].id;
    await mod.post('/api/mod/decide', { id, action: 'approve' });
    await tech.post('/api/control/play', { player: 1 });
    await sleep(500);

    const all = (await tech.get('/api/logs')).json;
    const ev = (name) => all.logs.find((e) => e.event === name);
    const created = ev('request.created');
    assert.match(created.msg, /Neuer Wunsch: Uptown Funk/);
    assert.equal(created.cat, 'wunsch'); assert.equal(created.data.trackId, t.id);
    assert.match(created.actor.label, /^Gast [0-9a-f]{5}$/, 'Gast nur als Kuerzel, nie mit Geraete-ID');
    assert.ok(!JSON.stringify(all.logs).includes(guest.cookies.dev?.split('.')[0] || 'nix'), 'keine Geraete-ID im Protokoll');
    const approved = ev('request.approved');
    assert.match(approved.msg, /Angenommen: Uptown Funk/); assert.equal(approved.actor.label, 'Mia');
    const play = ev('control.play');
    assert.equal(play.actor.label, 'Tom (Technik)'); assert.equal(play.data.body.player, 1);
    // Sicherheit (Logins, IPs) nur fuer den Admin
    assert.ok(!all.logs.some((e) => e.cat === 'sicherheit'), 'Technik sieht keine Logins');
    assert.ok(!('sicherheit' in all.cats));
    const adm = (await admin.get('/api/logs?cats=sicherheit')).json.logs;
    assert.ok(adm.some((e) => e.event === 'audit.login.ok' && /Anmeldung/.test(e.msg)));

    // Live-Nachschub ohne Sicherheitseintraege
    assert.ok(got.some((e) => e.event === 'request.approved'), 'live angekommen');
    assert.ok(!got.some((e) => e.cat === 'sicherheit'));

    // Filter: Bereich, Level, Suche, Umgebung
    const onlyMod = (await tech.get('/api/logs?cats=moderation')).json.logs;
    assert.ok(onlyMod.length && onlyMod.every((e) => e.cat === 'moderation'));
    assert.ok((await tech.get('/api/logs?q=Uptown')).json.logs.every((e) => /uptown/i.test(`${e.msg}${JSON.stringify(e.data)}`)));
    L.warn('pult', 'test.warn', 'Testwarnung', { env: 'test', data: { token: 'geheim123', nested: { password: 'x', ok: 1 } } });
    const warns = (await tech.get('/api/logs?level=warn')).json.logs;
    assert.ok(warns.length && warns.every((e) => ['warn', 'error'].includes(e.level)));
    const tw = warns.find((e) => e.event === 'test.warn');
    assert.equal(tw.data.token, '***'); assert.equal(tw.data.nested.password, '***'); assert.equal(tw.data.nested.ok, 1);
    assert.ok((await tech.get('/api/logs?env=test')).json.logs.every((e) => e.env === 'test'));

    // Export: eine JSON-Zeile pro Eintrag
    const ex = await tech.get('/api/logs/export?cats=wunsch,moderation');
    assert.match(ex.headers.get('content-type'), /ndjson/);
    const lines = ex.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length >= 2 && lines.every((l) => l.event && l.ts && l.msg));

    // Debug nur, wenn eingeschaltet, und nur im Speicher
    L.debug('spotify', 'test.debug', 'unsichtbar');
    assert.ok(!(await admin.get('/api/logs?level=debug')).json.logs.some((e) => e.event === 'test.debug'));
    await admin.post('/api/admin/settings', { logs: { debug: true } });
    L.debug('spotify', 'test.debug', 'sichtbar', { env: 'system' });
    assert.ok((await admin.get('/api/logs?level=debug')).json.logs.some((e) => e.event === 'test.debug'));
    assert.ok(!(await admin.get('/api/logs?level=info')).json.logs.some((e) => e.event === 'test.debug'));

    // Abgelehnte Technik-Knoepfe: Grund steht im Protokoll; fremde Herkunft landet bei Sicherheit
    await tech.post('/api/control/crossfade', {});
    const cf = (await tech.get('/api/logs?cats=wiedergabe')).json.logs.find((e) => e.event === 'control.crossfade');
    assert.equal(cf.level, 'warn'); assert.ok(cf.data.error && cf.msg.includes(cf.data.error), cf.msg);
    const bad = await fetch(`${ctx.base}/api/control/pause`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://boese.example', Cookie: Object.entries(tech.cookies).map(([k, v]) => `${k}=${v}`).join('; ') }, body: '{"player":1}' });
    assert.equal(bad.status, 403);
    const od = (await admin.get('/api/logs?cats=sicherheit')).json.logs.find((e) => e.event === 'origin.denied');
    assert.equal(od.data.origin, 'https://boese.example');
  } finally { ws?.close(); await ctx.close(); }
});
