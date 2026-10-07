// HTTP-Relay: App (ueber VPN) <-> X32 (OSC ueber UDP, Port 10023)
//   POST /x32/level  {player, channels:[..], fader}  -> setzt /ch/NN/mix/fader
//   GET  /x32/state  -> {mics:[{open,level}], meters:{1,2}, x32:{ok,lastSeenMs}}
//   GET  /healthz    -> ohne Token, nur {ok:true}
import dgram from 'node:dgram';
import http from 'node:http';
import crypto from 'node:crypto';
import { encode, decode, decodeMeters } from './osc.js';

const ch2 = (n) => String(n).padStart(2, '0');
const parseList = (s, d) => (s ? String(s).split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 32) : d);

export function createRelay(opts = {}) {
  const cfg = {
    x32Host: opts.x32Host, x32Port: opts.x32Port ?? 10023,
    token: opts.token, bind: opts.bind ?? '0.0.0.0', port: opts.port ?? 8080,
    mics: opts.mics ?? [5, 6, 7], players: opts.players ?? { 1: [1, 2], 2: [3, 4] },
    micThreshold: opts.micThreshold ?? 0.03, micHoldMs: opts.micHoldMs ?? 600,
  };
  if (!cfg.x32Host) throw new Error('X32_HOST fehlt');
  if (!cfg.token || cfg.token.length < 16) throw new Error('RELAY_TOKEN fehlt oder ist zu kurz (min. 16 Zeichen)');

  const sock = dgram.createSocket('udp4');
  const state = { meters: new Array(32).fill(0), micOn: {}, micActiveUntil: {}, lastSeen: 0, lastMeters: 0 };
  const send = (address, args) => sock.send(encode(address, args), cfg.x32Port, cfg.x32Host);

  sock.on('message', (msg) => {
    state.lastSeen = Date.now();
    let m; try { m = decode(msg); } catch { return; }
    if (m.address === '/meters/1' && Buffer.isBuffer(m.args[0])) {
      try { const v = decodeMeters(m.args[0]); for (let i = 0; i < 32 && i < v.length; i++) state.meters[i] = v[i]; state.lastMeters = Date.now(); } catch { /* ignorieren */ }
    } else {
      const mm = /^\/ch\/(\d\d)\/mix\/on$/.exec(m.address);
      if (mm) state.micOn[Number(mm[1])] = m.args[0] === 1;
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
        x32: { ok: Date.now() - state.lastSeen < 5000, lastSeenMs: state.lastSeen ? Date.now() - state.lastSeen : null },
      });
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
        for (const c of channels) send(`/ch/${ch2(c)}/mix/fader`, [{ t: 'f', v: fader }]);
        json(200, { ok: true });
      });
      return undefined;
    }
    return json(404, { error: 'not found' });
  });

  return {
    cfg, state, micState,
    async start() {
      await new Promise((r) => sock.bind(0, r));
      keepAlive(); pollMics();
      timers.push(setInterval(keepAlive, 4000), setInterval(pollMics, 400));
      await new Promise((r) => server.listen(cfg.port, cfg.bind, r));
      return server.address().port;
    },
    async stop() { timers.forEach(clearInterval); sock.close(); await new Promise((r) => server.close(r)); },
  };
}

export { parseList };
