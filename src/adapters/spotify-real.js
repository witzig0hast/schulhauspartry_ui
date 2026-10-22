import { config } from '../config.js';
import { settings, spotifyApps, spotifyApp, playerRefreshToken } from '../settings.js';
import { governor, governorFor, RateLimitError } from './spotify-governor.js';
import { cacheGet, cacheGetStale, cacheSet } from '../apicache.js';
import * as L from '../log.js';

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
export const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing', 'user-read-private'];

const basic = (app) => 'Basic ' + Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64');
const needApp = (appId) => {
  const app = spotifyApp(appId, config);
  if (!app) throw new Error('Keine Spotify-App eingerichtet (Admin → Verbindungen).');
  return app;
};

async function tokenRequest(params, app) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST',
    headers: { Authorization: basic(app), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Spotify-Token fehlgeschlagen (${res.status})`);
  return res.json();
}

export function authorizeUrl(state, redirectUri, appId) {
  const app = needApp(appId);
  const q = new URLSearchParams({ client_id: app.clientId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES.join(' '), state, show_dialog: 'true' });
  return { url: `${ACCOUNTS}/authorize?${q}`, appId: app.id };
}

export async function exchangeCode(code, redirectUri, appId) {
  const app = needApp(appId);
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }, app);
  const me = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => r.json());
  return { refreshToken: t.refresh_token, user: me.display_name || me.id, product: me.product, appId: app.id };
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
// Jede Anfrage laeuft durch den Regler ihrer App (Budget, Vorrang, Pause nach 429). ctx = { tokens, gov }
async function call(ctx, method, path, { body, query, cls = 'search' } = {}) {
  const { tokens, gov: governor } = ctx;
  const url = `${API}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
  const maxAttempts = cls === 'critical' ? 4 : 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await governor.acquire(cls); // unkritisch: wirft RateLimitError (Aufrufer nutzt Cache); kritisch: wartet
    let res;
    const t0 = Date.now();
    const app = ctx.name || null;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${await tokens.get()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { // Netzwerkfehler: kurz warten (mit Streuung) und noch einmal
      L.warn('spotify', 'spotify.network_error', `Spotify nicht erreichbar (${method} ${path}): ${e.cause?.code || e.message}`, { env: 'system', data: { method, path, cls, attempt, app } });
      if (attempt < maxAttempts - 1) { await governor.sleep(300 * 2 ** attempt + Math.random() * 200); continue; }
      throw e;
    }
    L.debug('spotify', 'spotify.request', `${method} ${path} → ${res.status} (${Date.now() - t0} ms)`, { env: 'system', data: { method, path, query: query || null, status: res.status, ms: Date.now() - t0, cls, attempt, app, budget: `${governor.used()}/${governor.budget}` } });
    if (res.status === 429) {
      governor.onRateLimited(Number(res.headers.get('retry-after')));
      L.warn('spotify', 'spotify.rate_limited', `Spotify-Limit erreicht – Pause ${res.headers.get('retry-after') || '?'} s${app ? ` (App „${app}“)` : ''}. Suche antwortet solange aus dem Speicher.`, { env: 'system', data: { method, path, retryAfter: res.headers.get('retry-after'), cls, app } });
      if (cls === 'critical' && attempt < maxAttempts - 1) continue; // acquire() wartet die Pause ab
      throw new RateLimitError(governor.pausedMs(), '429');
    }
    if (res.status >= 500 && attempt < maxAttempts - 1) { await governor.sleep(500 * 2 ** attempt + Math.random() * 250); continue; }
    if (res.status === 204 || res.status === 202) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      L.warn('spotify', 'spotify.error', `Spotify-Fehler ${res.status} bei ${method} ${path}${res.status === 404 && /player/.test(path) ? ' – kein aktives Wiedergabegerät?' : res.status === 403 ? ' – Premium nötig oder Funktion für diese App gesperrt' : res.status === 401 ? ' – Anmeldung abgelaufen, Konto neu verbinden' : ''}`, { env: 'system', data: { method, path, status: res.status, body: text.slice(0, 300), app } });
      const err = new Error(`Spotify ${method} ${path} -> ${res.status} ${text.slice(0, 120)}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  throw new RateLimitError(governor.pausedMs() || 1000, 'retries');
}

// Album-Cover: das Bild, das am naechsten an 300 px liegt (wird ueber /cover/<id> vom Server geladen und gemerkt)
const pickCover = (images) => {
  const list = (images || []).filter((i) => /^https:\/\/i\.scdn\.co\/image\/[A-Za-z0-9]+$/.test(i?.url || ''));
  if (!list.length) return null;
  return list.reduce((best, i) => (Math.abs((i.width || 300) - 300) < Math.abs((best.width || 300) - 300) ? i : best)).url;
};
export const mapTrack = (t) => ({
  id: t.id, uri: t.uri, title: t.name, artist: t.artists.map((a) => a.name).join(', '),
  album: t.album?.name || '', explicit: !!t.explicit, durationMs: t.duration_ms,
  artistIds: t.artists.map((a) => a.id).filter(Boolean), year: Number(String(t.album?.release_date || '').slice(0, 4)) || null,
  popularity: Number.isFinite(t.popularity) ? t.popularity : null,
  cover: pickCover(t.album?.images),
});

const SEARCH_TTL = 10 * 60 * 1000;
const TRACK_TTL = 6 * 3600 * 1000;
const CACHE_MAX = 600;
const remember = (map, key, value) => { map.set(key, value); if (map.size > CACHE_MAX) map.delete(map.keys().next().value); };

// Mehrere Apps fuer die Suche: jede hat ihr eigenes Limit. Genommen wird die App mit dem meisten Spielraum;
// ist sie am Limit (oder meldet Spotify 429), springt die naechste ein.
class SearchPool {
  constructor() { this.sources = new Map(); }
  list() {
    const apps = spotifyApps(config);
    const use = apps.filter((a) => a.search).length ? apps.filter((a) => a.search) : apps;
    return use.map((a) => {
      const key = `${a.clientId}:${a.clientSecret}`;
      let src = this.sources.get(a.id);
      if (!src || src.key !== key) {
        src = { id: a.id, name: a.name, key, gov: governorFor(a.id), tokens: new TokenSource(() => tokenRequest({ grant_type: 'client_credentials' }, a)) };
        this.sources.set(a.id, src);
      }
      return src;
    });
  }
  ordered() {
    const load = (s) => (s.gov.pausedMs() > 0 ? 2 + s.gov.pausedMs() / 1e6 : s.gov.used() / s.gov.budget);
    return this.list().sort((a, b) => load(a) - load(b));
  }
  async call(method, path, opts) {
    const list = this.ordered();
    if (!list.length) throw new Error('Keine Spotify-App eingerichtet (Admin → Verbindungen).');
    let limitErr = null;
    for (const src of list) {
      try { return await call(src, method, path, opts); } catch (e) {
        if (!(e instanceof RateLimitError)) throw e;
        if (!limitErr || e.retryAfterMs < limitErr.retryAfterMs) limitErr = e;
      }
    }
    throw limitErr;
  }
  pausedMs() { const l = this.list(); return l.length ? Math.min(...l.map((x) => x.gov.pausedMs())) : 0; }
}

// Suche und Track-Lookup laufen ueber die App-Credentials (Client Credentials), ohne Gast-Login.
// Wenige API-Aufrufe: Ergebnisse werden gemerkt, gleiche Anfragen zusammengefasst, Suchtreffer fuettern den Track-Cache
// (der anschliessende Wunsch braucht dann keinen weiteren Aufruf), und bei Spotify-Limit antwortet der Cache.
export class RealSpotify {
  constructor() {
    this.kind = 'real';
    this.pool = new SearchPool();
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
    const stored = cacheGet('search', key);   // dauerhaft gemerkt (auch nach Neustart)
    if (stored) { governor.stats.cacheHits++; remember(this.searchCache, key, { ts: Date.now(), list: stored }); return stored; }
    return this._once(key, async () => {
      try {
        const r = await this.pool.call('GET', '/search', { query: { q, type: 'track', limit: String(limit), market: 'DE' }, cls: 'search' });
        const list = r.tracks.items.map(mapTrack);
        remember(this.searchCache, key, { ts: Date.now(), list });
        cacheSet('search', key, list);
        for (const t of list) { remember(this.trackCache, t.id, { ts: Date.now(), track: t }); cacheSet('track', t.id, t); }
        this.lastOk = Date.now(); this.lastError = null;
        return list;
      } catch (e) {
        if (e instanceof RateLimitError) { const old = hit?.list || cacheGetStale('search', key); if (old) return old; throw e; } // abgelaufene Treffer sind besser als keine
        this.lastError = e.message; throw e;
      }
    });
  }
  async getTrack(id) {
    if (!/^[A-Za-z0-9]{22}$/.test(id)) return null;
    const hit = this.trackCache.get(id);
    if (hit && Date.now() - hit.ts < TRACK_TTL) { governor.stats.cacheHits++; return hit.track; }
    const stored = cacheGet('track', id);
    if (stored) { governor.stats.cacheHits++; remember(this.trackCache, id, { ts: Date.now(), track: stored }); return stored; }
    return this._once(`t:${id}`, async () => {
      try {
        const track = mapTrack(await this.pool.call('GET', `/tracks/${id}`, { query: { market: 'DE' }, cls: 'search' }));
        remember(this.trackCache, id, { ts: Date.now(), track });
        cacheSet('track', id, track);
        return track;
      } catch (e) {
        if (e instanceof RateLimitError) { const old = hit?.track || cacheGetStale('track', id); if (old) return old; }
        if (e.status === 404 || e.status === 400) return null;
        throw e;
      }
    });
  }
  // Genres gehoeren bei Spotify zum Interpreten. Gemerkt und gebuendelt (ein Aufruf fuer alle unbekannten Interpreten);
  // Fehler/Limit -> leer, nie blockierend.
  async getGenres(track) {
    const ids = [...new Set(track.artistIds || [])].filter((id) => /^[A-Za-z0-9]{22}$/.test(id)).slice(0, 5);
    for (const id of ids) if (!this.genreCache.has(id)) { const g = cacheGet('artist', id); if (g) remember(this.genreCache, id, g); }
    const missing = ids.filter((id) => !this.genreCache.has(id));
    if (missing.length) {
      try {
        const r = await this.pool.call('GET', '/artists', { query: { ids: missing.join(',') }, cls: 'search' });
        for (const a of r.artists || []) if (a) { remember(this.genreCache, a.id, a.genres || []); cacheSet('artist', a.id, a.genres || []); }
        this.genresOk = true;
      } catch (e) { if (!(e instanceof RateLimitError)) { this.genresOk = false; this.genreError = e.message; } }
    }
    return [...new Set(ids.flatMap((id) => this.genreCache.get(id) || []))];
  }
  // Fueller-Playlist (gemerkt, hoechstens 300 Songs)
  async getPlaylistTracks(id) {
    if (!/^[A-Za-z0-9]{22}$/.test(id || '')) return [];
    this.playlistCache ??= new Map();
    const hit = this.playlistCache.get(id);
    if (hit && Date.now() - hit.ts < 30 * 60000) { governor.stats.cacheHits++; return hit.list; }
    const stored = cacheGet('playlist', id);
    if (stored) { governor.stats.cacheHits++; remember(this.playlistCache, id, { ts: Date.now(), list: stored }); return stored; }
    return this._once(`p:${id}`, async () => {
      try {
        const list = [];
        let path = `/playlists/${id}/tracks`, query = { limit: '100', market: 'DE', fields: 'items(track(id,uri,name,explicit,duration_ms,popularity,artists(id,name),album(name,release_date,images))),next' };
        for (let page = 0; page < 3 && path; page++) {
          const r = await this.pool.call('GET', path, { query, cls: 'search' });
          for (const it of r.items || []) if (it?.track?.id && it.track.uri?.startsWith('spotify:track:')) list.push(mapTrack(it.track));
          path = r.next ? r.next.replace(API, '') .split('?')[0] : null; query = r.next ? Object.fromEntries(new URL(r.next).searchParams) : undefined;
        }
        remember(this.playlistCache, id, { ts: Date.now(), list });
        cacheSet('playlist', id, list);
        return list;
      } catch (e) { if (e instanceof RateLimitError && hit) return hit.list; this.lastError = e.status === 403 || e.status === 404 ? `Playlist nicht lesbar (${e.status})` : e.message; return hit?.list || []; }
    });
  }
  // Intro/Outro aus der Audioanalyse; fuer neuere Spotify-Apps ist diese API oft gesperrt -> dann null (feste Vorlaufzeit gilt)
  async getTrackMeta(track) {
    try {
      const a = await this.pool.call('GET', `/audio-analysis/${track.id}`, { cls: 'search' });
      const fadeOut = a?.track?.start_of_fade_out, sections = a?.sections || [];
      const intro = sections.length > 1 ? sections[1].start : a?.track?.end_of_fade_in;
      return { introMs: Number.isFinite(intro) ? Math.round(intro * 1000) : null, outroMs: Number.isFinite(fadeOut) ? Math.round(fadeOut * 1000) : null, src: 'spotify' };
    } catch (e) { if (e instanceof RateLimitError) throw e; return null; }
  }
  health() {
    const paused = this.pool.pausedMs();
    if (paused > 0) return { ok: null, detail: `Spotify-Limit erreicht – Pause ${Math.ceil(paused / 1000)} s (Cache übernimmt)` };
    if (this.lastError) return { ok: false, detail: this.lastError };
    const l = this.pool.list();
    const used = l.reduce((a, x) => a + x.gov.used(), 0), budget = l.reduce((a, x) => a + x.gov.budget, 0);
    return { ok: true, detail: this.genresOk === false ? 'Spotify-Suche (Genres nicht verfügbar)' : `Spotify-Suche · ${used}/${budget} Anfragen/30 s${l.length > 1 ? ` · ${l.length} Apps` : ''}` };
  }
}

export class RealPlayer {
  constructor(n) {
    this.kind = 'real'; this.n = n;
    // Der Player spricht immer ueber die App, mit der er verbunden wurde (Token gehoert zu ihr)
    this.app = spotifyApp(settings().spotify.players[n].appId, config);
    this.tokens = new TokenSource(async () => {
      const rt = playerRefreshToken(n);
      if (!rt) throw new Error(`Player ${n} nicht verbunden`);
      if (!this.app) throw new Error(`Player ${n}: die zugehörige Spotify-App fehlt – neu verbinden`);
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: rt }, this.app);
    });
    this.ctx = { tokens: this.tokens, gov: governorFor(this.app?.id), name: this.app ? `${this.app.name} · Player ${n}` : `Player ${n}` };
    this.volume = null;
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
    await call(this.ctx, 'PUT', '/me/player/play', { body: { uris: [track.uri] }, query: this._q(), cls: 'critical' });
    this.boost();
  }
  // Playlist/Album/Kontext starten (Notfall-Playlist), optional gemischt
  async playContext(contextUri, { shuffle = false } = {}) {
    if (shuffle) await call(this.ctx, 'PUT', '/me/player/shuffle', { query: { state: 'true', ...(this.deviceId ? { device_id: this.deviceId } : {}) }, cls: 'critical' }).catch(() => {});
    await call(this.ctx, 'PUT', '/me/player/play', { body: { context_uri: contextUri }, query: this._q(), cls: 'critical' });
    this.boost();
  }
  async pause() { await call(this.ctx, 'PUT', '/me/player/pause', { query: this._q(), cls: 'critical' }); this.boost(); }
  async resume() { await call(this.ctx, 'PUT', '/me/player/play', { query: this._q(), cls: 'critical' }); this.boost(); }
  async addToQueue(track) { await call(this.ctx, 'POST', '/me/player/queue', { query: { uri: track.uri, ...(this.deviceId ? { device_id: this.deviceId } : {}) }, cls: 'critical' }); }
  // Lautstaerke am Spotify-Geraet (0-100). Manche Geraete erlauben das nicht (403) -> Fehler mit klarer Meldung
  async setVolume(pct) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    try { await call(this.ctx, 'PUT', '/me/player/volume', { query: { volume_percent: String(v), ...(this.deviceId ? { device_id: this.deviceId } : {}) }, cls: 'critical' }); }
    catch (e) { if (e.status === 403) throw new Error(`Player ${this.n}: Dieses Gerät erlaubt keine Lautstärke-Steuerung über Spotify`); throw e; }
    this.volume = v;
  }
  async seek(ms) { await call(this.ctx, 'PUT', '/me/player/seek', { query: { position_ms: String(Math.max(0, Math.round(ms))), ...(this.deviceId ? { device_id: this.deviceId } : {}) }, cls: 'critical' }); this.boost(); }
  async devices() { return (await call(this.ctx, 'GET', '/me/player/devices', { cls: 'poll' })).devices; }

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
      const s = await call(this.ctx, 'GET', '/me/player', { cls: 'poll' });
      this.error = null; this.limited = false;
      if (!s || !s.item) {
        this.cache = { ...this.cache, connected: true, playing: false, ended: !!this.cache.uri && this.cache.positionMs > 0 };
      } else {
        const ended = !s.is_playing && s.progress_ms === 0 && this.cache.uri === s.item.uri && this.cache.positionMs > s.item.duration_ms - 3000;
        if (s.item.id && s.item.uri?.startsWith('spotify:track:') && s.item.uri !== this.cache.uri && !cacheGet('track', s.item.id)) cacheSet('track', s.item.id, mapTrack(s.item));   // fuer Cover & Infos, ohne extra Anfrage
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
