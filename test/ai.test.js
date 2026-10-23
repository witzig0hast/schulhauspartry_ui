import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, Client } from './helpers.js';
import { settings } from '../src/settings.js';

// Nachgebauter Ollama-Server: antwortet je nach Aufgabe (erkannt am System-Prompt) mit passendem JSON
function fakeOllama() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== 'Bearer ollama-geheim') return send(401, { error: 'unauthorized' });
      if (req.url === '/api/tags') return send(200, { models: [{ name: 'llama3.1:8b', size: 4.7e9, details: { parameter_size: '8B', family: 'llama' } }, { name: 'qwen2.5:14b', details: { parameter_size: '14B' } }] });
      if (req.url !== '/api/chat') return send(404, {});
      const j = JSON.parse(body);
      seen.push({ raw: body, j });
      if (j.model !== 'llama3.1:8b') return send(404, { error: `model "${j.model}" not found, try pulling it first` });
      const sys = j.messages[0].content, user = j.messages[1].content;
      let content;
      if (/gruss/.test(sys)) content = { ok: true, gruss: 'Hallo Technik!' };
      else if (/Warteschlange so ordnet/.test(sys)) {
        const q = JSON.parse(user).warteschlange.filter((x) => !x.fest).map((x) => x.id);
        content = { stimmung: 'Gute Laune, steigend', energie_jetzt: 7, empfehlung: 'Jetzt die Tanzfläche füllen.', reihenfolge: [...q.reverse(), 999999], begruendung: 'Steigerung zum Höhepunkt.' };
      } else if (/passende Songs nachlegt/.test(sys)) content = { vorschlaege: [{ titel: 'September', interpret: 'Earth, Wind & Fire', grund: 'Funk passt zur Stimmung' }, { titel: 'Gibt Es Nicht', interpret: 'Niemand', grund: 'erfunden' }, { titel: 'Mamma Mia', interpret: 'ABBA', grund: 'Mitsingen' }] };
      else if (/Lichtstimmung/.test(sys)) content = { farben: [{ name: 'Magenta', hex: '#FF00AA' }, { name: 'kaputt', hex: 'rot' }, { name: 'Cyan', hex: '#00e5ff' }], tempo: 'schnell', bpm_ca: 118, intensitaet: 8, strobo: true, effekte: ['Lauflicht auf den Beat', 'Nebel im Refrain'], stimmung: 'Funky und hell', hinweis: 'Refrain voll ausfahren.', song_bekannt: true };
      else if (/Veranstaltungstechniker/.test(sys)) content = { zusammenfassung: 'Player 2 ist nicht verbunden.', ampel: 'warn', probleme: [{ titel: 'Player 2 offline', schwere: 'hoch', ursache: 'Gerät schläft', schritte: ['Spotify auf dem Rechner öffnen', 'Admin → Verbindungen → Gerät laden'] }], antwort: 'Weil das Gerät nicht aktiv ist.' };
      else if (/Rückblicke/.test(sys)) content = { titel: 'Was für ein Abend!', text_gaeste: 'Danke an alle!', text_team: 'Ablehnungsquote im Blick behalten.' };
      else content = {};
      send(200, { message: { role: 'assistant', content: `<think>hm</think>${JSON.stringify(content)}` }, done: true });
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

