import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor, RateLimitError, governor } from '../src/adapters/spotify-governor.js';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { loadSettings, setPlayerToken } from '../src/settings.js';
import { RealSpotify, RealPlayer } from '../src/adapters/spotify-real.js';

// ---- Regler (mit simulierter Uhr) ----
function fakeGov(budget = 10) {
  let t = 1_000_000;
  const g = new Governor({ budget, now: () => t, sleep: async (ms) => { t += ms; } });
  return { g, tick: (ms) => { t += ms; } };
}

test('Regler: Suche darf 60 %, Player-Abfragen 80 %, Steuerbefehle alles', async () => {
  const { g } = fakeGov(10);
  for (let i = 0; i < 6; i++) await g.acquire('search');
  await assert.rejects(() => g.acquire('search'), RateLimitError);
  for (let i = 0; i < 2; i++) await g.acquire('poll');
  await assert.rejects(() => g.acquire('poll'), RateLimitError);
  for (let i = 0; i < 2; i++) await g.acquire('critical');
  assert.equal(g.used(), 10);
});

test('Regler: Fenster laeuft ab, Steuerbefehle warten statt zu scheitern', async () => {
  const { g, tick } = fakeGov(10);
  for (let i = 0; i < 10; i++) await g.acquire('critical');
  await g.acquire('critical'); // wartet (simulierte Uhr), bis ein Platz frei ist
  assert.ok(g.used() <= 10);
  tick(31000);
  assert.equal(g.used(), 0);
  await g.acquire('search');
});

test('Regler: nach 429 ruhen unkritische Anfragen bis Retry-After, kritische warten', async () => {
  const { g, tick } = fakeGov(10);
  g.onRateLimited(5);
  const err = await g.acquire('search').catch((e) => e);
  assert.ok(err instanceof RateLimitError && err.retryAfterMs >= 5000);
  await assert.rejects(() => g.acquire('poll'), RateLimitError);
  await g.acquire('critical'); // wartet die Pause ab
  assert.equal(g.pausedMs(), 0);
  assert.equal(g.stats.rate429, 1);
  tick(1);
});

// ---- Spotify-Adapter mit simuliertem Netz ----
const calls = [];
const realFetch = globalThis.fetch;
let handler = () => ({ status: 200, body: {} });
function installFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    if (url.includes('accounts.spotify.com/api/token')) return new Response(JSON.stringify({ access_token: 'tok', refresh_token: 'rt', expires_in: 3600 }), { status: 200 });
    calls.push({ url, method: opts.method || 'GET' });
    const r = handler(url, opts);
    return new Response(r.body == null ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers || {} });
  };
}
const track = (id, name) => ({ id, uri: `spotify:track:${id}`, name, explicit: false, duration_ms: 200000, popularity: 70, artists: [{ id: 'A'.repeat(22), name: 'Artist' }], album: { name: 'Alb', release_date: '2020-01-01' } });
const ID1 = 'a'.repeat(22), ID2 = 'b'.repeat(22);

test.before(() => {
  config.secret = 'test-secret-test-secret-test-secret-1234';
  config.spotifyClientId = 'cid'; config.spotifyClientSecret = 'sec';
  openDb(':memory:'); loadSettings();
  setPlayerToken(1, 'refresh-token', 'tester');
  installFetch();
  governor.setBudget(100);
});
test.after(() => { globalThis.fetch = realFetch; });
const resetGov = () => { governor.stamps = []; governor.pausedUntil = 0; calls.length = 0; };

test('Suche: gleiche Anfragen werden zusammengefasst und gemerkt, Treffer fuellen den Track-Cache', async () => {
  resetGov();
  handler = (url) => (url.includes('/v1/search') ? { status: 200, body: { tracks: { items: [track(ID1, 'Song A'), track(ID2, 'Song B')] } } } : { status: 404, body: {} });
  const sp = new RealSpotify();
  const [a, b, c, d, e] = await Promise.all([1, 2, 3, 4, 5].map(() => sp.search('Song  A')));
  assert.equal(a.length, 2); assert.equal(e.length, 2);
  assert.equal(calls.filter((x) => x.url.includes('/v1/search')).length, 1, 'fuenf gleichzeitige Suchen = 1 Aufruf');
  await sp.search('song a'); // andere Schreibweise, gleicher Schluessel
  assert.equal(calls.filter((x) => x.url.includes('/v1/search')).length, 1, 'Cache');
  const t = await sp.getTrack(ID2);
  assert.equal(t.title, 'Song B');
  assert.equal(calls.length, 1, 'getTrack nach der Suche braucht keinen weiteren Aufruf');
  assert.ok(governor.stats.coalesced >= 4 && governor.stats.cacheHits >= 2);
});

