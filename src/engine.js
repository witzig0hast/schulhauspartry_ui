import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { settings, onSettingsChange, spotifyApps, playerRefreshToken, applyPatch } from './settings.js';
import { getSetting, setSetting, logEvent } from './db.js';
import * as rq from './requests.js';
import { MockSpotify, MockPlayer } from './adapters/spotify-mock.js';
import { RealSpotify, RealPlayer } from './adapters/spotify-real.js';
import { MockX32, HttpX32, ampToFader, faderToAmp } from './adapters/x32.js';
import { governorFor, setBudgetAll } from './adapters/spotify-governor.js';
import { maybeFill, fillStart } from './filler.js';
import { autoFill, mixPlan, mixTrimDb, mixActive } from './ai.js';
import * as L from './log.js';
import { holdNotify } from './notify.js';
import { applyAutoOrder, localHHMM } from './autoorder.js';
import { ensureMeta, getMeta } from './trackmeta.js';
import { isOn } from './features.js';
import { getDb } from './db.js';

const TICK_MS = 100;
const localDay = (tz = settings().timezone) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());   // JJJJ-MM-TT
const BROADCAST_MS = 250;
const other = (p) => (p === 1 ? 2 : 1);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const trackIdOfUri = (uri) => (/^spotify:track:([A-Za-z0-9]{22})$/.exec(uri || '') || [])[1] || null;
const dbToAmp = (db) => Math.pow(10, (Number(db) || 0) / 20);

function curveLevels(curve, p) {
  // p in [0,1]: liefert [fadeOutFaktor, fadeInFaktor]
  if (curve === 'linear') return [1 - p, p];
  return [Math.cos(p * Math.PI / 2), Math.sin(p * Math.PI / 2)];
}

// Wann beginnt der Uebergang, gemessen vom Ende des Songs? (feste Vorlaufzeit oder "smart" nach dem Outro)
export function leadFor(cfg, player, durationMs, meta) {
  let lead = (cfg.auto.startBeforeEndSec[player] ?? 20) * 1000;
  if (cfg.auto.smartOutro && isOn('smartOutro') && meta?.outro_ms && durationMs > meta.outro_ms) lead = Math.min(90000, Math.max(cfg.auto.crossfadeSec * 1000 + 1000, durationMs - meta.outro_ms + 1000));
  return lead;
}

// Auslastung aller Spotify-Apps (Summe oben, einzeln in apps)
function apiSnapshot() {
  const apps = spotifyApps(config).map((a) => ({ id: a.id, name: a.name, search: a.search, ...governorFor(a.id).snapshot() }));
  if (!apps.length) return governorFor('main').snapshot();
  const sum = (k) => apps.reduce((t, a) => t + (Number(a[k]) || 0), 0);
  return { used: sum('used'), budget: sum('budget'), windowSec: apps[0].windowSec, pausedSec: Math.max(...apps.map((a) => a.pausedSec)), total: sum('total'), rejected: sum('rejected'), rate429: sum('rate429'), cacheHits: sum('cacheHits'), coalesced: sum('coalesced'), last429: Math.max(0, ...apps.map((a) => a.last429 || 0)) || null, apps };
}

export class Engine extends EventEmitter {
  constructor(env, { realConnections = false } = {}) {
    super();
    this.env = env;
    this.realConnections = realConnections;
    this.gain = { 1: 1, 2: 1 };
    this.duckMul = 1;
    this.trackMul = { 1: 1, 2: 1 }; // gemerkte Lautstaerke je Song
    this.mixTrim = { 1: null, 2: null };   // KI-Pegel-Ausgleich des laufenden Songs (dB), null = keiner
    this.lastSent = { 1: -1, 2: -1 };
    this.muted = { 1: false, 2: false };   // Kanal nach dem Ausblenden stumm geschaltet
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
    // Stumm geschaltete Kanaele ueberleben einen Neustart (sonst bliebe der Kanal beim naechsten Song stumm)
    if (this.state.mutedCh) this.muted = { 1: !!this.state.mutedCh[1], 2: !!this.state.mutedCh[2] };
    this.buildAdapters();
    this.unsub = onSettingsChange(() => this.syncSettings());
  }

  // ----- Adapter -----
  buildAdapters() {
    const speed = () => (this.env === 'test' ? settings().test.mockSpeed : (this.probeSpeed || 1));   // Generalprobe live: schneller abspielen
    const real = this.realConnections;
    const hasCreds = spotifyApps(config).length > 0;
    this.spotify = real && hasCreds ? new RealSpotify() : new MockSpotify();
    this.players = {};
    for (const p of [1, 2]) this.players[p] = real && playerRefreshToken(p) ? new RealPlayer(p) : new MockPlayer(speed);
    this.x32 = real && settings().x32.adapter === 'http' ? new HttpX32() : new MockX32();
    this.syncSettings();
  }

  setReal(flag, force = false) {
    if (this.probeHold && flag) return;   // Generalprobe live laeuft: bleibt simuliert, bis sie vorbei ist
    if (!force && flag === this.realConnections) return;
    this.realConnections = flag;
    this.buildAdapters();
    this.emit('change');
  }

  syncSettings() {
    setBudgetAll(settings().spotify.apiBudget);
    for (const p of [1, 2]) this.players[p].setDevice?.(settings().spotify.players[p].deviceId);
    if (this.realConnections) {
      const wantHttp = settings().x32.adapter === 'http';
      if (wantHttp !== (this.x32.kind === 'http')) this.x32 = wantHttp ? new HttpX32() : new MockX32();
    }
    this.syncLevels();
  }

