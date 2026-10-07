import { config } from '../config.js';
import { spotifyCredentials, playerRefreshToken } from '../settings.js';

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
export const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing', 'user-read-private'];

const basic = () => {
  const { clientId, clientSecret } = spotifyCredentials(config);
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
};

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Spotify-Token fehlgeschlagen (${res.status})`);
  return res.json();
}

export function authorizeUrl(state, redirectUri) {
  const { clientId } = spotifyCredentials(config);
  const q = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES.join(' '), state, show_dialog: 'true' });
  return `${ACCOUNTS}/authorize?${q}`;
}

export async function exchangeCode(code, redirectUri) {
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const me = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json());
  return { refreshToken: t.refresh_token, user: me.display_name || me.id, product: me.product };
}

class TokenSource {
  constructor(fetchToken) { this.fetchToken = fetchToken; this.token = null; this.exp = 0; }
  async get() {
    if (this.token && Date.now() < this.exp - 30000) return this.token;
    const t = await this.fetchToken();
    this.token = t.access_token;
    this.exp = Date.now() + t.expires_in * 1000;
    return this.token;
  }
}

async function call(tokens, method, path, { body, query } = {}) {
  const url = `${API}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await tokens.get()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 1) * 1000));
      continue;
    }
    if (res.status === 204 || res.status === 202) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Spotify ${method} ${path} -> ${res.status} ${text.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

const mapTrack = (t) => ({
  id: t.id, uri: t.uri, title: t.name, artist: t.artists.map((a) => a.name).join(', '),
  album: t.album?.name || '', explicit: !!t.explicit, durationMs: t.duration_ms,
  artistIds: t.artists.map((a) => a.id).filter(Boolean), year: Number(String(t.album?.release_date || '').slice(0, 4)) || null,
  popularity: Number.isFinite(t.popularity) ? t.popularity : null,
});

// Suche und Track-Lookup laufen ueber die App-Credentials (Client Credentials), ohne Gast-Login.
export class RealSpotify {
  constructor() {
    this.kind = 'real';
    this.tokens = new TokenSource(() => tokenRequest({ grant_type: 'client_credentials' }));
    this.lastOk = null; this.lastError = null;
  }
  async search(q, limit = 8) {
    try {
      const r = await call(this.tokens, 'GET', '/search', { query: { q, type: 'track', limit: String(limit), market: 'DE' } });
      this.lastOk = Date.now(); this.lastError = null;
      return r.tracks.items.map(mapTrack);
    } catch (e) { this.lastError = e.message; throw e; }
  }
  async getTrack(id) {
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
    try { return mapTrack(await call(this.tokens, 'GET', `/tracks/${id}`, { query: { market: 'DE' } })); }
    catch (e) { if (e.status === 404 || e.status === 400) return null; throw e; }
  }
  // Genres gehoeren bei Spotify zum Interpreten. Fehler (z. B. eingeschraenkte API) -> leer, nie blockierend.
  async getGenres(track) {
    this.genreCache ??= new Map();
    const ids = (track.artistIds || []).slice(0, 5);
    const out = new Set();
    for (const id of ids) {
      if (!/^[A-Za-z0-9]{22}$/.test(id)) continue;
      let g = this.genreCache.get(id);
      if (!g) {
        try { g = (await call(this.tokens, 'GET', `/artists/${id}`)).genres || []; this.genreCache.set(id, g); this.genresOk = true; }
        catch (e) { this.genresOk = false; this.genreError = e.message; g = []; }
      }
      g.forEach((x) => out.add(x));
    }
    return [...out];
  }
  health() { return this.lastError ? { ok: false, detail: this.lastError } : { ok: true, detail: this.genresOk === false ? 'Spotify-Suche (Genres nicht verfügbar)' : 'Spotify-Suche' }; }
}

export class RealPlayer {
  constructor(n) {
    this.kind = 'real'; this.n = n;
    this.tokens = new TokenSource(async () => {
      const rt = playerRefreshToken(n);
      if (!rt) throw new Error(`Player ${n} nicht verbunden`);
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: rt });
    });
    this.cache = { connected: false, playing: false, ended: false, uri: null, title: null, artist: null, positionMs: 0, durationMs: 0 };
    this.cacheTs = 0; this.error = null; this.deviceId = '';
    this.expectedUri = null;
  }
  setDevice(id) { this.deviceId = id || ''; }
  _q() { return this.deviceId ? { device_id: this.deviceId } : undefined; }
  async play(track) {
    this.expectedUri = track.uri;
    await call(this.tokens, 'PUT', '/me/player/play', { body: { uris: [track.uri] }, query: this._q() });
  }
  async pause() { await call(this.tokens, 'PUT', '/me/player/pause', { query: this._q() }); }
  async resume() { await call(this.tokens, 'PUT', '/me/player/play', { query: this._q() }); }
  async addToQueue(track) { await call(this.tokens, 'POST', '/me/player/queue', { query: { uri: track.uri, ...(this.deviceId ? { device_id: this.deviceId } : {}) } }); }
  async devices() { return (await call(this.tokens, 'GET', '/me/player/devices')).devices; }
  async poll() {
    try {
      const s = await call(this.tokens, 'GET', '/me/player');
      this.error = null;
      if (!s || !s.item) {
        this.cache = { ...this.cache, connected: true, playing: false, ended: !!this.cache.uri && this.cache.positionMs > 0 };
      } else {
        const ended = !s.is_playing && s.progress_ms === 0 && this.cache.uri === s.item.uri && this.cache.positionMs > s.item.duration_ms - 3000;
        this.cache = {
          connected: true, playing: s.is_playing, ended, uri: s.item.uri, title: s.item.name,
          artist: s.item.artists.map((a) => a.name).join(', '), positionMs: s.progress_ms || 0, durationMs: s.item.duration_ms,
        };
      }
      this.cacheTs = Date.now();
    } catch (e) { this.error = e.message; this.cache = { ...this.cache, connected: false }; }
  }
  status() {
    // Zwischen zwei Polls Position hochrechnen
    const c = { ...this.cache };
    if (c.playing) c.positionMs = Math.min(c.durationMs, c.positionMs + (Date.now() - this.cacheTs));
    return c;
  }
}
