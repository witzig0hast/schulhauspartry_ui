// HTTP-Relay: App (ueber VPN) <-> X32 (OSC ueber UDP, Port 10023)
//   POST /x32/level  {player, channels:[..], fader}  -> setzt /ch/NN/mix/fader
//   GET  /x32/state  -> {mics:[{open,level}], meters:{1,2}, x32:{ok,lastSeenMs}}
//   POST /x32/config {p1, p2, mics, host, port} -> Kanalzuordnung und X32-Adresse aus dem Admin (host '' = Wert aus der .env)
//   POST /x32/discover -> sucht X32/M32 im Netz (OSC /xinfo per Broadcast)
//   GET  /x32/channels -> Namen, Pegel, Mute und Fader aller 32 Kanaele (fuer die Einrichtung)
//   POST /x32/select {channel} -> waehlt den Kanal am Pult an (Select-Taste leuchtet), ohne den Fader zu bewegen
// Fader werden geschont: Das Relay faehrt neue Werte mit begrenzter Geschwindigkeit an (25 Schritte/s im LAN),
// statt den Motor springen zu lassen. Bewegt jemand einen Fader von Hand, hat die Hand 3 s Vorrang.
//   GET  /healthz    -> ohne Token, nur {ok:true}
import dgram from 'node:dgram';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encode, decode, decodeMeters } from './osc.js';

const ch2 = (n) => String(n).padStart(2, '0');
// Nur Adressen im lokalen Netz: das Relay soll nie Pakete ins Internet schicken koennen
export function validX32Host(h) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(h || ''));
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((x) => x > 255) || d === 0 || d === 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
}
const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

const parseList = (s, d) => (s ? String(s).split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 32) : d);