  // Das Pult ist die Wahrheit: schiebt jemand einen Player-Fader von Hand, wird die Stellung zum neuen Grundpegel
  // (levels.playerDb). Fades, Crossfades und Ducking rechnen danach von dort aus – nichts zieht zurueck.
  // Mic-Fader: ist "Mic-Fader von der App setzen" an, wird die Stellung als Mic-Pegel uebernommen.
  // Uebernommen wird erst, wenn die Hand losgelassen hat (0,6 s Ruhe). force: alle noch nicht uebernommenen (Ende Soundcheck).
  adoptHand(moves = [], { force = false } = {}) {
    if (!moves?.length || this.state.panic || settings().x32.adoptHand === false) return;
    if (this.state.hold && !force) return;
    this.handSeen ||= {};
    const c = settings().x32.channels, lv = settings().levels, cap = isOn('faderLimit') ? settings().limits.maxGain : 1;
    const patch = {}, micDb = [...lv.micDb], changed = [];
    for (const m of moves) {
      if (!(m.seq > (this.handSeen[m.ch] || 0)) || (!force && m.ageMs < 600)) continue;
      this.handSeen[m.ch] = m.seq;
      const p = c.p1.includes(m.ch) ? 1 : c.p2.includes(m.ch) ? 2 : null;
      const hand = faderToAmp(m.v);
      if (p) {
        const rel = Math.min(cap, this.gain[p] * this.trackMul[p]) * this.duckMul;
        if (rel < 0.05 || this.muted[p] || hand <= 0) continue;   // Player steht stumm/unten: nichts zu rechnen
        const db = Math.round(Math.max(-40, Math.min(6, 20 * Math.log10(hand / rel))) * 2) / 2;
        if (db !== lv.playerDb[p]) { (patch.playerDb ||= {})[p] = db; changed.push(`Player ${p}: ${db > 0 ? '+' : ''}${String(db).replace('.', ',')} dB`); }
      } else if (lv.micControl) {
        const i = c.mics.indexOf(m.ch);
        if (i < 0 || hand <= 0) continue;
        const db = Math.round(Math.max(-60, Math.min(10, 20 * Math.log10(hand))) * 2) / 2;
        if (db !== micDb[i]) { micDb[i] = db; patch.micDb = micDb; changed.push(`${settings().x32.micNames?.[i] || `Mic ${i + 1}`}: ${String(db).replace('.', ',')} dB`); }
      }
    }
    if (!changed.length) return;
    applyPatch({ levels: patch }, { allow: ['levels'] });
    this.levelsSeen = structuredClone(settings().levels);          // nicht erneut ans Pult schicken – dort steht es ja schon
    for (const p of [1, 2]) if (patch.playerDb?.[p] != null) this.lastSent[p] = this.levelAmp(p);
    L.info('pult', 'fader.adopted', `Am Pult verstellt, von der App übernommen – ${changed.join(', ')}. Die App zieht nicht zurück; Fades und Crossfades rechnen ab jetzt von hier.`, { env: this.env, data: patch });
    this.emit('change');
  }

  // Jemand hat einen Fader der App von Hand bewegt: er bleibt dort, bis die App den Pegel das naechste Mal aendert
  logManual(list = []) {
    const prev = this.manualSeen || [];
    this.manualSeen = list;
    const fresh = list.filter((c) => !prev.includes(c));
    if (fresh.length) L.info('pult', 'fader.manual', `Fader von Hand bewegt (Kanal ${fresh.join(', ')}) – er bleibt dort, bis die App den Pegel das nächste Mal ändert (Fade, Crossfade, Ducking). Dauerhaft: Pegel-Fenster.`, { env: this.env, data: { channels: fresh } });
  }

  // Mikrofone: oeffnen als Eintrag, schliessen nur im Debug (sonst flattert das Protokoll beim Sprechen)
  logMics(mics = []) {
    const prev = this.micOpen || {};
    this.micOpen = {};
    for (const m of mics) {
      this.micOpen[m.id] = m.open;
      if (prev[m.id] !== undefined && prev[m.id] !== m.open) L.log(m.open ? 'info' : 'debug', 'pult', m.open ? 'mic.open' : 'mic.closed', `${m.name} ${m.open ? 'offen' : 'wieder stumm'}`, { env: this.env, data: { mic: m.id, name: m.name, level: Math.round((m.level || 0) * 100) / 100 } });
    }
  }

  // ----- Grundpegel (Pegel-Fenster) -----
  // Geaenderte Werte gehen sofort raus: Player-Fader ueber applyLevels, Spotify-Lautstaerke und Mic-Fader direkt.
  syncLevels() {
    const l = settings().levels;
    const prev = this.levelsSeen;
    this.levelsSeen = structuredClone(l);
    if (!prev) return;   // beim Start nichts verschicken
    if (prev.playerDb[1] !== l.playerDb[1] || prev.playerDb[2] !== l.playerDb[2]) this.lastSent = { 1: -1, 2: -1 };
    if (this.wishlist) return;
    for (const p of [1, 2]) if (prev.spotifyVol[p] !== l.spotifyVol[p]) this.applySpotifyVolume(p).catch((e) => this.fail('lautstaerke', e));
    if (l.micControl && (!prev.micControl || JSON.stringify(prev.micDb) !== JSON.stringify(l.micDb))) this.applyMicFaders().catch((e) => this.fail('mic-fader', e));
  }
  async applySpotifyVolume(p) { if (this.players[p].setVolume) await this.players[p].setVolume(settings().levels.spotifyVol[p]); }
  async applyMicFaders() {
    if (this.state.hold) return;   // System aus: die App fasst das Pult nicht an
    const l = settings().levels, chans = settings().x32.channels.mics;
    await Promise.all(chans.map((ch, i) => this.x32.setChannelFader(ch, ampToFader(dbToAmp(l.micDb[i] ?? 0)))));
  }
  // Alles einmal setzen (Abend-Start, Live-Test)
  async applyAllLevels() {
    this.lastSent = { 1: -1, 2: -1 };
    const errs = [];
    for (const p of [1, 2]) await this.applySpotifyVolume(p).catch((e) => errs.push(e.message));
    if (settings().levels.micControl) await this.applyMicFaders().catch((e) => errs.push(e.message));
    return errs;
  }

