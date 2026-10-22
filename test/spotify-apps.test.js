import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb, setSetting } from '../src/db.js';
import { loadSettings, settings, applyPatch, publicSettings, setPlayerToken, spotifyApps, spotifyApp } from '../src/settings.js';
import { encrypt } from '../src/security.js';
import { RealSpotify, RealPlayer } from '../src/adapters/spotify-real.js';
import { governorFor } from '../src/adapters/spotify-governor.js';

const realFetch = globalThis.fetch;
const calls = [];
const ID = 'c'.repeat(22);
const track = { id: ID, uri: `spotify:track:${ID}`, name: 'Song', explicit: false, duration_ms: 200000, popularity: 50, artists: [{ id: 'A'.repeat(22), name: 'X' }], album: { name: 'A', release_date: '2020' } };

test.before(() => {
  config.secret = 'test-secret-test-secret-test-secret-1234';
  config.spotifyClientId = ''; config.spotifyClientSecret = '';
  openDb(':memory:');
  // alte Einstellung mit einer einzelnen App und verbundenem Player
  setSetting('app', { spotify: { clientId: 'OLDID', clientSecret: encrypt('oldsecret'), players: { 1: { refreshToken: encrypt('rt1'), user: 'u' } } } });
  loadSettings();
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const auth = String(opts.headers?.Authorization || '');
    if (url.includes('/api/token')) {
      const id = Buffer.from(auth.replace('Basic ', ''), 'base64').toString().split(':')[0];
      calls.push({ kind: 'token', id, grant: new URLSearchParams(opts.body).get('grant_type') });
      return new Response(JSON.stringify({ access_token: `tok-${id}`, expires_in: 3600 }), { status: 200 });
    }
    calls.push({ kind: 'api', url, token: auth.replace('Bearer ', '') });
    if (url.includes('/v1/search')) {
      if (auth === 'Bearer tok-AAA') return new Response('{}', { status: 429, headers: { 'Retry-After': '9' } });
      return new Response(JSON.stringify({ tracks: { items: [track] } }), { status: 200 });
    }
    return new Response(null, { status: 204 });
  };
});
test.after(() => { globalThis.fetch = realFetch; });

test('Alte Einzel-App wird zur ersten App der Liste, der verbundene Player gehoert zu ihr', () => {
  const sp = settings().spotify;
  assert.equal(sp.apps.length, 1); assert.equal(sp.apps[0].id, 'main'); assert.equal(sp.apps[0].clientId, 'OLDID');
  assert.equal(sp.clientId, ''); assert.equal(sp.players[1].appId, 'main');
  assert.equal(spotifyApp('main', config).clientSecret, 'oldsecret');
  assert.equal(publicSettings().spotify.apps[0].clientSecret, '***');
});

test('Mehrere Apps: speichern, Geheimnisse behalten, Player der entfernten/geaenderten App wird getrennt', () => {
  applyPatch({ spotify: { apps: [{ id: 'main', name: 'Haupt', clientId: 'AAA' }, { name: 'Zweite', clientId: 'BBB', clientSecret: 'sec-b' }] } }, { allow: ['spotify'] });
  let sp = settings().spotify;
  assert.equal(sp.apps.length, 2); assert.match(sp.apps[1].id, /^app-/);
  assert.equal(spotifyApp('main', config).clientSecret, 'oldsecret', 'Secret bleibt ohne neue Eingabe');
  assert.equal(sp.players[1].refreshToken, '', 'Client-ID der App geaendert -> Player-Token gehoert nicht mehr dazu');
  setPlayerToken(1, 'rt-a', 'ua', 'main');
  setPlayerToken(2, 'rt-b', 'ub', sp.apps[1].id);
  assert.equal(new RealPlayer(2).app.clientId, 'BBB');
  // App 2 entfernen -> Player 2 getrennt, Player 1 bleibt
  applyPatch({ spotify: { apps: [{ id: 'main', name: 'Haupt', clientId: 'AAA' }, sp.apps[1], { name: 'Dritte', clientId: 'CCC', clientSecret: 'sec-c', search: true }].map((a) => ({ ...a, clientSecret: a.clientSecret === sp.apps[1].clientSecret ? '' : a.clientSecret })) } }, { allow: ['spotify'] });
  sp = settings().spotify;
  assert.equal(sp.apps.length, 3);
  assert.equal(sp.players[2].appId, sp.apps[1].id, 'unveraenderte App: Player bleibt verbunden');
  applyPatch({ spotify: { apps: [sp.apps[0], sp.apps[2]].map((a) => ({ id: a.id, name: a.name, clientId: a.clientId, search: a.search })) } }, { allow: ['spotify'] });
  sp = settings().spotify;
  assert.equal(sp.apps.length, 2);
  assert.equal(sp.players[2].refreshToken, ''); assert.equal(sp.players[1].appId, 'main');
  assert.deepEqual(spotifyApps(config).map((a) => a.clientId), ['AAA', 'CCC']);
});