test('Suche: bei Spotify-Limit antwortet der Cache, ohne Cache kommt ein klarer Limit-Fehler', async () => {
  resetGov();
  handler = () => ({ status: 200, body: { tracks: { items: [track(ID1, 'Song A')] } } });
  const sp = new RealSpotify();
  await sp.search('alt');
  sp.searchCache.get([...sp.searchCache.keys()][0]).ts = 0; // abgelaufen
  handler = () => ({ status: 429, body: {}, headers: { 'Retry-After': '7' } });
  const stale = await sp.search('alt');
  assert.equal(stale[0].title, 'Song A', 'abgelaufene Treffer statt Fehler');
  assert.ok(governor.pausedMs() >= 7000);
  const err = await sp.search('ganz neu').catch((e) => e);
  assert.ok(err instanceof RateLimitError, 'waehrend der Pause keine weiteren Anfragen');
  assert.equal(calls.filter((x) => x.url.includes('/v1/search')).length, 2, 'nur der 429-Versuch ging raus, danach Ruhe');
  assert.equal(sp.health().ok, null);
  assert.match(sp.health().detail, /Pause/);
});

test('Player: Status wird nicht staendig abgefragt, Steuerbefehle uebergehen die Ruhe nicht blind', async () => {
  resetGov();
  handler = (url) => (url.endsWith('/me/player') ? { status: 200, body: { is_playing: true, progress_ms: 30000, item: { uri: 'u1', name: 'X', duration_ms: 200000, artists: [{ name: 'A' }] } } } : { status: 204, body: null });
  const pl = new RealPlayer(1);
  for (let i = 0; i < 10; i++) await pl.poll(); // 10 Ticks hintereinander
  assert.equal(calls.filter((x) => x.url.endsWith('/me/player')).length, 1, 'mitten im Song: eine Abfrage statt zehn');
  assert.equal(pl.status().playing, true);
  // Songende naht -> haeufiger, aber nie mehr als ~1 pro Sekunde
  handler = () => ({ status: 200, body: { is_playing: true, progress_ms: 190000, item: { uri: 'u1', name: 'X', duration_ms: 200000, artists: [{ name: 'A' }] } } });
  pl.nextPollAt = 0; await pl.poll();
  assert.ok(pl._interval() <= 1500);
});

test('Player: bei 429 bleibt der letzte Stand, der Player gilt nicht als getrennt', async () => {
  resetGov();
  handler = () => ({ status: 200, body: { is_playing: true, progress_ms: 1000, item: { uri: 'u1', name: 'X', duration_ms: 200000, artists: [{ name: 'A' }] } } });
  const pl = new RealPlayer(1);
  await pl.poll();
  handler = () => ({ status: 429, body: {}, headers: { 'Retry-After': '3' } });
  pl.nextPollAt = 0; await pl.poll();
  assert.equal(pl.status().connected, true);
  assert.equal(pl.limited, true);
  assert.ok(pl.nextPollAt > Date.now() + 2000);
});

test('Steuerbefehle (Play) werden nach 429 automatisch wiederholt', async () => {
  resetGov();
  let n = 0;
  handler = () => (++n === 1 ? { status: 429, body: {}, headers: { 'Retry-After': '0' } } : { status: 204, body: null });
  const realSleep = governor.sleep; governor.sleep = async () => { governor.pausedUntil = 0; };
  try {
    const pl = new RealPlayer(1);
    await pl.play({ uri: 'spotify:track:x' });
    assert.equal(n, 2, 'zweiter Versuch ging durch');
  } finally { governor.sleep = realSleep; }
});