  start() {
    // Neustart mitten in der Party: die Fader nicht sofort auf die Werte der App setzen (kein Pegelsprung im laufenden Song),
    // gesendet wird erst bei der naechsten Aenderung (Fade, Crossfade, Ducking, Play)
    this.lastSent = { 1: this.levelAmp(1), 2: this.levelAmp(2) };
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

  // ----- Soundcheck-Modus: die App steuert voruebergehend gar nichts (kein Fader, kein Mute, keine Wiedergabe, keine Automatik).
  // Nur der Not-Aus bleibt aktiv. Beim Beenden uebernimmt die App die Fader wieder (sie fahren sanft auf ihre Werte).
  get held() { return !!this.state.hold; }
  assertActive() { if (this.state.hold) throw new Error('Soundcheck-Modus ist an – die App steuert gerade nichts. Erst beenden.'); }
  startHold({ by = null, stopMusic = true, pauseWishes = true, initial = false } = {}) {
    if (this.state.hold) return this.state.hold;
    if (this.liveTest) throw new Error('Der Live-Test läuft gerade – erst beenden.');
    this.crossfade = null; this.ramps = {}; this.pendingStart = [];
    if (stopMusic) for (const p of [1, 2]) if (this.players[p].status().playing) this.players[p].pause().catch((e) => this.fail('pause', e));
    const pausedWishes = !!pauseWishes && this.state.wishMode === 'open';
    this.state.hold = { since: Date.now(), by, prevWishMode: this.state.wishMode, pausedWishes, initial };
    holdNotify(this.env, true);
    if (pausedWishes) this.setWishMode('paused');
    this.persist();
    L.warn('pult', 'soundcheck.on', `Soundcheck-Modus an${by ? ` (${by})` : ''}: Die App steuert weder Fader noch Wiedergabe${stopMusic ? ', Musik angehalten' : ''}${pausedWishes ? ', Wünsche pausiert' : ''}`, { env: this.env, data: { stopMusic, pausedWishes } });
    this.emit('change');
    return this.state.hold;
  }
  endHold({ by = null } = {}) {
    const h = this.state.hold;
    if (!h) return;
    this.state.hold = null;
    holdNotify(this.env, false);
    this.state.activatedAt = Date.now();   // einmal von einem Admin eingeschaltet: startet nicht mehr von selbst deaktiviert
    if (h.pausedWishes && this.state.wishMode === 'paused') this.setWishMode(h.prevWishMode);
    this.lastSent = { 1: -1, 2: -1 };   // Fader wieder auf die Werte der App (sanft, das Relay begrenzt das Tempo) …
    this.adoptHand(this.x32.hand, { force: true });   // … ausser was am Pult verstellt wurde: das wird uebernommen, nicht zurueckgezogen
    this.persist();
    L.info('pult', 'soundcheck.off', `Soundcheck-Modus aus${by ? ` (${by})` : ''} nach ${Math.max(1, Math.round((Date.now() - h.since) / 60000))} Min. – die App übernimmt wieder`, { env: this.env });
    this.emit('change');
  }

  // ----- Hauptschleife -----
  // Wunschlisten-Modus: die App spielt nichts ab, ein DJ spielt selbst. Hier laeuft dann nur noch die Verwaltung der Wuensche.
  get wishlist() { return settings().operation.mode === 'wishlist'; }

  async tick() {
    const now = Date.now();
    const cfg = settings();
    this.checkSchedule(now, cfg);
    if (this.wishlist) {
      if (!this.lastBroadcast || now - this.lastBroadcast >= BROADCAST_MS) { this.lastBroadcast = now; this.emit('tick'); }
      return;
    }

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
    if (now - this.lastFillCheck >= 5000 && !this.liveTest && !this.state.hold) { this.lastFillCheck = now; maybeFill(this, now)
      .then((r) => { if (r) { L.info('wiedergabe', 'queue.filler', `Lückenfüller eingereiht: ${r.title} – ${r.artist}`, { env: this.env, actor: { kind: 'system' }, data: { id: r.id, trackId: r.trackId } }); return r; }
        return autoFill(this, now).then((a) => { if (a) L.info('ki', 'queue.ai_filler', `KI hat eingereiht: ${a.title} – ${a.artist}`, { env: this.env, actor: { kind: 'ai' }, data: { id: a.id, trackId: a.trackId } }); return a; }); })
      .then((r) => { if (r) this.afterQueueChange(); }).catch((e) => this.fail('filler', e)); }

    if (now - this.lastX32Read >= 250 && !this.x32Busy) {
      this.lastX32Read = now; this.x32Busy = true;
      const playing = { 1: this.players[1].status().playing, 2: this.players[2].status().playing };
      this.x32.readState(playing).then((s) => { this.logMics(s.mics); this.logManual(this.x32.manual); this.adoptHand(this.x32.hand); this.x32State = s; }).catch(() => {}).finally(() => { this.x32Busy = false; });
    }
    if (!this.lastBroadcast || now - this.lastBroadcast >= BROADCAST_MS) {
      this.lastBroadcast = now;
      this.emit('tick');
    }
  }

  // ----- Abend-Start: Freischaltung der Wuensche und Start-Playlist -----
  checkSchedule(now, cfg) {
    // Wuensche zur eingestellten Uhrzeit freischalten
    if (this.state.awaitOpen && this.state.openAtTs && now >= this.state.openAtTs) { this.openWishes(); logEvent(this.env, 'wishmode', { auto: 'open' }); }
    // Start-Playlist automatisch starten (einmal pro Abend, in den 6 Stunden nach der Startzeit)
    const st = cfg.start;
    if (st.autoStart && isOn('startPlaylist') && this.realConnections && !this.liveTest && !this.state.hold && !this.wishlist && !this.state.started && now >= (this.nextStartTry || 0)) {
      const [h, m] = st.startAt.split(':').map(Number), [nh, nm] = localHHMM().split(':').map(Number);
      const since = (nh * 60 + nm) - (h * 60 + m);
      const day = localDay();
      if (since >= 0 && since < 360 && getSetting(`autostart:${this.env}`) !== day) {
        this.nextStartTry = now + 30000;
        this.startEvening()
          .then(() => setSetting(`autostart:${this.env}`, day))     // pro Tag nur einmal, auch nach "Zuruecksetzen"
          .catch((e) => { this.nextStartTry = Date.now() + 10 * 60000; this.fail('start', e); });
      }
    }
  }

  // Wuensche schliessen und bis zur Freischaltung (Uhrzeit oder Knopf) geschlossen halten
  armOpening() {
    const o = settings().opening;
    this.state.awaitOpen = true; this.state.wishMode = 'closed'; this.state.openAtTs = null;
    if (o.auto && o.at) {
      const [h, m] = o.at.split(':').map(Number), [nh, nm] = localHHMM().split(':').map(Number);
      let d = (h * 60 + m) - (nh * 60 + nm);
      if (d <= -360) d += 1440;   // z. B. um 23:00 eingestellt fuer 00:30 -> naechster Tag
      // liegt die Uhrzeit gerade erst zurueck, gibt es keinen Termin: dann nur per Knopf (der Hinweis nennt keine Uhrzeit)
      if (d > 0) this.state.openAtTs = Date.now() + d * 60000 - new Date().getSeconds() * 1000;
    }
    this.persist(); this.emit('change');
  }
  openWishes() {
    this.state.awaitOpen = false; this.state.openAtTs = null; this.state.wishMode = 'open';
    this.persist(); this.emit('change');
  }

  // Start-Playlist: Warteschlange fuellen und mit Einblenden loslegen
  async startEvening() {
    this.assertActive();
    if (this.wishlist) throw new Error('Im Wunschlisten-Modus spielt die App keine Musik.');
    if (this.state.panic || this.state.ended) throw new Error('Not-Aus oder Ende-Modus ist aktiv.');
    const sp = settings().start;
    if (!sp.playlist && this.spotify.kind === 'real') throw new Error('Keine Start-Playlist eingetragen (Admin → Automatik → Abend-Start).');
    this.state.started = true; this.persist();
    await this.applyAllLevels().catch(() => {});
    try {
      const n = await fillStart(this, Math.max(2, sp.minQueue));
      const playing = [1, 2].some((p) => this.players[p].status().playing);
      if (n) { if (!playing) await this.fadeIn(1, 4); }
      else if (!playing) {
        // Songs der Playlist nicht einzeln lesbar (z. B. Spotify-eigene Playlists sind fuer neue Spotify-Apps gesperrt)
        // oder alles gesperrt: die Playlist trotzdem direkt ueber Spotify abspielen. Sobald Wuensche da sind, uebernimmt die Warteschlange.
        const why = this.spotify.lastError || 'keine einzeln lesbaren Songs';
        await this.playPlaylist({ uri: sp.playlist, player: 1, shuffle: true, by: 'Abend-Start' });
        L.info('wiedergabe', 'start.playlist_direct', `Start-Playlist läuft direkt über Spotify (${why}) – die ersten angenommenen Wünsche übernehmen per Crossfade`, { env: this.env, data: { why } });
      }
    } catch (e) { this.state.started = false; this.persist(); this.emit('change'); throw new Error(`Start-Playlist lässt sich nicht abspielen: ${e.message}`); }
    logEvent(this.env, 'start', {});
    this.emit('change');
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
        L.info('wiedergabe', 'crossfade.done', `Übergang fertig: Player ${from} → Player ${cf.to} (${cf.dur} s)`, { env: this.env, data: { from, to: cf.to, durSec: cf.dur, curve: cf.curve } });
        this.afterFadeOut(from);   // stumm, pausieren, Fader zurueck in die Grundstellung
        this.current = cf.to;
        this.emit('change');
      }
    }
    for (const [pl, r] of Object.entries(this.ramps)) {
      const p = clamp01((now - r.start) / (r.dur * 1000));
      if (r.curve === 'fader') {
        // gleichmaessig am Fader: die Fader-Stellung laeuft linear, nicht die Amplitude
        const base = this.trackMul[pl] * dbToAmp(settings().levels.playerDb[pl]) || 1;
        const f0 = ampToFader(r.from * base), f1 = ampToFader(r.to * base);
        this.gain[pl] = faderToAmp(f0 + (f1 - f0) * p) / base;
      } else {
        const [o, i] = curveLevels(r.curve, p);
        this.gain[pl] = r.to < r.from ? r.from * o : r.from + (r.to - r.from) * i;
      }
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
    const was = !!this.ducking;
    this.ducking = cfg.ducking.enabled && this.duckMul < 0.995;
    if (was !== this.ducking) L.log(this.ducking ? 'info' : 'debug', 'pult', this.ducking ? 'ducking.on' : 'ducking.off', this.ducking ? `Ducking: Musik wird abgesenkt (${cfg.ducking.db} dB), weil ein Mikrofon offen ist` : 'Ducking vorbei: Musik wieder voll', { env: this.env, data: { db: cfg.ducking.db, mics: this.x32State.mics.filter((m) => m.open).map((m) => m.name) } });
  }