test('Suche verteilt sich auf die Apps und springt bei 429 auf die naechste; Player nutzt seine eigene App', async () => {
  calls.length = 0;
  for (const id of spotifyApps(config).map((a) => a.id)) { const g = governorFor(id); g.stamps = []; g.pausedUntil = 0; }
  const sp = new RealSpotify();
  const list = await sp.search('irgendwas');
  assert.equal(list[0].title, 'Song');
  const searches = calls.filter((c) => c.kind === 'api' && c.url.includes('/v1/search'));
  assert.deepEqual(searches.map((c) => c.token), ['tok-AAA', 'tok-CCC'], 'erst App A (429), dann App C');
  assert.ok(governorFor('main').pausedMs() > 8000, 'App A ruht');
  // naechste Suche geht direkt an die freie App
  calls.length = 0;
  await sp.search('noch was');
  assert.deepEqual(calls.filter((c) => c.kind === 'api').map((c) => c.token), ['tok-CCC']);
  // nur-Player-App wird nicht fuer die Suche genommen
  applyPatch({ spotify: { apps: settings().spotify.apps.map((a) => ({ id: a.id, name: a.name, clientId: a.clientId, search: a.clientId === 'AAA' })) } }, { allow: ['spotify'] });
  const sp2 = new RealSpotify();
  calls.length = 0;
  await assert.rejects(() => sp2.search('dritte suche'), /Limit/);
  assert.equal(calls.filter((c) => c.kind === 'api').length, 0, 'App A ruht, App C ist nur fuer Player – keine Anfrage');
  // Player 1 (App main) holt seinen Token ueber App A
  calls.length = 0;
  const pl = new RealPlayer(1);
  await pl.setVolume(55);
  assert.equal(calls.find((c) => c.kind === 'token').id, 'AAA');
  assert.ok(calls.some((c) => c.kind === 'api' && c.url.includes('/me/player/volume') && c.url.includes('volume_percent=55')));
  assert.equal(pl.volume, 55);
});

test('.env-App: verbundener Player zieht zur gleichen Client-ID in der Liste um, sonst wird er getrennt', () => {
  config.spotifyClientId = 'ENVID'; config.spotifyClientSecret = 'envsec';
  try {
    const keep = () => settings().spotify.apps.map((a) => ({ id: a.id, name: a.name, clientId: a.clientId, search: a.search }));
    setPlayerToken(1, 'rt-env', 'u', 'env');
    applyPatch({ spotify: { apps: [...keep(), { name: 'Env', clientId: 'ENVID', clientSecret: 'envsec' }] } }, { allow: ['spotify'] });
    let sp = settings().spotify;
    const envApp = sp.apps.find((a) => a.clientId === 'ENVID');
    assert.equal(sp.players[1].appId, envApp.id); assert.ok(sp.players[1].refreshToken);
    setPlayerToken(2, 'rt-env2', 'u2', 'env');
    applyPatch({ spotify: { apps: keep().filter((a) => a.clientId !== 'ENVID') } }, { allow: ['spotify'] });
    sp = settings().spotify;
    assert.equal(sp.players[1].refreshToken, '', 'App entfernt -> getrennt');
    assert.equal(sp.players[2].refreshToken, '', 'keine passende App -> getrennt');
  } finally { config.spotifyClientId = ''; config.spotifyClientSecret = ''; }
});