export function createRelay(opts = {}) {
  const cfg = {
    x32Host: opts.x32Host, x32Port: opts.x32Port ?? 10023,
    token: opts.token, bind: opts.bind ?? '0.0.0.0', port: opts.port ?? 8080,
    mics: opts.mics ?? [5, 6, 7], players: opts.players ?? { 1: [1, 2], 2: [3, 4] },
    micThreshold: opts.micThreshold ?? 0.03, micHoldMs: opts.micHoldMs ?? 600,
    stateFile: opts.stateFile ?? null,
    faderSpeed: opts.faderSpeed ?? 1.2,   // Fader-Weg pro Sekunde (0..1 = ganzer Weg)
    glideMs: opts.glideMs ?? 40, manualHoldMs: opts.manualHoldMs ?? 3000,
  };
  const envHost = { host: cfg.x32Host, port: cfg.x32Port };
  cfg.hostSource = 'pi';
  // Im Admin gesetzte Adresse ueberlebt einen Neustart des Relays (Datei im gemounteten state-Ordner)
  if (cfg.stateFile) {
    try {
      const j = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
      if (validX32Host(j.host)) { cfg.x32Host = j.host; cfg.x32Port = validPort(j.port) ? j.port : 10023; cfg.hostSource = 'admin'; }
    } catch { /* keine oder kaputte Datei: Wert aus der .env */ }
  }
  if (!cfg.x32Host) throw new Error('X32_HOST fehlt');
  if (!cfg.token || cfg.token.length < 16) throw new Error('RELAY_TOKEN fehlt oder ist zu kurz (min. 16 Zeichen)');

  const sock = dgram.createSocket('udp4');
  const state = { meters: new Array(32).fill(0), micOn: {}, micActiveUntil: {}, lastSeen: 0, lastMeters: 0, names: {}, namesAt: 0, chOn: {} };
  // Fader: aktuelle Stellung, Ziel, Tempo; queried = wir haben die Stellung abgefragt (Antwort ist kein Handgriff)
  const fad = { cur: {}, target: {}, speed: {}, manualUntil: {}, queried: {}, manualAt: {} };
  const send = (address, args) => sock.send(encode(address, args), cfg.x32Port, cfg.x32Host);

  sock.on('message', (msg) => {
    state.lastSeen = Date.now();
    let m; try { m = decode(msg); } catch { return; }
    if (m.address === '/meters/1' && Buffer.isBuffer(m.args[0])) {
      try { const v = decodeMeters(m.args[0]); for (let i = 0; i < 32 && i < v.length; i++) state.meters[i] = v[i]; state.lastMeters = Date.now(); } catch { /* ignorieren */ }
    } else {
      const mm = /^\/ch\/(\d\d)\/mix\/on$/.exec(m.address);
      if (mm) { state.micOn[Number(mm[1])] = m.args[0] === 1; state.chOn[Number(mm[1])] = m.args[0] === 1; }
      const nm = /^\/ch\/(\d\d)\/config\/name$/.exec(m.address);
      if (nm) state.names[Number(nm[1])] = String(m.args[0] ?? '').slice(0, 12);
      const fm = /^\/ch\/(\d\d)\/mix\/fader$/.exec(m.address);
      if (fm && typeof m.args[0] === 'number') {
        const c = Number(fm[1]), v = Math.max(0, Math.min(1, m.args[0])), now = Date.now();
        if (fad.queried[c] && now - fad.queried[c] < 1500) { delete fad.queried[c]; if (fad.cur[c] == null) fad.cur[c] = v; }
        else if (fad.cur[c] == null || Math.abs(v - fad.cur[c]) > 0.002) { fad.cur[c] = v; fad.manualUntil[c] = now + cfg.manualHoldMs; fad.manualAt[c] = now; }   // von Hand (Pult/X32-Edit) bewegt
      }
    }
  });

  const timers = [];
  const keepAlive = () => { send('/xremote', []); send('/meters', [{ t: 's', v: '/meters/1' }]); };
  const pollMics = () => { for (const c of cfg.mics) send(`/ch/${ch2(c)}/mix/on`, []); };

  // "offen" = Kanal ist aktiv (nicht gemutet) UND es liegt Signal an (mit Nachlauf).
  // Ohne Meter-Daten faellt es auf den reinen Mute-Status zurueck.
  function micState(now = Date.now()) {
    const haveMeters = now - state.lastMeters < 2500;
    return cfg.mics.map((c, i) => {
      const level = Math.min(1, state.meters[c - 1] || 0);
      const unmuted = state.micOn[c] === true;
      if (haveMeters && unmuted && level > cfg.micThreshold) state.micActiveUntil[c] = now + cfg.micHoldMs;
      const active = haveMeters ? now < (state.micActiveUntil[c] || 0) : true;
      return { id: i + 1, channel: c, open: unmuted && active, level };
    });
  }

  // Fader sanft anfahren: instant nur fuer Not-Aus (sofort auf 0)
  function setFader(c, v, { speed, instant } = {}) {
    v = Math.round(Math.max(0, Math.min(1, v)) * 1023) / 1023;   // Raster des X32 (1024 Stufen)
    fad.target[c] = v;
    fad.speed[c] = Number.isFinite(speed) && speed > 0 ? Math.min(20, speed) : cfg.faderSpeed;
    if (instant || fad.cur[c] == null) { fad.cur[c] = v; fad.manualUntil[c] = 0; send(`/ch/${ch2(c)}/mix/fader`, [{ t: 'f', v }]); }
  }
  function glide() {
    const now = Date.now();
    for (const k of Object.keys(fad.target)) {
      const c = Number(k), t = fad.target[c], cur = fad.cur[c];
      if (cur == null || cur === t || (fad.manualUntil[c] || 0) > now) continue;
      const step = fad.speed[c] * cfg.glideMs / 1000;
      const next = Math.abs(t - cur) <= step ? t : cur + Math.sign(t - cur) * step;
      fad.cur[c] = next;
      send(`/ch/${ch2(c)}/mix/fader`, [{ t: 'f', v: next }]);
    }
  }
  // Stellung der benutzten Fader beim Start abfragen, damit die erste Bewegung nicht springt
  const queryFaders = (list) => { for (const c of list) { fad.queried[c] = Date.now(); send(`/ch/${ch2(c)}/mix/fader`, []); } };
  const usedChannels = () => [...new Set([...cfg.players[1], ...cfg.players[2], ...cfg.mics])];
  async function channelInfo() {
    if (Date.now() - state.namesAt > 20000) {
      state.namesAt = Date.now();
      for (let c = 1; c <= 32; c++) { send(`/ch/${ch2(c)}/config/name`, []); send(`/ch/${ch2(c)}/mix/on`, []); }
      await new Promise((r) => setTimeout(r, 400));
    }
    const now = Date.now();
    return Array.from({ length: 32 }, (_, i) => ({ channel: i + 1, name: state.names[i + 1] || '', level: Math.min(1, state.meters[i] || 0), on: state.chOn[i + 1] ?? null, fader: fad.cur[i + 1] ?? null, manual: now - (fad.manualAt[i + 1] || 0) < 10000 }));
  }

  function setHost(host, port) {
    const before = `${cfg.x32Host}:${cfg.x32Port}`;
    if (!host) { cfg.x32Host = envHost.host; cfg.x32Port = envHost.port; cfg.hostSource = 'pi'; }
    else { cfg.x32Host = host; cfg.x32Port = port || 10023; cfg.hostSource = 'admin'; }
    if (before === `${cfg.x32Host}:${cfg.x32Port}`) return;
    state.lastSeen = 0; state.lastMeters = 0; state.micOn = {}; state.names = {}; state.namesAt = 0; state.chOn = {};
    for (const k of Object.keys(fad)) fad[k] = {};
    console.log(`[relay] X32-Adresse jetzt ${cfg.x32Host}:${cfg.x32Port} (${cfg.hostSource === 'admin' ? 'aus dem Admin' : 'aus der .env'})`);
    if (cfg.stateFile) {
      try {
        if (host) fs.writeFileSync(cfg.stateFile, JSON.stringify({ host: cfg.x32Host, port: cfg.x32Port }) + '\n', { mode: 0o644 });
        else fs.rmSync(cfg.stateFile, { force: true });
      } catch (e) { console.error(`[relay] X32-Adresse konnte nicht gespeichert werden (${e.code || e.message}) – gilt bis zum Neustart`); }
    }
    keepAlive(); pollMics(); queryFaders(usedChannels());
  }

  // X32/M32 im lokalen Netz finden: /xinfo an alle Broadcast-Adressen (ausser VPN), Antwort: ip, name, model, version
  async function discover(ms = 1200) {
    const targets = new Set(['255.255.255.255']);
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      if (/^(wg|docker|br-|veth)/.test(name)) continue;
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
        const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
        targets.add(ip.map((o, i) => (o | (~mask[i] & 255))).join('.'));
      }
    }
    if (opts.discoverTargets) { targets.clear(); for (const t of opts.discoverTargets) targets.add(t); }
    const found = new Map();
    const ds = dgram.createSocket('udp4');
    ds.on('message', (msg, rinfo) => {
      let m; try { m = decode(msg); } catch { return; }
      if (m.address !== '/xinfo' || found.size >= 20) return;
      const [ip, name, model, version] = m.args.map((x) => String(x ?? '').slice(0, 40));
      const host = validX32Host(ip) ? ip : rinfo.address;
      if (validX32Host(host)) found.set(host, { host, port: rinfo.port, name, model, version });
    });
    ds.on('error', () => {});
    await new Promise((r) => ds.bind(0, r));
    ds.setBroadcast(true);
    const port = opts.discoverPort ?? 10023;
    for (const t of targets) ds.send(encode('/xinfo', []), port, t, () => {});
    await new Promise((r) => setTimeout(r, ms));
    ds.close();
    return [...found.values()];
  }

  const playerMeter = (p) => Math.min(1, Math.max(0, ...(cfg.players[p] || []).map((c) => state.meters[c - 1] || 0)));

  const authOk = (req) => {
    const h = String(req.headers.authorization || '');
    const a = Buffer.from(h), b = Buffer.from(`Bearer ${cfg.token}`);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const server = http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/healthz') return json(200, { ok: true });
    if (!authOk(req)) return json(401, { error: 'unauthorized' });

    if (req.method === 'GET' && req.url === '/x32/state') {
      return json(200, {
        mics: micState(), meters: { 1: playerMeter(1), 2: playerMeter(2) },
        manual: usedChannels().filter((c) => Date.now() - (fad.manualAt[c] || 0) < 10000),
        x32: { ok: Date.now() - state.lastSeen < 5000, lastSeenMs: state.lastSeen ? Date.now() - state.lastSeen : null, host: cfg.x32Host, port: cfg.x32Port, source: cfg.hostSource, envHost: envHost.host },
      });
    }
    if (req.method === 'POST' && req.url === '/x32/config') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        let j; try { j = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        const list = (a, max) => (Array.isArray(a) && a.length && a.length <= max && a.every((c) => Number.isInteger(c) && c >= 1 && c <= 32) ? a : null);
        const p1 = list(j.p1, 2), p2 = list(j.p2, 2), mics = list(j.mics, 3);
        if (j.p1 !== undefined && !p1 || j.p2 !== undefined && !p2 || j.mics !== undefined && !mics) return json(400, { error: 'channels' });
        if (j.host !== undefined && j.host !== '' && !validX32Host(j.host)) return json(400, { error: 'host' });
        if (j.port !== undefined && j.port !== null && !validPort(j.port)) return json(400, { error: 'port' });
        if (p1) cfg.players[1] = p1;
        if (p2) cfg.players[2] = p2;
        if (mics) { cfg.mics = mics; pollMics(); }
        if (p1 || p2 || mics) queryFaders(usedChannels().filter((c) => fad.cur[c] == null));
        if (j.host !== undefined) setHost(j.host, j.port);
        json(200, { ok: true, p1: cfg.players[1], p2: cfg.players[2], mics: cfg.mics, host: cfg.x32Host, port: cfg.x32Port, source: cfg.hostSource });
      });
      return undefined;
    }
    if (req.method === 'POST' && req.url === '/x32/discover') {
      if (state.discovering) return json(429, { error: 'busy' });
      state.discovering = true;
      discover().then((list) => json(200, { found: list }), () => json(500, { error: 'discover' })).finally(() => { state.discovering = false; });
      return undefined;
    }
    if (req.method === 'GET' && req.url === '/x32/channels') {
      channelInfo().then((list) => json(200, { channels: list, ok: Date.now() - state.lastSeen < 5000 }), () => json(500, { error: 'channels' }));
      return undefined;
    }
    if (req.method === 'POST' && req.url === '/x32/select') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 256) req.destroy(); });
      req.on('end', () => {
        let j; try { j = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        const c = Number(j.channel);
        if (!Number.isInteger(c) || c < 1 || c > 32) return json(400, { error: 'channel' });
        send('/-stat/selidx', [{ t: 'i', v: c - 1 }]);
        json(200, { ok: true });
      });
      return undefined;
    }
    if (req.method === 'POST' && req.url === '/x32/level') {
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 2048) req.destroy(); });
      req.on('end', () => {
        let j; try { j = JSON.parse(body); } catch { return json(400, { error: 'bad json' }); }
        const fader = Number(j.fader);
        const channels = Array.isArray(j.channels) ? j.channels.map(Number) : [];
        if (!Number.isFinite(fader) || fader < 0 || fader > 1) return json(400, { error: 'fader 0..1' });
        if (!channels.length || channels.length > 4 || channels.some((c) => !Number.isInteger(c) || c < 1 || c > 32)) return json(400, { error: 'channels' });
        if (j.player === 1 || j.player === 2) cfg.players[j.player] = channels;
        const speed = j.speed === undefined ? undefined : Number(j.speed);
        for (const c of channels) setFader(c, fader, { speed, instant: j.instant === true });
        json(200, { ok: true });
      });
      return undefined;
    }
    return json(404, { error: 'not found' });
  });

  return {
    cfg, state, micState, discover, fad,
    async start() {
      await new Promise((r) => sock.bind(0, r));
      keepAlive(); pollMics(); queryFaders(usedChannels());
      timers.push(setInterval(keepAlive, 4000), setInterval(pollMics, 400), setInterval(glide, cfg.glideMs));
      await new Promise((r) => server.listen(cfg.port, cfg.bind, r));
      return server.address().port;
    },
    async stop() { timers.forEach(clearInterval); sock.close(); await new Promise((r) => server.close(r)); },
  };
}

export { parseList };