  levelAmp(p) {
    const cap = isOn('faderLimit') ? settings().limits.maxGain : 1;
    return this.state.panic ? 0 : Math.min(cap, this.gain[p] * this.trackMul[p]) * this.duckMul * dbToAmp(settings().levels.playerDb[p]);
  }
  applyLevels() {
    if ((this.faderTest || this.state.hold) && !this.state.panic) return;   // Fader-Test / Soundcheck: die App fasst die Fader nicht an   // Einrichtung: Fader-Test laeuft gerade
    for (const p of [1, 2]) {
      const amp = this.levelAmp(p);
      if (Math.abs(amp - this.lastSent[p]) < 0.002 && !(amp === 0 && this.lastSent[p] !== 0)) continue;
      this.lastSent[p] = amp;
      this.x32.setPlayerLevel(p, amp, { instant: !!this.state.panic }).catch((e) => this.fail('x32', e));
    }
  }

  maybeAutoCrossfade(now, cfg) {
    if (!cfg.auto.enabled || this.state.hold || this.liveTest?.noAuto || this.crossfade || this.starting || this.pendingStart.length || this.state.panic || this.state.ended || !this.current) return;
    const st = this.players[this.current].status();
    if (!st.playing || !st.durationMs) return;
    const remaining = st.durationMs - st.positionMs;
    // KI-Uebergang (falls analysiert), sonst Smart: den Uebergang beginnen, wenn der Song ausklingt, nicht mitten im Refrain
    const plan = this.mixPlanNow(st, cfg);
    const lead = plan ? plan.leadMs : leadFor(cfg, this.current, st.durationMs, getMeta(this.trackIdOf[this.current]));
    const braked = isOn('songLimit') && cfg.limits.maxSongSec > 0 && st.positionMs > cfg.limits.maxSongSec * 1000;
    if (remaining > lead && !braked) return;
    if (!rq.upcoming(this.env).length) return;
    const dur = Math.max(0.5, Math.min(plan ? plan.durSec : cfg.auto.crossfadeSec, remaining / 1000));
    if (plan) L.info('wiedergabe', 'crossfade.ai', `KI-Übergang: ${String(Math.round(dur * 10) / 10).replace('.', ',')} s – ${plan.why}`, { env: this.env, actor: { kind: 'ai' }, data: { ...plan, durSec: dur } });
    this.startCrossfade(dur, plan ? plan.curve : cfg.auto.curve, { auto: true }).catch((e) => this.fail('auto-crossfade', e));
  }
  mixPlanNow(st = this.current && this.players[this.current].status(), cfg = settings()) {
    if (!this.current || !st?.durationMs) return null;
    const meta = getMeta(this.trackIdOf[this.current]);
    return mixPlan({ curId: this.trackIdOf[this.current], nextId: rq.upcoming(this.env)[0]?.trackId, durationMs: st.durationMs, spotifyOutroMs: meta?.src === 'spotify' ? meta.outro_ms : null, baseSec: cfg.auto.crossfadeSec });
  }

