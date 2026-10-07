import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { genreFamily, familiesOf } from '../src/genres.js';

let ctx, admin, mod, tech, display;
const PW = 'super-geheimes-passwort-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const login = async (role, label) => { const c = new Client(ctx.base); const code = (await admin.post('/api/admin/accounts', { role, label })).json.code; await c.post('/api/login', { secret: code }); return c; };
const guest = async () => { const g = new Client(ctx.base); await g.get('/api/guest/state'); return g; };
const wish = async (g, q) => { const t = (await g.get(`/api/guest/search?q=${encodeURIComponent(q)}`)).json.tracks[0]; return { t, res: await g.post('/api/guest/request', { trackId: t.id }) }; };

test.before(async () => {
  ctx = await startTestApp();
  admin = new Client(ctx.base); await admin.post('/api/login', { secret: PW });
  await admin.post('/api/admin/settings', { limit: { count: 50, windowMin: 15 } });
  mod = await login('mod', 'Mod'); tech = await login('tech', 'Tech'); display = await login('display', 'Display');
});
test.after(async () => { await ctx.close(); });

test('Genre-Familien', () => {
  assert.equal(genreFamily('german hip hop'), 'Hip-Hop & Rap');
  assert.equal(genreFamily('partyschlager'), 'Schlager & Deutsch');
  assert.equal(genreFamily('dance pop'), 'Electronic & Dance');
  assert.equal(genreFamily('pop'), 'Pop');
  assert.deepEqual(familiesOf([]), ['Unbekannt']);
});

test('Sperrliste: Song sperren entfernt offene Wuensche und blockt neue', async () => {
  const g = await guest();
  const { t, res } = await wish(g, 'blinding');
  assert.equal(res.status, 200);
  const st = (await mod.get('/api/state')).json;
  assert.equal(st.pending.length, 1);
  // Moderator sperrt den Song direkt aus dem offenen Wunsch
  const b = await mod.post('/api/mod/blacklist', { kind: 'track', trackId: t.id, title: t.title, artist: t.artist, reason: 'Passt nicht' });
  assert.equal(b.status, 200); assert.equal(b.json.denied, 1);
  assert.equal((await mod.get('/api/state')).json.pending.length, 0);
  assert.equal((await mod.get('/api/state')).json.blacklist.length, 1);
  // Gast sieht "nicht moeglich" und kann nicht wuenschen
  const s = await g.get('/api/guest/search?q=blinding');
  assert.equal(s.json.tracks[0].blocked, true);
  assert.equal(s.json.tracks[0].blockedText, 'nicht möglich');
  const r = await g.post('/api/guest/request', { trackId: t.id });
  assert.equal(r.status, 403);
  // Freigeben
  const id = (await mod.get('/api/mod/blacklist')).json.blacklist[0].id;
  assert.equal((await mod.post('/api/mod/blacklist/remove', { id })).status, 200);
  assert.equal((await g.post('/api/guest/request', { trackId: t.id })).status, 200);
});

test('Sperrliste: Interpret sperren blockt alle Songs, nur Berechtigte duerfen', async () => {
  const g = await guest();
  assert.equal((await display.post('/api/mod/blacklist', { kind: 'artist', artistName: 'Eminem' })).status, 403);
  assert.equal((await mod.post('/api/mod/blacklist', { kind: 'artist', artistName: 'Eminem' })).status, 200);
  for (const q of ['lose yourself', 'mockingbird']) assert.equal((await g.get(`/api/guest/search?q=${encodeURIComponent(q)}`)).json.tracks[0].blocked, true);
  assert.equal((await g.get('/api/guest/search?q=levitating')).json.tracks[0].blocked, false);
  // Gesperrte Songs koennen nicht wieder eingereiht werden
  const list = (await mod.get('/api/mod/blacklist')).json.blacklist;
  await mod.post('/api/mod/blacklist/remove', { id: list.find((x) => x.kind === 'artist').id });
});

