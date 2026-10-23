import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, Client } from './helpers.js';
import { config } from '../src/config.js';
import { settings } from '../src/settings.js';

// Spotify-Login: Fehler werden verstaendlich angezeigt und protokolliert statt pauschal "502"
test('Spotify verbinden: Ursache bei Fehlern sichtbar, Erfolg speichert das Konto', async () => {
  config.publicUrl = 'https://party.example'; config.spotifyClientId = 'cid'; config.spotifyClientSecret = 'sec';
  const ctx = await startTestApp();
  const realFetch = globalThis.fetch;
  let token = { status: 400, body: { error: 'invalid_client', error_description: 'Invalid client secret' } }, me = { status: 200, body: { id: 'dj', display_name: 'DJ Konto', product: 'premium' } };
  globalThis.fetch = async (url, opts) => {
    url = String(url);
    if (url.includes('accounts.spotify.com/api/token')) return new Response(JSON.stringify(token.body), { status: token.status });
    if (url.includes('api.spotify.com/v1/me')) return new Response(JSON.stringify(me.body), { status: me.status });
    return realFetch(url, opts);
  };
  try {
    const admin = new Client(ctx.base); await admin.post('/api/login', { secret: 'super-geheimes-passwort-123' });
    const start = async () => new URL((await admin.post('/api/admin/spotify/connect', { player: 1 })).json.url).searchParams.get('state');
    const cb = (state, code = 'c0de') => admin.get(`/api/admin/spotify/callback?code=${code}&state=${state}`);

    let r = await cb(await start());
    assert.equal(r.status, 400); assert.match(r.text, /Client-Secret/);
    r = await cb('unbekannt');
    assert.equal(r.status, 400); assert.match(r.text, /abgelaufene Anfrage/);
    token = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid redirect URI' } };
    assert.match((await cb(await start())).text, /Rückkehr-Adresse/);
    token = { status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } };
    me = { status: 403, body: { error: { status: 403, message: 'Check settings on developer.spotify.com/dashboard, the user may not be registered.' } } };
    assert.match((await cb(await start())).text, /User Management/);
    r = await admin.get(`/api/admin/spotify/callback?error=access_denied&state=${await start()}`);
    assert.match(r.text, /access_denied/);
    assert.ok(!r.text.includes('<script'), 'keine Skripte auf der Fehlerseite');

    me = { status: 200, body: { id: 'dj', display_name: 'DJ Konto', product: 'premium' } };
    r = await cb(await start());
    assert.equal(r.status, 302); assert.equal(settings().spotify.players[1].user, 'DJ Konto (premium)');

    const logs = (await admin.get('/api/logs?cats=spotify')).json.logs;
    const fails = logs.filter((e) => e.event === 'spotify.connect_failed');
    assert.equal(fails.length, 5);
    assert.ok(fails.some((e) => e.data.spotify?.error === 'invalid_client' && e.data.redirectUri === 'https://party.example/api/admin/spotify/callback'));
    assert.ok(logs.some((e) => e.event === 'spotify.connected'));
    assert.ok(!JSON.stringify(logs).includes('c0de'), 'Anmelde-Code landet nicht im Protokoll');
  } finally { globalThis.fetch = realFetch; config.publicUrl = ''; await ctx.close(); }
});
