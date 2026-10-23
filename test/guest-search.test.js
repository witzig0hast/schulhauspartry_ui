import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';

// Suche nur, wenn ein Wunsch auch moeglich ist (spart Spotify-Anfragen)
test('Gaeste-Suche: aus, wenn keine Wuensche frei, Wuensche zu oder Geraet gesperrt', async () => {
  const ctx = await startTestApp();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    await admin.post('/api/admin/settings', { limit: { count: 1, windowMin: 15 } });
    const g = new Client(ctx.base); await g.get('/api/guest/state');
    const t = (await g.get('/api/guest/search?q=uptown')).json.tracks[0];
    assert.equal((await g.post('/api/guest/request', { trackId: t.id })).status, 200);
    const spotifyBefore = ctx.engines.live.spotify.searchCalls ?? null;
    const r = await g.get('/api/guest/search?q=levitating');
    assert.equal(r.status, 429); assert.equal(r.json.noSearch, 'limit');
    assert.match(r.json.error, /keine Wünsche frei – in ca\. \d+ Min\./);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    if (spotifyBefore != null) assert.equal(ctx.engines.live.spotify.searchCalls, spotifyBefore, 'keine Spotify-Anfrage');
    // anderer Gast sucht weiter
    const g2 = new Client(ctx.base); await g2.get('/api/guest/state');
    assert.equal((await g2.get('/api/guest/search?q=levitating')).status, 200);
    // Wuensche zu: niemand sucht
    ctx.engines.live.setWishMode('closed');
    const c = await g2.get('/api/guest/search?q=levitating');
    assert.equal(c.status, 423); assert.equal(c.json.noSearch, 'closed');
  } finally { await ctx.close(); }
});