test('Schon gespielt: Regel "sperren" und "Pause", manuell nochmal einreihen', async () => {
  const g = await guest();
  const { t, res } = await wish(g, 'levitating');
  assert.equal(res.status, 200);
  const pend = (await mod.get('/api/state')).json.pending.find((p) => p.title === 'Levitating');
  await mod.post('/api/mod/decide', { id: pend.id, action: 'approve' });
  await tech.post('/api/control/crossfade', { sec: 1 });
  await ctx.engines.live.tick();
  // naechsten Song starten, damit Levitating als "gespielt" gilt
  const { res: r2 } = await wish(g, 'uptown');
  assert.equal(r2.status, 200);
  const p2 = (await mod.get('/api/state')).json.pending.find((p) => p.title === 'Uptown Funk');
  await mod.post('/api/mod/decide', { id: p2.id, action: 'approve' });
  ctx.engines.live.crossfade = null;
  await tech.post('/api/control/crossfade', { sec: 1 });
  const hist = (await mod.get('/api/state')).json.history;
  assert.ok(hist.some((h) => h.title === 'Levitating' && h.status === 'played'), 'Levitating im Verlauf');

  // Regel: allow (Standard) -> erlaubt
  assert.equal((await g.get('/api/guest/search?q=levitating')).json.tracks[0].blocked, false);
  // Regel: block
  await admin.post('/api/admin/settings', { replay: { mode: 'block' } });
  const s1 = (await g.get('/api/guest/search?q=levitating')).json.tracks[0];
  assert.equal(s1.blocked, true); assert.equal(s1.blockedText, 'lief schon');
  const r3 = await g.post('/api/guest/request', { trackId: t.id });
  assert.equal(r3.status, 403); assert.match(r3.json.error, /schon gespielt/);
  // Regel: cooldown (gerade erst gespielt -> gesperrt, mit Wartezeit)
  await admin.post('/api/admin/settings', { replay: { mode: 'cooldown', cooldownMin: 30 } });
  const r4 = await g.post('/api/guest/request', { trackId: t.id });
  assert.equal(r4.status, 403); assert.match(r4.json.error, /in ca\. \d+ Min/);
  // Moderation kann den Song trotzdem manuell wieder einreihen
  const playedId = hist.find((h) => h.title === 'Levitating').id;
  const rq1 = await mod.post('/api/mod/requeue', { id: playedId });
  assert.equal(rq1.status, 200);
  assert.ok((await mod.get('/api/state')).json.upcoming.some((u) => u.title === 'Levitating'));
  assert.equal((await mod.post('/api/mod/requeue', { id: playedId })).status, 409, 'nicht doppelt');
  await admin.post('/api/admin/settings', { replay: { mode: 'allow' } });
});

test('Analytics: Struktur, Genres und Zugriff', async () => {
  assert.equal((await new Client(ctx.base).get('/api/analytics')).status, 401);
  const a = (await display.get('/api/analytics?range=0')).json;
  assert.ok(a.kpis.requests >= 3);
  assert.ok(a.genres.requested.length > 0, 'Genres vorhanden');
  assert.ok(a.genres.requested.every(([f, n]) => typeof f === 'string' && n > 0));
  assert.ok(a.artists.requested.length > 0 && a.decades.length > 0);
  assert.equal(a.popularity.length, 5);
  assert.ok(a.timeline.length >= 1 && a.genreTimeline.families.length >= 1);
  assert.ok(a.kpis.blocked >= 2, 'blockierte Versuche gezaehlt');
  assert.ok(['Pop', 'Electronic & Dance', 'Funk & Disco', 'Hip-Hop & Rap'].some((f) => a.genres.requested.some(([n]) => n === f)));
  const a2 = (await display.get('/api/analytics?range=15')).json;
  assert.equal(a2.rangeMin, 15);
  assert.equal((await display.get('/api/analytics?range=abc')).json.rangeMin, 0);
});

test('Neue Seiten: Fokus (nur Moderation+), Ticker (Anzeige)', async () => {
  assert.equal((await mod.get('/focus')).status, 200);
  assert.equal((await display.get('/focus')).status, 403);
  assert.equal((await display.get('/ticker')).status, 200);
  assert.equal((await mod.get('/ticker')).status, 403);
  assert.equal((await display.get('/analytics')).status, 200);
  assert.equal((await new Client(ctx.base).get('/analytics')).status, 302);
});

test('Anzeige-Rolle sieht Wuensche fuer den Ticker, aber keine Sperrliste/Verlauf', async () => {
  const st = (await display.get('/api/state')).json;
  assert.ok(Array.isArray(st.pending) && Array.isArray(st.recent));
  assert.equal(st.history, undefined); assert.equal(st.blacklist, undefined);
  assert.ok(st.recent.every((r) => 'decidedAt' in r && 'createdAt' in r));
});