  // ----- Aktionen -----
  async startCrossfade(durSec, curve = settings().auto.curve, { auto = false } = {}) {
    this.assertActive();
    if (this.state.playlist) { this.state.playlist = null; this.persist(); }   // Warteschlange uebernimmt
    if (this.state.panic) throw new Error('Not-Aus ist aktiv.');
    if (this.state.ended) throw new Error('Ende-Modus ist aktiv.');
    if (this.crossfade || this.starting || this.pendingStart.length) throw new Error('Es läuft bereits ein Crossfade.');
    const next = rq.upcoming(this.env)[0];
    if (!next) throw new Error('Die Warteschlange ist leer.');
    this.endLevelTest();
    this.starting = true;   // bis der Uebergang wirklich laeuft, kein zweiter Start (Tick laeuft alle 100 ms weiter)
    try {

    const curPlaying = this.current && this.players[this.current].status().playing;
    let target = next.player || (this.current ? other(this.current) : 1);
    if (curPlaying && target === this.current) { target = other(this.current); rq.reassignPlayer(next.id, target); }

    this.expectedUri[target] = next.uri;
    this.gain[target] = 0;
    delete this.ramps[target];
    const prev = rq.markPlaying(this.env, next.id, target);
    const prevTrack = this.trackIdOf[target];
    this.trackIdOf[target] = next.trackId;
    const track = { uri: next.uri, title: next.title, artist: next.artist, durationMs: next.durationMs };
    try { if (this.muted[target]) await this.unmuteFor(target, 0); await this.players[target].play(track); }
    catch (e) { rq.undoPlaying(this.env, next.id, prev); this.trackIdOf[target] = prevTrack; this.expectedUri[target] = null; this.emit('change'); throw e; }
    logEvent(this.env, 'play', { player: target, title: next.title, auto });
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
    } finally { this.starting = false; }
  }

  // Nach jeder Aenderung der Warteschlange: automatisch sortieren (Genre-Balance/Stimmung) und Meta des naechsten Songs holen
  afterQueueChange() {
    if (!this.wishlist) { try { applyAutoOrder(this.env, this.current); } catch (e) { this.fail('auto-order', e); } }
    const next = rq.upcoming(this.env)[0];
    if (next) ensureMeta(this.spotify, { id: next.trackId }).catch(() => {});
    this.emit('change');
  }
  afterTrackStart(player) {
    const cur = this.trackIdOf[player ?? this.current ?? 1];
    if (player) {
      const g = cur && isOn('gainMemory') ? getDb().prepare('SELECT gain FROM track_gain WHERE track_id = ?').get(cur) : null;
      // von Hand gemerkte Lautstaerke hat Vorrang, sonst der KI-Pegel-Ausgleich
      const trim = g ? null : mixTrimDb(cur);
      this.trackMul[player] = g ? g.gain : trim != null ? dbToAmp(trim) : 1;
      this.mixTrim[player] = trim;
    }
    if (cur) ensureMeta(this.spotify, { id: cur }).catch(() => {});
    this.afterQueueChange();
  }

