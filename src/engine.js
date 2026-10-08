import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { settings, onSettingsChange, spotifyCredentials, playerRefreshToken } from './settings.js';
import { getSetting, setSetting, logEvent } from './db.js';
import * as rq from './requests.js';
import { MockSpotify, MockPlayer } from './adapters/spotify-mock.js';
import { RealSpotify, RealPlayer } from './adapters/spotify-real.js';
import { MockX32, HttpX32 } from './adapters/x32.js';
import { governor } from './adapters/spotify-governor.js';
import { maybeFill } from './filler.js';
import { applyAutoOrder } from './autoorder.js';
import { ensureMeta, getMeta } from './trackmeta.js';
import { isOn } from './features.js';
import { getDb } from './db.js';

const TICK_MS = 100;
const BROADCAST_MS = 250;
const other = (p) => (p === 1 ? 2 : 1);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function curveLevels(curve, p) {
  // p in [0,1]: liefert [fadeOutFaktor, fadeInFaktor]
  if (curve === 'linear') return [1 - p, p];
  return [Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)];
}

export class Engine extends EventEmitter {
  constructor(env, { realConnections = false } = {}) {
    super();
    this.env = env;
    this.realConnections = realConnections;
    this.gain = { 1: 1, 2: 1 };
    this.duckMul = 1;
    this.trackMul = { 1: 1, 2: 1 }; // gemerkte Lautstaerke je Song
    this.lastSent = { 1: -1, 2: -1 };
    this.current = null;
    this.ramps = {}; // player -> {from,to,start,dur,curve}
    this.crossfade = null; // {from,to,start,dur}
    this.expectedUri = { 1: null, 2: null };
    this.lastSeenUri = { 1: null, 2: null };
    this.trackIdOf = { 1: null, 2: null }; // welcher Wunsch/Song laeuft auf welchem Player
    this.lastFillCheck = 0;
    this.pendingStart = [];
    this.panicNonce = null; this.panicNonceExp = 0;
    this.x32State = { mics: [], meters: { 1: 0, 2: 0 } };
    this.x32Busy = false; this.lastX32Read = 0; this.lastPoll = 0;
    this.lastError = null; this.errors = [];
    this.state = getSetting(`engine:${env}`, { wishMode: 'open', ended: false, panic: false });
    this.buildAdapters();
    this.unsub = onSettingsChange(() => this.syncSettings());
  }

  // ----- Adapter -----
  buildAdapters() {
    const speed = () => (this.env === 'test' ? settings().test.mockSpeed : 1);
    const real = this.realConnections;
    const creds = spotifyCredentials(config);
    const hasCreds = !!(creds.clientId && creds.clientSecret);
    this.spotify = real && hasCreds ? new RealSpotify() : new MockSpotify();
    this.players = {};
    for (const p of [1, 2]) this.players[p] = real && playerRefreshToken(p) ? new RealPlayer(p) : new MockPlayer(speed);
    this.x32 = real && settings().x32.adapter === 'http' ? new HttpX32() : new MockX32();
    this.syncSettings();
  }

  setReal(flag, force = false) {
    if (!force && flag === this.realConnections) return;
    this.realConnections = flag;
    this.buildAdapters();
    this.emit('change');
  }

