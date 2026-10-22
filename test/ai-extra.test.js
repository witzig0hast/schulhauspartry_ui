import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, Client } from './helpers.js';
import * as rq from '../src/requests.js';
import { guessGenres, startMoodWatch, aiGenresOf } from '../src/ai.js';
import { getDb } from '../src/db.js';

// Nachgebautes Ollama fuer Genres, Zusammenfassung und Stimmung
function fakeOllama(state) {
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body || '{}'), sys = j.messages?.[0]?.content || '', user = j.messages?.[1]?.content || '';
      let c = {};
      if (/Genres zuordnet/.test(sys)) c = { genres: ['german hip hop', 'erfunden', 'rap'], sicher: false };
      else if (/Überblick zu behalten/.test(sys)) { const ids = JSON.parse(user).offen.map((x) => x.id); c = { ueberblick: `${ids.length} offen, vor allem Pop.`, gruppen: [{ name: 'Pop', anzahl: 2 }], auffaellig: [{ id: ids[0], grund: 'Titel prüfen' }, { id: 999999, grund: 'gibt es nicht' }], empfehlung: 'Mit den ältesten anfangen.' }; }
      else if (/Stimmung gerade kippt/.test(sys)) { state.moodInput = JSON.parse(user); c = { kippt: true, schwere: 'hoch', grund: 'Wünsche von 9 auf 1 gefallen.', vorschlag: 'Einen Partyhit vorziehen.' }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: JSON.stringify(c) }, done: true }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test('KI: Genres nachtragen, Wunsch-Zusammenfassung, Stimmungs-Warnung nur per ntfy', async () => {
  const ctx = await startTestApp();
  const state = {};
  const ol = await fakeOllama(state);
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const mod = new Client(ctx.base); await mod.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'mod', label: 'M' })).json.code });
    const light = new Client(ctx.base); await light.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'light', label: 'L' })).json.code });
    await admin.post('/api/admin/settings', { ai: { enabled: true, url: ol.url, model: 'm' } });

    // Genres: Spotify lieferte keine -> KI ergaenzt, nur erlaubte Genres
    const T = 'G'.repeat(22);
    const w = rq.submitWish('live', { id: T, uri: `spotify:track:${T}`, title: 'Unbekannter Track', artist: 'Newcomer', durationMs: 180000 }, 'dev-g');
    rq.setGenres(w.request.id, []);
    const g = await guessGenres({ trackId: T, title: 'Unbekannter Track', artist: 'Newcomer' });
    assert.deepEqual(g.genres, ['german hip hop', 'rap'], 'Genres außerhalb der Liste fliegen raus');
    assert.deepEqual(JSON.parse(getDb().prepare('SELECT genres FROM requests WHERE id = ?').get(w.request.id).genres), ['german hip hop', 'rap']);
    assert.equal(aiGenresOf(T).sure, false);
    const lp = (await light.get('/api/state')).json.pending ?? (await admin.get('/api/state')).json.pending;
    assert.ok(lp.find((p) => p.trackId === T)?.genresAi, 'als KI-Genres markiert');

    // Zusammenfassung: nur fuer Moderation, unbekannte IDs verworfen
    rq.submitWish('live', { id: 'H'.repeat(22), uri: 'x', title: 'Zweiter', artist: 'B', durationMs: 1000 }, 'dev-h');
    const s = await mod.post('/api/ai/summary');
    assert.equal(s.status, 200, JSON.stringify(s.json));
    assert.equal(s.json.count, 2); assert.equal(s.json.flagged.length, 1); assert.equal(s.json.groups[0].name, 'Pop');
    assert.equal((await light.post('/api/ai/summary')).status, 403);

    // Stimmung: Warnung geht nur an ntfy, und nur wenn ntfy eingerichtet ist
    const e = ctx.engines.live;
    let last;
    for (const q of ['uptown', 'levitating', 'believer', 'thunder']) {   // vier gespielte Songs: der Abend laeuft
      last = (await e.spotify.search(q, 1))[0];
      const o = rq.submitWish('live', last, `d-${q}`);
      getDb().prepare("UPDATE requests SET status = 'played', played_at = ? WHERE id = ?").run(Date.now(), o.request.id);
    }
    await e.playDirect(1, last);
    const sent = [];
    const watch = startMoodWatch(ctx.engines, async (n) => { sent.push(n); return { sent: true }; });
    await watch.tick();
    assert.equal(sent.length, 0, 'ohne eingerichtetes ntfy keine Prüfung');
    await admin.post('/api/admin/settings', { notify: { enabled: true, topic: 'party-test' } });
    await watch.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, '📉 Stimmung kippt!'); assert.match(sent[0].message, /Partyhit/); assert.equal(sent[0].key, 'mood:live');
    assert.ok(state.moodInput.zuletzt_gespielt.length >= 4 && 'wuensche_letzte_15_min' in state.moodInput);
    await watch.tick();
    assert.equal(sent.length, 1, 'höchstens alle 10 Minuten');
    await admin.post('/api/admin/settings', { notify: { events: { mood: false } } });
    watch();
    const logs = (await admin.get('/api/logs?cats=ki')).json.logs;
    assert.ok(logs.some((x) => x.event === 'mood.check' && x.level === 'warn'));
    assert.ok(logs.some((x) => x.event === 'genres.filled'));
    assert.ok(logs.some((x) => x.event === 'ai.summary'));
  } finally { ol.server.close(); await ctx.close(); }
});