  async play(player, { startGain = 1 } = {}) {
    this.assertActive();
    if (this.state.playlist) { this.state.playlist = null; this.persist(); }   // Warteschlange uebernimmt
    this.endLevelTest();
    const st = this.players[player].status();
    const np = rq.nowPlayingRequest(this.env);
    const ours = st.uri && !st.ended && this.trackIdOf[player] && np && np.trackId === this.trackIdOf[player] && np.player === player;
    if (ours) { if (this.muted[player]) await this.unmuteFor(player, startGain); await this.players[player].resume(); if (!this.current) this.current = player; }
    else {
      const next = rq.upcoming(this.env).find((u) => !u.player || u.player === player) || rq.upcoming(this.env)[0];
      if (!next) throw new Error('Keine Songs in der Warteschlange.');
      rq.reassignPlayer(next.id, player); // gezielt auf diesem Player starten
      this.gain[player] = startGain; delete this.ramps[player];
      this.expectedUri[player] = next.uri;
      const prev = rq.markPlaying(this.env, next.id, player);
      const prevTrack = this.trackIdOf[player];
      this.trackIdOf[player] = next.trackId;
      try { if (this.muted[player]) await this.unmuteFor(player, startGain); await this.players[player].play({ uri: next.uri, title: next.title, artist: next.artist, durationMs: next.durationMs }); }
      catch (e) { rq.undoPlaying(this.env, next.id, prev); this.trackIdOf[player] = prevTrack; this.expectedUri[player] = null; this.emit('change'); throw e; }
      this.afterTrackStart(player);
      if (!this.current) this.current = player;
    }
    this.emit('change');
  }

  async pause(player) { await this.players[player].pause(); this.emit('change'); }

  // Ende eines Fade-outs/Crossfades: Kanal stumm, Player pausieren; eine halbe Sekunde nach dem Muten den Fader auf null
  // (er bleibt unten, solange der Kanal stumm ist). Ohne Stummschalten faehrt der Fader wie frueher zurueck in die Grundstellung.
  async afterFadeOut(player) {
    let muted = false;
    if (settings().x32.muteAfterFade !== false && this.x32.setMute && !this.state.panic) {
      try { await this.x32.setMute(player, true); this.muted[player] = muted = true; this.state.mutedCh = { ...this.muted }; this.persist(); L.debug('pult', 'channel.muted', `Player ${player} ausgeblendet: Kanal stumm, Fader auf null`, { env: this.env }); }
      catch (e) { this.fail('mute', e); }
    }
    await this.players[player].pause().catch((e) => this.fail('pause', e));
    const busy = () => this.ramps[player] || this.crossfade?.to === player;
    if (!muted) { if (!busy()) this.gain[player] = 1; }   // bereit fuer den naechsten Einsatz
    else {
      this.gain[player] = 0;
      const t = setTimeout(() => { if (this.muted[player] && !busy()) { this.gain[player] = 0; this.lastSent[player] = -1; } }, 500);
      t.unref?.();
    }
    this.emit('change');
  }
  // Vor jedem Abspielen: war der Kanal stumm, zuerst den Fader auf den Startwert setzen, dann freigeben
  async unmuteFor(player, startGain = 1) {
    if (!this.muted[player]) return;
    this.gain[player] = startGain;
    const amp = this.levelAmp(player);
    this.lastSent[player] = amp;
    await this.x32.setPlayerLevel(player, amp, { instant: true }).catch(() => {});
    try { await this.x32.setMute(player, false); this.muted[player] = false; this.state.mutedCh = { ...this.muted }; this.persist(); }
    catch (e) { this.fail('mute', e); throw new Error(`Kanal von Player ${player} lässt sich nicht freigeben – am Pult von Hand einschalten. (${e.message})`); }
  }

  async fadeIn(player, sec) {
    this.assertActive();
    if (this.state.panic) throw new Error('Not-Aus ist aktiv.');
    const st = this.players[player].status();
    this.gain[player] = 0;
    delete this.ramps[player];
    if (!st.playing) await this.play(player, { startGain: 0 });
    else if (this.muted[player]) await this.unmuteFor(player, 0);
    this.ramps[player] = { from: 0, to: 1, start: Date.now(), dur: Math.max(0.1, sec), curve: 'fader' };
    if (!this.current) this.current = player;
    this.emit('change');
  }