  syncSettings() {
    governor.setBudget(settings().spotify.apiBudget);
    for (const p of [1, 2]) this.players[p].setDevice?.(settings().spotify.players[p].deviceId);
    if (this.realConnections) {
      const wantHttp = settings().x32.adapter === 'http';
      if (wantHttp !== (this.x32.kind === 'http')) this.x32 = wantHttp ? new HttpX32() : new MockX32();
    }
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => this.fail('tick', e)), TICK_MS);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.unsub?.(); }

  fail(where, e) {
    this.lastError = `${where}: ${e.message}`;
    this.errors.unshift({ ts: Date.now(), msg: this.lastError });
    this.errors.length = Math.min(this.errors.length, 20);
    logEvent(this.env, 'error', { where, msg: e.message });
  }

  persist() { setSetting(`engine:${this.env}`, this.state); }

  // ----- Hauptschleife -----
  async tick() {
    const now = Date.now();
    const cfg = settings();

    if (now - this.lastPoll >= (this.players[1].kind === 'real' || this.players[2].kind === 'real' ? 1000 : TICK_MS)) {
      this.lastPoll = now;
      await Promise.all([1, 2].map((p) => this.players[p].poll().catch(() => {})));
      this.detectExternal();
    }
    this.runPendingStarts(now);
    this.runRamps(now);
    this.runDucking(now, cfg);
    this.maybeAutoCrossfade(now, cfg);
    this.applyLevels();
    if (now - this.lastFillCheck >= 5000) { this.lastFillCheck = now; maybeFill(this, now).then((r) => { if (r) this.afterQueueChange(); }).catch((e) => this.fail('filler', e)); }

    if (now - this.lastX32Read >= 250 && !this.x32Busy) {
      this.lastX32Read = now; this.x32Busy = true;
      const playing = { 1: this.players[1].status().playing, 2: this.players[2].status().playing };
      this.x32.readState(playing).then((s) => { this.x32State = s; }).catch(() => {}).finally(() => { this.x32Busy = false; });
    }
    if (!this.lastBroadcast || now - this.lastBroadcast >= BROADCAST_MS) {
      this.lastBroadcast = now;
      this.emit('tick');
    }
  }

  // Ein von aussen (z. B. direkt in Spotify) gestarteter Song wird uebernommen.
  detectExternal() {
    for (const p of [1, 2]) {
      const st = this.players[p].status();
      if (!st.connected || !st.playing || !st.uri) continue;
      if (this.expectedUri[p] === st.uri) { this.expectedUri[p] = null; this.lastSeenUri[p] = st.uri; continue; }
      if (this.lastSeenUri[p] !== st.uri && !this.expectedUri[p]) {
        this.lastSeenUri[p] = st.uri;
        if (this.state.panic || this.state.ended) continue;
        rq.recordExternalPlay(this.env, p, st.title, st.artist);
        if (!this.current || !this.players[this.current].status().playing) this.current = p;
        this.emit('change');
      }
    }
  }

  runPendingStarts(now) {
    const due = this.pendingStart.filter((s) => s.at <= now);
    this.pendingStart = this.pendingStart.filter((s) => s.at > now);
    for (const s of due) s.fn();
  }

  runRamps(now) {
    if (this.crossfade) {
      const cf = this.crossfade;
      const p = clamp01((now - cf.start) / (cf.dur * 1000));
      const [o, i] = curveLevels(cf.curve, p);
      this.gain[cf.from] = cf.fromStart * o;
      this.gain[cf.to] = i;
      if (p >= 1) {
        const from = cf.from;
        this.crossfade = null;
        this.players[from].pause().catch((e) => this.fail('pause', e));
        this.gain[from] = 1; // bereit fuer den naechsten Einsatz (Player ist pausiert)
        this.current = cf.to;
        this.emit('change');
      }
    }
    for (const [pl, r] of Object.entries(this.ramps)) {
      const p = clamp01((now - r.start) / (r.dur * 1000));
      const [o, i] = curveLevels(r.curve, p);
      this.gain[pl] = r.to < r.from ? r.from * o : r.from + (r.to - r.from) * i;
      if (p >= 1) {
        delete this.ramps[pl];
        this.gain[pl] = r.to;
        if (r.then) r.then();
        this.emit('change');
      }
    }
  }

  runDucking(now, cfg) {
    const micsOpen = this.x32State.mics.some((m) => m.open);
    const target = cfg.ducking.enabled && micsOpen ? Math.pow(10, cfg.ducking.db / 20) : 1;
    const dt = TICK_MS;
    if (target < this.duckMul) this.duckMul = Math.max(target, this.duckMul - (1 - target) * dt / cfg.ducking.attackMs);
    else if (target > this.duckMul) this.duckMul = Math.min(target, this.duckMul + (1 - Math.pow(10, cfg.ducking.db / 20)) * dt / cfg.ducking.releaseMs);
    this.ducking = cfg.ducking.enabled && this.duckMul < 0.995;
  }

  applyLevels() {
    for (const p of [1, 2]) {
      const cap = isOn('faderLimit') ? settings().limits.maxGain : 1;
      const amp = this.state.panic ? 0 : Math.min(cap, this.gain[p] * this.trackMul[p]) * this.duckMul;
      if (Math.abs(amp - this.lastSent[p]) < 0.002 && !(amp === 0 && this.lastSent[p] !== 0)) continue;
      this.lastSent[p] = amp;
      this.x32.setPlayerLevel(p, amp).catch((e) => this.fail('x32', e));
    }
  }

  maybeAutoCrossfade(now, cfg) {
    if (!cfg.auto.enabled || this.crossfade || this.state.panic || this.state.ended || !this.current) return;
    const st = this.players[this.current].status();
    if (!st.playing || !st.durationMs) return;
    const remaining = st.durationMs - st.positionMs;
    let lead = cfg.auto.startBeforeEndSec[this.current] * 1000;
    // Smart: den Uebergang beginnen, wenn der Song ausklingt (Outro), nicht mitten im Refrain
    const meta = cfg.auto.smartOutro && isOn('smartOutro') ? getMeta(this.trackIdOf[this.current]) : null;
    if (meta?.outro_ms && st.durationMs > meta.outro_ms) lead = Math.min(90000, Math.max(cfg.auto.crossfadeSec * 1000 + 1000, st.durationMs - meta.outro_ms + 1000));
    const braked = isOn('songLimit') && cfg.limits.maxSongSec > 0 && st.positionMs > cfg.limits.maxSongSec * 1000;
    if (remaining > lead && !braked) return;
    if (!rq.upcoming(this.env).length) return;
    const dur = Math.max(0.5, Math.min(cfg.auto.crossfadeSec, remaining / 1000));
    this.startCrossfade(dur, cfg.auto.curve, { auto: true }).catch((e) => this.fail('auto-crossfade', e));
  }

  // ----- Aktionen -----
  async startCrossfade(durSec, curve = settings().auto.curve, { auto = false } = {}) {
    if (this.state.panic) throw new Error('Not-Aus ist aktiv.');
    if (this.state.ended) throw new Error('Ende-Modus ist aktiv.');
    if (this.crossfade) throw new Error('Es läuft bereits ein Crossfade.');
    const next = rq.upcoming(this.env)[0];
    if (!next) throw new Error('Die Warteschlange ist leer.');

    const curPlaying = this.current && this.players[this.current].status().playing;
    let target = next.player || (this.current ? other(this.current) : 1);
    if (curPlaying && target === this.current) { target = other(this.current); rq.reassignPlayer(next.id, target); }

    this.expectedUri[target] = next.uri;
    this.gain[target] = 0;
    delete this.ramps[target];
    rq.markPlaying(this.env, next.id, target);
    this.trackIdOf[target] = next.trackId;
    logEvent(this.env, 'play', { player: target, title: next.title, auto });
    const track = { uri: next.uri, title: next.title, artist: next.artist, durationMs: next.durationMs };
    await this.players[target].play(track);
    this.players[this.current ?? target]?.boost?.(20000); this.players[target].boost?.(20000);

    this.afterTrackStart(target);
    const begin = () => {
      const t = Date.now();
      if (curPlaying) {
        this.crossfade = { from: this.current, to: target, start: t, dur: Math.max(0.1, durSec), curve, fromStart: this.gain[this.current] };
      } else {
        this.ramps[target] = { from: 0, to: 1, start: t, dur: Math.max(0.1, durSec), curve };
        this.current = target;
      }
      this.emit('change');
    };
    if (this.players[target].kind === 'real') this.pendingStart.push({ at: Date.now() + 600, fn: begin }); else begin();
    return { player: target, title: next.title };
  }

  // Nach jeder Aenderung der Warteschlange: automatisch sortieren (Genre-Balance/Stimmung) und Meta des naechsten Songs holen
  afterQueueChange() {
    try { applyAutoOrder(this.env, this.current); } catch (e) { this.fail('auto-order', e); }
    const next = rq.upcoming(this.env)[0];
    if (next) ensureMeta(this.spotify, { id: next.trackId }).catch(() => {});
    this.emit('change');
  }
  afterTrackStart(player) {
    const cur = this.trackIdOf[player ?? this.current ?? 1];
    if (player) {
      const g = cur && isOn('gainMemory') ? getDb().prepare('SELECT gain FROM track_gain WHERE track_id = ?').get(cur) : null;
      this.trackMul[player] = g ? g.gain : 1;
    }
    if (cur) ensureMeta(this.spotify, { id: cur }).catch(() => {});
    this.afterQueueChange();
  }

  async play(player, { startGain = 1 } = {}) {
    const st = this.players[player].status();
    if (st.uri && !st.ended) { await this.players[player].resume(); if (!this.current) this.current = player; }
    else {
      const next = rq.upcoming(this.env).find((u) => !u.player || u.player === player) || rq.upcoming(this.env)[0];
      if (!next) throw new Error('Keine Songs in der Warteschlange.');
      rq.reassignPlayer(next.id, player); // gezielt auf diesem Player starten
      this.gain[player] = startGain; delete this.ramps[player];
      this.expectedUri[player] = next.uri;
      rq.markPlaying(this.env, next.id, player);
      this.trackIdOf[player] = next.trackId;
      this.afterTrackStart(player);
      await this.players[player].play({ uri: next.uri, title: next.title, artist: next.artist, durationMs: next.durationMs });
      if (!this.current) this.current = player;
    }
    this.emit('change');
  }

  async pause(player) { await this.players[player].pause(); this.emit('change'); }

  async fadeIn(player, sec) {
    if (this.state.panic) throw new Error('Not-Aus ist aktiv.');
    const st = this.players[player].status();
    this.gain[player] = 0;
    delete this.ramps[player];
    if (!st.playing) await this.play(player, { startGain: 0 });
    this.ramps[player] = { from: 0, to: 1, start: Date.now(), dur: Math.max(0.1, sec), curve: settings().auto.curve };
    if (!this.current) this.current = player;
    this.emit('change');
  }

  fadeOut(player, sec, { pauseAfter = true } = {}) {
    const from = this.gain[player];
    this.ramps[player] = {
      from, to: 0, start: Date.now(), dur: Math.max(0.1, sec), curve: settings().auto.curve,
      then: () => { if (pauseAfter) { this.players[player].pause().catch((e) => this.fail('pause', e)); this.gain[player] = 1; } },
    };
    this.emit('change');
  }

  // Merkt sich die aktuelle Fader-Stellung fuer diesen Song (naechstes Mal startet er mit dieser Lautstaerke)
  rememberGain(player) {
    const tid = this.trackIdOf[player];
    if (!tid) throw new Error('Kein Song auf diesem Player.');
    const g = Math.max(0.1, Math.min(1, this.gain[player] * this.trackMul[player]));
    getDb().prepare('INSERT OR REPLACE INTO track_gain(track_id, gain, ts) VALUES(?,?,?)').run(tid, g, Date.now());
    this.trackMul[player] = g; this.gain[player] = 1;
    this.emit('change');
    return g;
  }

  // Pausen-Modus: Wuensche pausieren, Musik ausblenden, Hinweis fuer Gaeste und Beamer
  setPauseMode(on) {
    this.state.pauseMode = !!on;
    if (on) { this.setWishMode('paused'); for (const p of [1, 2]) if (this.players[p].status().playing) this.fadeOut(p, 4); }
    else this.setWishMode('open');
    this.persist(); this.emit('change');
  }

  setGain(player, value) { delete this.ramps[player]; this.gain[player] = clamp01(value); this.emit('change'); }

  panicArm() { this.panicNonce = Math.random().toString(36).slice(2); this.panicNonceExp = Date.now() + 5000; return this.panicNonce; }
  async panicFire(nonce) {
    if (!nonce || nonce !== this.panicNonce || Date.now() > this.panicNonceExp) throw new Error('Not-Aus nicht bestätigt (zweimal drücken).');
    this.panicNonce = null;
    this.state.panic = true; this.state.emergency = false; this.persist();
    this.crossfade = null; this.ramps = {}; this.pendingStart = [];
    await Promise.all([1, 2].map((p) => this.players[p].pause().catch((e) => this.fail('pause', e))));
    logEvent(this.env, 'panic', {});
    this.emit('panic');
    this.emit('change');
  }
  panicClear() {
    this.state.panic = false; this.persist();
    this.gain = { 1: 1, 2: 1 };
    logEvent(this.env, 'panic-clear', {});
    this.emit('change');
  }

  // Notfall-Playlist: stoppt alles, startet die eingestellte Playlist (gemischt) auf dem gewaehlten Player
  async emergencyStart() {
    const cfg = settings().emergency;
    const m = String(cfg.playlist || '').match(/playlist[/:]([A-Za-z0-9]{22})/) || String(cfg.playlist || '').match(/^([A-Za-z0-9]{22})$/);
    if (!m && this.players[cfg.player].kind === 'real') throw new Error('Keine Notfall-Playlist eingetragen (Admin → Automatik).');
    const p = cfg.player, o = other(p);
    this.crossfade = null; this.ramps = {}; this.pendingStart = [];
    this.state.panic = false; this.state.ended = false; this.state.emergency = true; this.persist();
    this.players[o].pause().catch(() => {});
    this.gain[o] = 1; this.gain[p] = 0; this.duckMul = 1;
    await this.players[p].playContext(m ? `spotify:playlist:${m[1]}` : 'mock:playlist:notfall', { shuffle: cfg.shuffle });
    this.current = p;
    const begin = () => { this.ramps[p] = { from: 0, to: 1, start: Date.now(), dur: 2, curve: 'linear' }; this.emit('change'); };
    if (this.players[p].kind === 'real') this.pendingStart.push({ at: Date.now() + 600, fn: begin }); else begin();
    logEvent(this.env, 'emergency', {});
    this.emit('emergency'); this.emit('change');
  }
  emergencyClear() { this.state.emergency = false; this.persist(); logEvent(this.env, 'emergency-clear', {}); this.emit('change'); }

  // Kurzer, leiser Test eines Players (Vorbereitungs-Seite): 8 s abspielen, dann stoppen
  async testPlayer(n) {
    if ([1, 2].some((x) => this.players[x].status().playing)) throw new Error('Es läuft gerade Musik – Test nur bei Stille.');
    const list = await this.spotify.search('a', 8).catch(() => []);
    const t = list.find((x) => x.durationMs > 60000) || list[0];
    if (!t) throw new Error('Kein Testsong gefunden (Spotify-Suche).');
    this.gain[n] = 0.12; delete this.ramps[n];
    await this.players[n].play(t);
    setTimeout(() => { this.players[n].pause().catch(() => {}); this.gain[n] = 1; this.emit('change'); }, 8000).unref?.();
    return { title: t.title, artist: t.artist };
  }

  endEvening(sec = 10) {
    this.state.ended = true; this.state.wishMode = 'closed'; this.persist();
    for (const p of [1, 2]) if (this.players[p].status().playing) this.fadeOut(p, sec);
    this.crossfade = null;
    logEvent(this.env, 'end', {});
    this.emit('change');
  }
  endClear() { this.state.ended = false; this.persist(); logEvent(this.env, 'end-clear', {}); this.emit('change'); }

  // Setzt den Abend zurueck: Wiedergabe stoppen, Zustand leeren (Daten loescht requests.resetEnv)
  resetAll() {
    this.crossfade = null; this.ramps = {}; this.pendingStart = []; this.current = null;
    this.gain = { 1: 1, 2: 1 }; this.duckMul = 1;
    this.expectedUri = { 1: null, 2: null }; this.lastSeenUri = { 1: null, 2: null };
    this.trackIdOf = { 1: null, 2: null };
    this.state = { wishMode: 'open', ended: false, panic: false, emergency: false }; this.persist();
    for (const p of [1, 2]) { this.players[p].reset?.(); this.players[p].pause().catch(() => {}); }
    this.emit('change');
  }

  setWishMode(mode) {
    if (!['open', 'paused', 'closed'].includes(mode)) throw new Error('Ungültiger Modus');
    this.state.wishMode = mode; this.persist(); this.emit('change');
  }
  get wishMode() { return this.state.wishMode; }

  nowPlaying() {
    for (const p of [this.current, other(this.current || 1)]) {
      if (!p) continue;
      const st = this.players[p].status();
      if (st.playing && st.title) return { player: p, title: st.title, artist: st.artist };
    }
    return null;
  }

  // ----- Zustand fuer die UIs -----
  connections() {
    const sp = this.spotify.health();
    const x = this.x32.health();
    const pl = (n) => {
      const s = this.players[n].status();
      const real = this.players[n].kind === 'real';
      return { ok: s.connected, detail: real ? (s.connected ? 'verbunden' : (this.players[n].error || 'nicht verbunden')) : 'simuliert' };
    };
    return {
      server: { ok: true, detail: 'läuft' },
      x32: x,
      pi: this.x32.kind === 'http' ? x : { ok: null, detail: 'nicht genutzt (Simulation)' },
      spotify: sp,
      player1: pl(1),
      player2: pl(2),
      mode: this.realConnections ? 'echte Verbindungen' : 'simuliert',
      api: this.realConnections ? governor.snapshot() : null,
    };
  }

  snapshot() {
    const players = {};
    for (const p of [1, 2]) {
      const st = this.players[p].status();
      players[p] = {
        ...st,
        remainingMs: Math.max(0, st.durationMs - st.positionMs),
        gain: this.gain[p],
        level: this.state.panic ? 0 : this.gain[p] * this.trackMul[p] * this.duckMul,
        trackMul: this.trackMul[p],
        meter: this.x32State.meters[p] || 0,
        fading: !!this.ramps[p] || (this.crossfade && (this.crossfade.from === p || this.crossfade.to === p)) || false,
      };
    }
    const cf = this.crossfade;
    const cfg = settings();
    const up = rq.upcoming(this.env);
    return {
      env: this.env,
      ts: Date.now(),
      players,
      current: this.current,
      crossfade: cf ? { from: cf.from, to: cf.to, progress: clamp01((Date.now() - cf.start) / (cf.dur * 1000)), durSec: cf.dur } : null,
      auto: cfg.auto,
      ducking: { ...cfg.ducking, active: !!this.ducking, mul: this.duckMul },
      mics: this.x32State.mics,
      wishMode: this.state.wishMode,
      ended: this.state.ended,
      panic: this.state.panic,
      emergency: !!this.state.emergency,
      pauseMode: !!this.state.pauseMode && isOn('pauseMode'),
      counts: rq.counts(this.env),
      upcoming: up.slice(0, 50),
      upcomingTotal: up.length,
      connections: this.connections(),
      errors: this.errors.slice(0, 5),
    };
  }
}