test('KI ueber Ollama: Einrichtung, Energie-Kurve, Lueckenfueller, Licht, Fehler-Assistent, Rueckblick', async () => {
  const ctx = await startTestApp();
  const ol = await fakeOllama();
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const mk = async (role) => { const c = new Client(ctx.base); await c.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role, label: role })).json.code }); return c; };
    const tech = await mk('tech'), mod = await mk('mod');

    // nicht eingerichtet -> klare Meldung
    let r = await tech.post('/api/ai/energy');
    assert.equal(r.status, 409); assert.match(r.json.error, /nicht eingerichtet/);

    // Einrichtung: Modelle laden (mit Token), Modell waehlen, Test
    r = await admin.post('/api/admin/ai/models', { url: `${ol.url}/`, token: 'ollama-geheim' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.models.map((m) => m.name), ['llama3.1:8b', 'qwen2.5:14b']);
    assert.equal(settings().ai.url, ol.url);
    assert.equal((await admin.get('/api/admin/settings')).json.settings.ai.token, '***');
    await admin.post('/api/admin/settings', { ai: { enabled: true, model: 'llama3.1:8b' }, x32: { piToken: 'pi-token-streng-geheim' } });
    r = await admin.post('/api/admin/ai/test');
    assert.equal(r.status, 200); assert.equal(r.json.reply, 'Hallo Technik!');
    assert.ok(ol.seen.at(-1).j.format, 'feste JSON-Struktur wird verlangt');

    // Warteschlange: drei angenommene Wuensche
    const guest = new Client(ctx.base); await guest.get('/api/guest/state');
    await admin.post('/api/admin/settings', { limit: { count: 20, windowMin: 15 }, autoOrder: { enabled: false } });
    for (const q of ['uptown', 'levitating', 'believer']) { const t = (await guest.get(`/api/guest/search?q=${q}`)).json.tracks[0]; await guest.post('/api/guest/request', { trackId: t.id }); }
    for (const p of (await tech.get('/api/state')).json.pending) await tech.post('/api/mod/decide', { id: p.id, action: 'approve' });
    const before = (await tech.get('/api/state')).json.upcoming.map((u) => u.id);
    assert.equal(before.length, 3);

    // 3: Energie-Kurve (nur Technik/Admin), Vorschlag pruefen und uebernehmen
    assert.equal((await mod.post('/api/ai/energy')).status, 403);
    r = await tech.post('/api/ai/energy');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.order, [...before].reverse(), 'unbekannte IDs der KI werden verworfen');
    assert.equal(r.json.energy, 7); assert.ok(r.json.changed);
    assert.equal((await tech.post('/api/ai/energy/apply', { order: [before[0]] })).status, 409, 'unvollstaendige Reihenfolge');
    assert.equal((await tech.post('/api/ai/energy/apply', { order: r.json.order })).status, 200);
    assert.deepEqual((await tech.get('/api/state')).json.upcoming.map((u) => u.id), [...before].reverse());

    // 4: Lueckenfueller – nur was es bei Spotify gibt, dann einreihen
    r = await tech.post('/api/ai/filler');
    assert.equal(r.status, 200);
    const sug = r.json.suggestions;
    assert.equal(sug[0].track.title, 'September');
    assert.equal(sug[1].track, null); assert.match(sug[1].note, /nicht gefunden/);
    assert.equal((await tech.post('/api/ai/filler/add', { trackId: sug[0].track.id })).status, 200);
    const up = (await tech.get('/api/state')).json.upcoming;
    assert.ok(up.some((u) => u.title === 'September' && u.auto && u.ai && !u.team), 'als von der KI hinzugefügt markiert');

    // 5: Licht-Vorschlag – ungueltige Farben fliegen raus, erscheint in der Warteschlange
    r = await tech.post('/api/ai/light', { id: up[0].id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.cue.colors.map((c) => c.hex), ['#ff00aa', '#00e5ff']);
    assert.equal(r.json.cue.strobe, true); assert.equal(r.json.cue.bpm, 118);
    const light = new Client(ctx.base); await light.post('/api/login', { secret: (await admin.post('/api/admin/accounts', { role: 'light', label: 'L' })).json.code });
    assert.equal((await light.get('/api/state')).json.upcoming[0].light.mood, 'Funky und hell');

    // 7: Fehler-Assistent – keine Geheimnisse an die KI
    r = await tech.post('/api/ai/help', { question: 'Warum ist Player 2 rot?' });
    assert.equal(r.status, 200);
    assert.equal(r.json.level, 'warn'); assert.equal(r.json.problems[0].steps.length, 2); assert.match(r.json.answer, /Gerät/);
    const sent = ol.seen.at(-1).raw;
    assert.ok(sent.includes('Warum ist Player 2 rot?') && sent.includes('verbindungen'));
    for (const secret of ['pi-token-streng-geheim', 'ollama-geheim', 'super-geheimes-passwort']) assert.ok(!sent.includes(secret), `kein ${secret}`);
    assert.equal((await mod.post('/api/ai/help', {})).status, 403);

    // 9: Rueckblick (Admin), gespeichert
    r = await admin.post('/api/admin/ai/recap', { env: 'live' });
    assert.equal(r.status, 200); assert.equal(r.json.recap.title, 'Was für ein Abend!');
    assert.equal((await admin.get('/api/admin/ai/recap')).json.recap.team, 'Ablehnungsquote im Blick behalten.');
    assert.equal((await tech.post('/api/admin/ai/recap', {})).status, 403);

    // falsches Modell / Server weg: verstaendliche Fehler
    await admin.post('/api/admin/settings', { ai: { model: 'gibtsnicht' } });
    r = await tech.post('/api/ai/help', {});
    assert.equal(r.status, 503); assert.match(r.json.error, /nicht installiert/);
    await admin.post('/api/admin/settings', { ai: { model: 'llama3.1:8b', url: 'http://127.0.0.1:9' } });
    r = await tech.post('/api/ai/help', {});
    assert.equal(r.status, 503); assert.match(r.json.error, /nicht erreichbar/);
    // abschaltbar
    await admin.post('/api/admin/settings', { features: { aiEnergy: false } });
    assert.equal((await tech.post('/api/ai/energy')).status, 404);
  } finally { ol.server.close(); await ctx.close(); }
});