  fadeOut(player, sec, { pauseAfter = true } = {}) {
    this.assertActive();
    const from = this.gain[player];
    this.ramps[player] = {
      from, to: 0, start: Date.now(), dur: Math.max(0.1, sec), curve: 'fader',
      then: () => { if (pauseAfter) this.afterFadeOut(player); },
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

  setGain(player, value) { this.assertActive(); delete this.ramps[player]; this.gain[player] = clamp01(value); this.emit('change'); }

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
    this.gain = { 1: this.muted[1] ? 0 : 1, 2: this.muted[2] ? 0 : 1 };   // stumme Kanaele bleiben unten
    logEvent(this.env, 'panic-clear', {});
    this.emit('change');
  }

  // Notfall-Playlist: stoppt alles, startet die eingestellte Playlist (gemischt) auf dem gewaehlten Player
  async emergencyStart() {
    this.assertActive();
    const cfg = settings().emergency;
    const m = String(cfg.playlist || '').match(/playlist[/:]([A-Za-z0-9]{22})/) || String(cfg.playlist || '').match(/^([A-Za-z0-9]{22})$/);
    if (!m && this.players[cfg.player].kind === 'real') throw new Error('Keine Notfall-Playlist eingetragen (Admin → Automatik).');
    const p = cfg.player, o = other(p);
    this.crossfade = null; this.ramps = {}; this.pendingStart = [];
    this.state.panic = false; this.state.ended = false; this.state.emergency = true; this.persist();
    this.players[o].pause().catch(() => {});
    this.gain[o] = this.muted[o] ? 0 : 1; this.gain[p] = 0; this.duckMul = 1;
    if (this.muted[p]) await this.unmuteFor(p, 0).catch((e) => this.fail('mute', e));   // im Notfall trotzdem weiter
    await this.players[p].playContext(m ? `spotify:playlist:${m[1]}` : 'mock:playlist:notfall', { shuffle: cfg.shuffle });
    this.current = p;
    const begin = () => { this.ramps[p] = { from: 0, to: 1, start: Date.now(), dur: 2, curve: 'linear' }; this.emit('change'); };
    if (this.players[p].kind === 'real') this.pendingStart.push({ at: Date.now() + 600, fn: begin }); else begin();
    logEvent(this.env, 'emergency', {});
    this.emit('emergency'); this.emit('change');
  }
  // Einfach eine Playlist abspielen (Hintergrundmusik, Einlass, Soundcheck). Ist das System aus (Soundcheck-Modus),
  // startet nur Spotify – Fader und Mute bleiben wie sie sind. Sonst wie gewohnt mit kurzem Einblenden.
  async playPlaylist({ uri, player = 1, shuffle = true, by = null } = {}) {
    const m = String(uri || '').match(/playlist[/:]([A-Za-z0-9]{22})/) || String(uri || '').match(/^([A-Za-z0-9]{22})$/);
    if (!m && this.players[player].kind === 'real') throw new Error('Bitte einen Spotify-Playlist-Link einfügen (Spotify → Teilen → Link kopieren).');
    if (this.state.panic) throw new Error('Not-Aus ist aktiv.');
    if (this.wishlist) throw new Error('Im Wunschlisten-Modus spielt die App keine Musik.');
    const p = player === 2 ? 2 : 1, o = other(p), ctxUri = m ? `spotify:playlist:${m[1]}` : 'mock:playlist:playlist';
    this.endLevelTest();
    this.crossfade = null; delete this.ramps[p]; delete this.ramps[o]; this.pendingStart = [];
    if (this.players[o].status().playing) this.players[o].pause().catch(() => {});
    if (!this.state.hold) {
      this.gain[o] = this.muted[o] ? 0 : 1; this.gain[p] = 0;
      if (this.muted[p]) await this.unmuteFor(p, 0);
    }
    await this.players[p].playContext(ctxUri, { shuffle });
    this.current = p; this.expectedUri[p] = null; this.trackIdOf[p] = null;
    this.state.playlist = { uri: ctxUri, player: p, since: Date.now(), by }; this.persist();
    if (!this.state.hold) {
      const begin = () => { this.ramps[p] = { from: 0, to: 1, start: Date.now(), dur: 2, curve: 'fader' }; this.emit('change'); };
      if (this.players[p].kind === 'real') this.pendingStart.push({ at: Date.now() + 600, fn: begin }); else begin();
    }
    L.info('wiedergabe', 'playlist.start', `Playlist läuft auf Player ${p}${shuffle ? ' (gemischt)' : ''}${this.state.hold ? ' – System aus, Pult unverändert' : ''}`, { env: this.env, actor: by ? { kind: 'staff', label: by } : null, data: { uri: ctxUri, player: p, shuffle } });
    this.emit('change');
    return this.state.playlist;
  }
  stopPlaylist({ by = null } = {}) {
    const pl = this.state.playlist;
    if (!pl) return;
    this.state.playlist = null; this.persist();
    if (this.state.hold) this.players[pl.player].pause().catch((e) => this.fail('pause', e));
    else this.fadeOut(pl.player, settings().auto.fadeSec ?? 5);
    L.info('wiedergabe', 'playlist.stop', `Playlist gestoppt (Player ${pl.player})`, { env: this.env, actor: by ? { kind: 'staff', label: by } : null });
    this.emit('change');
  }

  emergencyClear() { this.state.emergency = false; this.persist(); logEvent(this.env, 'emergency-clear', {}); this.emit('change'); }

  // Testsong fuer Pegel und Live-Test: etwas Bekanntes, das laenger als eine Minute laeuft
  async pickTestTrack() {
    for (const q of ['party hits', 'dance', 'a']) {
      const list = await this.spotify.search(q, 8).catch(() => []);
      const t = list.find((x) => x.durationMs > 90000 && !x.explicit) || list.find((x) => x.durationMs > 60000) || list[0];
      if (t) return t;
    }
    throw new Error('Kein Testsong gefunden (Spotify-Suche).');
  }
  // Einen Song direkt auf einem Player abspielen (ohne Warteschlange), z. B. fuer Pegel und Live-Test
  async playDirect(n, track, gain = 1) {
    this.assertActive();
    if (this.state.panic) throw new Error('Not-Aus ist aktiv.');
    delete this.ramps[n]; this.gain[n] = gain; this.trackMul[n] = 1;
    this.expectedUri[n] = track.uri; this.trackIdOf[n] = null;
    if (this.muted[n]) await this.unmuteFor(n, gain);
    await this.players[n].play(track);
    this.current = n;
    this.emit('change');
  }
  // Pegel-Fenster: Testmusik in voller Grundlautstaerke, bis sie gestoppt wird (hoechstens 3 Minuten)
  async levelTest(n) {
    if (this.wishlist) throw new Error('Im Wunschlisten-Modus spielt die App keine Musik.');
    if (!this.levelTestOn && [1, 2].some((x) => this.players[x].status().playing)) throw new Error('Es läuft gerade Musik – Testmusik geht nur bei Stille. Die Pegel kannst du trotzdem live anpassen.');
    await this.levelTestStop();
    const t = await this.pickTestTrack();
    await this.playDirect(n, t, 1);
    this.levelTestOn = n; this.levelTestUri = t.uri;
    this.levelTestTimer = setTimeout(() => this.levelTestStop().catch(() => {}), 180000);
    this.levelTestTimer.unref?.();
    return t;
  }
  // Normale Wiedergabe uebernimmt: Testmusik-Timer vergessen (der laufende Song bleibt)
  endLevelTest() { clearTimeout(this.levelTestTimer); this.levelTestOn = null; }
  async levelTestStop() {
    clearTimeout(this.levelTestTimer);
    const n = this.levelTestOn;
    if (!n) return;
    this.levelTestOn = null;
    if (this.players[n].status().uri && this.players[n].status().uri !== this.levelTestUri) return;   // laeuft schon etwas anderes: nicht anhalten
    await this.players[n].pause().catch(() => {});
    if (this.current === n) this.current = null;
    this.emit('change');
  }

  // Kurzer, leiser Test eines Players (Vorbereitungs-Seite): 8 s abspielen, dann stoppen
  async testPlayer(n) {
    if ([1, 2].some((x) => this.players[x].status().playing)) throw new Error('Es läuft gerade Musik – Test nur bei Stille.');
    const list = await this.spotify.search('a', 8).catch(() => []);
    const t = list.find((x) => x.durationMs > 60000) || list[0];
    if (!t) throw new Error('Kein Testsong gefunden (Spotify-Suche).');
    this.gain[n] = 0.12; delete this.ramps[n];
    if (this.muted[n]) await this.unmuteFor(n, 0.12);
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
    this.gain = { 1: this.muted[1] ? 0 : 1, 2: this.muted[2] ? 0 : 1 }; this.duckMul = 1;
    this.expectedUri = { 1: null, 2: null }; this.lastSeenUri = { 1: null, 2: null };
    this.trackIdOf = { 1: null, 2: null };
    this.state = { wishMode: 'open', ended: false, panic: false, emergency: false, hold: this.state.hold || null, activatedAt: this.state.activatedAt || null, mutedCh: { ...this.muted } }; this.persist();   // System an/aus bleibt
    if (settings().opening.enabled && isOn('openingGate')) this.armOpening();
    for (const p of [1, 2]) { this.players[p].reset?.(); this.players[p].pause().catch(() => {}); }
    this.emit('change');
  }

  setWishMode(mode) {
    if (!['open', 'paused', 'closed'].includes(mode)) throw new Error('Ungültiger Modus');
    this.state.wishMode = mode;
    if (mode === 'open') { this.state.awaitOpen = false; this.state.openAtTs = null; }   // von Hand geoeffnet: Freischaltung erledigt
    this.persist(); this.emit('change');
  }
  get wishMode() { return this.state.wishMode; }

  nowPlaying() {
    if (this.wishlist) { const r = rq.nowPlayingRequest(this.env); return r ? { player: null, title: r.title, artist: r.artist, trackId: r.trackId } : null; }
    for (const p of [this.current, other(this.current || 1)]) {
      if (!p) continue;
      const st = this.players[p].status();
      if (st.playing && st.title) return { player: p, title: st.title, artist: st.artist, trackId: trackIdOfUri(st.uri) };
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
      api: this.realConnections ? apiSnapshot() : null,
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
        muted: !!this.muted[p],
        fading: !!this.ramps[p] || (this.crossfade && (this.crossfade.from === p || this.crossfade.to === p)) || false,
      };
    }
    const cf = this.crossfade;
    const cfg = settings();
    const up = rq.upcoming(this.env);
    // Vorschau fuer die Lichttechnik: wann beginnt der naechste Uebergang, wann startet welcher Song (nur im Auto-Modus berechenbar)
    let crossfadeIn = null;
    const etas = [];
    const cur = this.current && players[this.current];
    if (cfg.auto.enabled && cur && cur.playing && cur.durationMs && !cf && !this.state.panic && !this.state.ended) {
      const braked = isOn('songLimit') && cfg.limits.maxSongSec > 0 && cur.positionMs > cfg.limits.maxSongSec * 1000;
      const lead = leadFor(cfg, this.current, cur.durationMs, getMeta(this.trackIdOf[this.current]));
      let t = braked ? 0 : Math.max(0, cur.remainingMs - lead);
      crossfadeIn = { inMs: t, leadMs: lead, crossfadeSec: cfg.auto.crossfadeSec, braked };
      let player = this.current;
      for (const u of up.slice(0, 12)) {
        etas.push(t);
        player = u.player || (player === 1 ? 2 : 1);
        t += Math.max(0, u.durationMs - leadFor(cfg, player, u.durationMs, getMeta(u.trackId)));
      }
    }
    return {
      env: this.env,
      mode: this.wishlist ? 'wishlist' : 'full',
      ts: Date.now(),
      players,
      current: this.current,
      crossfade: cf ? { from: cf.from, to: cf.to, progress: clamp01((Date.now() - cf.start) / (cf.dur * 1000)), durSec: cf.dur } : null,
      auto: cfg.auto,
      hold: this.state.hold || null,
      playlist: this.state.playlist || null,
      mix: mixActive() ? { plan: this.mixPlanNow(), trim: { ...this.mixTrim }, nextTrimDb: mixTrimDb(rq.upcoming(this.env)[0]?.trackId) } : null,
      ducking: { ...cfg.ducking, active: !!this.ducking, mul: this.duckMul },
      mics: this.x32State.mics,
      wishMode: this.state.wishMode,
      ended: this.state.ended,
      panic: this.state.panic,
      emergency: !!this.state.emergency,
      pauseMode: !!this.state.pauseMode && isOn('pauseMode'),
      opening: { awaiting: !!this.state.awaitOpen, opensAt: this.state.openAtTs || null, started: !!this.state.started },
      levelTest: this.levelTestOn || null,
      counts: rq.counts(this.env),
      upcoming: up.slice(0, 50).map((u, i) => ({ ...u, etaMs: etas[i] ?? null })),
      crossfadeIn,
      upcomingTotal: up.length,
      connections: this.connections(),
      errors: this.errors.slice(0, 5),
    };
  }
}
