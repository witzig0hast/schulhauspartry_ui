import { config } from '../config.js';
import { spotifyCredentials, playerRefreshToken } from '../settings.js';
import { governor, RateLimitError } from './spotify-governor.js';

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

// Klassen: 'critical' = Steuerbefehle (Play/Pause/Queue), 'poll' = Player-Status, 'search' = Suche/Metadaten.
// Jede Anfrage laeuft durch den gemeinsamen Regler (Budget, Vorrang, Pause nach 429).
async function call(tokens, method, path, { body, query, cls = 'search' } = {}) {
  const url = `${API}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
  const maxAttempts = cls === 'critical' ? 4 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await governor.acquire(cls); // unkritisch: wirft RateLimitError (Aufrufer nutzt Cache); kritisch: wartet
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await tokens.get()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { // Netzwerkfehler: kurz warten (mit Streuung) und noch einmal
      if (attempt < maxAttempts - 1) { await governor.sleep(300 * 2 ** attempt + Math.random() * 200); continue; }
      throw e;
    }
    if (res.status === 429) {
      governor.onRateLimited(Number(res.headers.get('retry-after')));
      if (cls === 'critical' && attempt < maxAttempts - 1) continue; // acquire() wartet die Pause ab
      throw new RateLimitError(governor.pausedMs(), '429');
    }
    if (res.status >= 500 && attempt < maxAttempts - 1) { await governor.sleep(500 * 2 ** attempt + Math.random() * 250); continue; }
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
  throw new RateLimitError(governor.pausedMs() || 1000, 'retries');
}

const mapTrack = (t) => ({
  id: t.id, uri: t.uri, title: t.name, artist: t.artists.map((a) => a.name).join(', '),
  album: t.album?.name || '', explicit: !!t.explicit, durationMs: t.duration_ms,
  artistIds: t.artists.map((a) => a.id).filter(Boolean), year: Number(String(t.album?.release_date || '').slice(0, 4)) || null,
  popularity: Number.isFinite(t.popularity) ? t.popularity : null,
});

const SEARCH_TTL = 10 * 60 * 1000;
const TRACK_TTL = 6 * 3600 * 1000;
const CACHE_MAX = 600;
const remember = (map, key, value) => { map.set(key, value); if (map.size > CACHE_MAX) map.delete(map.keys().next().value); };

// Suche und Track-Lookup laufen ueber die App-Credentials (Client Credentials), ohne Gast-Login.
// Wenige API-Aufrufe: Ergebnisse werden gemerkt, gleiche Anfragen zusammengefasst, Suchtreffer fuettern den Track-Cache
// (der anschliessende Wunsch braucht dann keinen weiteren Aufruf), und bei Spotify-Limit antwortet der Cache.
export class RealSpotify {
  constructor() {
    this.kind = 'real';
    this.tokens = new TokenSource(() => tokenRequest({ grant_type: 'client_credentials' }));
    this.lastOk = null; this.lastError = null;
    this.searchCache = new Map(); this.trackCache = new Map(); this.genreCache = new Map(); this.inflight = new Map();
  }
  _once(key, fn) {
    if (this.inflight.has(key)) { governor.stats.coalesced++; return this.inflight.get(key); }
    const p = Promise.resolve().then(fn).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
  async search(q, limit = 8) {
    const key = `s:${limit}:${String(q).toLowerCase().trim().replace(/\s+/g, ' ')}`;
    const hit = this.searchCache.get(key);
    if (hit && Date.now() - hit.ts < SEARCH_TTL) { governor.stats.cacheHits++; return hit.list; }
    return this._once(key, async () => {
      try {
        const r = await call(this.tokens, 'GET', '/search', { query: { q, type: 'track', limit: String(limit), market: 'DE' }, cls: 'search' });
        const list = r.tracks.items.map(mapTrack);
        remember(this.searchCache, key, { ts: Date.now(), list });
        for (const t of list) remember(this.trackCache, t.id, { ts: Date.now(), track: t });
        this.lastOk = Date.now(); this.lastError = null;
        return list;
      } catch (e) {
        if (e instanceof RateLimitError) { if (hit) return hit.list; throw e; } // abgelaufene Treffer sind besser als keine
        this.lastError = e.message; throw e;
      }
    });
  }
  async getTrack(id) {
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
    const hit = this.trackCache.get(id);
    if (hit && Date.now() - hit.ts < TRACK_TTL) { governor.stats.cacheHits++; return hit.track; }
    return this._once(`t:${id}`, async () => {
      try {
        const track = mapTrack(await call(this.tokens, 'GET', `/tracks/${id}`, { query: { market: 'DE' }, cls: 'search' }));
        remember(this.trackCache, id, { ts: Date.now(), track });
        return track;
      } catch (e) {
        if (e instanceof RateLimitError && hit) return hit.track;
        if (e.status === 404 || e.status === 400) return null;
        throw e;
      }
    });
  }
  // Genres gehoeren bei Spotify zum Interpreten. Gemerkt und gebuendelt (ein Aufruf fuer alle unbekannten Interpreten);
  // Fehler/Limit -> leer, nie blockierend.
  async getGenres(track) {
    const ids = [...new Set(track.artistIds || [])].filter((id) => /^[A-Za-z0-9]{22}$/.test(id)).slice(0, 5);
    const missing = ids.filter((id) => !this.genreCache.has(id));
    if (missing.length) {
      try {
        const r = await call(this.tokens, 'GET', '/artists', { query: { ids: missing.join(',') }, cls: 'search' });
        for (const a of r.artists || []) if (a) remember(this.genreCache, a.id, a.genres || []);
        this.genresOk = true;
      } catch (e) { if (!(e instanceof RateLimitError)) { this.genresOk = false; this.genreError = e.message; } }
    }
    return [...new Set(ids.flatMap((id) => this.genreCache.get(id) || []))];
  }
  health() {
    const paused = governor.pausedMs();
    if (paused > 0) return { ok: null, detail: `Spotify-Limit erreicht – Pause ${Math.ceil(paused / 1000)} s (Cache übernimmt)` };
    if (this.lastError) return { ok: false, detail: this.lastError };
    return { ok: true, detail: this.genresOk === false ? 'Spotify-Suche (Genres nicht verfügbar)' : `Spotify-Suche · ${governor.used()}/${governor.budget} Anfragen/30 s` };
  }
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
    this.nextPollAt = 0; this.fastUntil = 0; this.limited = false;
  }
  setDevice(id) { this.deviceId = id || ''; }
  _q() { return this.deviceId ? { device_id: this.deviceId } : undefined; }
  // Nach einem Befehl kurz haeufiger nachsehen (damit die UI schnell den neuen Zustand zeigt)
  boost(ms = 6000) { this.fastUntil = Date.now() + ms; this.nextPollAt = Math.min(this.nextPollAt || Infinity, Date.now() + 800); }
  async play(track) {
    this.expectedUri = track.uri;
    await call(this.tokens, 'PUT', '/me/player/play', { body: { uris: [track.uri] }, query: this._q(), cls: 'critical' });
    this.boost();
  }
  async pause() { await call(this.tokens, 'PUT', '/me/player/pause', { query: this._q(), cls: 'critical' }); this.boost(); }
  async resume() { await call(this.tokens, 'PUT', '/me/player/play', { query: this._q(), cls: 'critical' }); this.boost(); }
  async addToQueue(track) { await call(this.tokens, 'POST', '/me/player/queue', { query: { uri: track.uri, ...(this.deviceId ? { device_id: this.deviceId } : {}) }, cls: 'critical' }); }
  async devices() { return (await call(this.tokens, 'GET', '/me/player/devices', { cls: 'poll' })).devices; }

  // Wie oft muss der Status wirklich abgefragt werden? Die Position rechnen wir zwischendurch selbst hoch.
  _interval() {
    const c = this.cache;
    if (!c.playing) return 8000;                       // Pause/leer: selten
    if (Date.now() < this.fastUntil) return 1000;      // gerade ein Befehl / Crossfade
    const remaining = c.durationMs - this.status().positionMs;
    if (remaining <= 45000) return 1500;               // Songende naht (Auto-Crossfade braucht genaue Werte)
    return 6000;                                       // mitten im Song: Hochrechnen genuegt
  }
  async poll() {
    const now = Date.now();
    if (now < this.nextPollAt) return;
    try {
      const s = await call(this.tokens, 'GET', '/me/player', { cls: 'poll' });
      this.error = null; this.limited = false;
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
      this.nextPollAt = Date.now() + this._interval();
    } catch (e) {
      if (e instanceof RateLimitError) { // Limit: letzten Stand behalten (wird hochgerechnet), spaeter wieder fragen
        this.limited = true; this.nextPollAt = now + Math.max(1000, e.retryAfterMs);
        return;
      }
      this.error = e.message; this.cache = { ...this.cache, connected: false }; this.nextPollAt = now + 3000;
    }
  }
  status() {
    // Zwischen zwei Polls Position hochrechnen
    const c = { ...this.cache };
    if (c.playing) c.positionMs = Math.min(c.durationMs, c.positionMs + (Date.now() - this.cacheTs));
    return c;
  }
}
