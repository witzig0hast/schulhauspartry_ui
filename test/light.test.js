import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { leadFor } from '../src/engine.js';
import { settings } from '../src/settings.js';

test('Licht-Rolle: nur lesen; Uebergang-Countdown und Zeiten der naechsten Songs', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { limit: { count: 50, windowMin: 15 } });
    const mk = async (role, label) => { const c = new Client(ctx.base); await c.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role, label })).json.code }); return c; };
    const light = await mk('light', 'Licht'), mod = await mk('mod', 'Mod'), tech = await mk('tech', 'Tech');
    // drei Wuensche annehmen, Auto-Crossfade an, Player 1 starten
    for (const q of ['blinding', 'levitating', 'sunflower']) {
      const g = new Client(ctx.base); await g.get('/api/guest/state');
      const t = (await g.get(`/api/guest/search?q=${q}`)).json.tracks[0];
      await g.post('/api/guest/request', { trackId: t.id });
    }
    for (const p of (await mod.get('/api/state')).json.pending) await mod.post('/api/mod/decide', { id: p.id, action: 'approve' });
    await tech.post('/api/settings/tech', { auto: { enabled: true, crossfadeSec: 8 } });
    assert.equal((await tech.post('/api/control/play', { player: 1 })).status, 200);

    const st = await light.get('/api/state');
    assert.equal(st.status, 200);
    assert.equal(st.json.role, 'light');
    assert.ok(st.json.crossfadeIn && st.json.crossfadeIn.inMs >= 0, 'Countdown bis zum Uebergang');
    assert.equal(st.json.crossfadeIn.crossfadeSec, 8);
    const up = st.json.upcoming;
    assert.ok(up.length >= 2);
    assert.equal(up[0].etaMs, st.json.crossfadeIn.inMs);          // naechster Song startet mit dem Uebergang
    assert.ok(up[1].etaMs > up[0].etaMs);                           // danach zeitlich geordnet
    assert.ok(up[0].durationMs > 0 && Array.isArray(up[0].families));
    assert.ok(st.json.playedNow.some((r) => r.families));            // Genre-Infos zum laufenden Song
    assert.ok(!('pending' in st.json) && !('chat' in st.json) && !('settings' in st.json)); // nichts Internes
    assert.ok(up.every((u) => u.decidedBy === null));

    // Rechte: keine Moderation, keine Technik, keine Admin-Seite; Licht-Seite ja
    assert.equal((await light.post('/api/mod/decide', { id: 1, action: 'approve' })).status, 403);
    assert.equal((await light.post('/api/control/play', { player: 1 })).status, 403);
    assert.equal((await light.get('/api/admin/settings')).status, 403);
    assert.equal((await light.get('/light')).status, 200);
    assert.equal((await light.get('/mod')).status, 403);
    assert.equal((await light.get('/tech')).status, 403);
    assert.equal((await new Client(ctx.base).get('/light')).status, 302);

    // Funktion ausschalten
    await admin.post('/api/admin/settings', { features: { viewLight: false } });
    assert.equal((await light.get('/light')).status, 404);
  } finally { await ctx.close(); }
});

test('leadFor: feste Vorlaufzeit, smart nach dem Outro', () => {
  const cfg = settings();
  cfg.auto.startBeforeEndSec = { 1: 20, 2: 15 };
  assert.equal(leadFor(cfg, 1, 200000, null), 20000);
  assert.equal(leadFor(cfg, 2, 200000, null), 15000);
  cfg.auto.smartOutro = true; cfg.auto.crossfadeSec = 8;
  assert.equal(leadFor(cfg, 1, 200000, { outro_ms: 30000 }), 90000);   // Obergrenze 90 s
  assert.equal(leadFor(cfg, 1, 200000, { outro_ms: 150000 }), 51000); // Uebergang 51 s vor Schluss (Outro beginnt bei 50 s Restzeit)
  assert.equal(leadFor(cfg, 1, 200000, { outro_ms: 195000 }), 9000);   // mindestens Crossfade + 1 s
});
