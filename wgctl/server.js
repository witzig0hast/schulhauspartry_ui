// Kleiner Verwaltungsdienst fuer den WireGuard-Server. Teilt sich das Netzwerk mit dem wg-Container und lauscht
// NUR auf 127.0.0.1 (also nur fuer die App im selben Container-Netzwerk) und verlangt ein Token.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { NAME_RE, DEVICE_NET, genKeys, parseConf, nextIp, peerBlock, addPeer, removePeer, clientConf, parseDump } from './lib.js';

const TOKEN = process.env.WGCTL_TOKEN || '';
const CONF = process.env.WG_CONF || '/config/wg_confs/wg0.conf';
const CONFIG_DIR = process.env.WG_CONFIG_DIR || '/config';
const IFACE = process.env.WG_IFACE || 'wg0';
const ENDPOINT_HOST = process.env.WG_SERVERURL || '';
const PORT = process.env.WG_PORT || '51820';
if (TOKEN.length < 16) { console.error('WGCTL_TOKEN fehlt oder ist zu kurz (min. 16 Zeichen) – die VPN-Verwaltung bleibt ausgeschaltet.'); setInterval(() => {}, 1 << 30); await new Promise(() => {}); }

const sh = (cmd) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });
const serverPub = () => sh(`wg show ${IFACE} public-key`).trim();
const apply = () => sh(`wg syncconf ${IFACE} <(wg-quick strip ${CONF})`);
const peerFile = (name) => path.join(CONFIG_DIR, `peer_${name}`, `peer_${name}.conf`);
const authOk = (req) => { const a = Buffer.from(String(req.headers.authorization || '')), b = Buffer.from(`Bearer ${TOKEN}`); return a.length === b.length && crypto.timingSafeEqual(a, b); };

function status() {
  const { peers } = parseConf(fs.readFileSync(CONF, 'utf8'));
  let live = [];
  try { live = parseDump(sh(`wg show ${IFACE} dump`)); } catch { /* Schnittstelle down */ }
  const now = Math.floor(Date.now() / 1000);
  return {
    server: { publicKey: (() => { try { return serverPub(); } catch { return null; } })(), endpoint: ENDPOINT_HOST ? `${ENDPOINT_HOST}:${PORT}` : null },
    peers: peers.map((p) => {
      const l = live.find((x) => x.publicKey === p.publicKey) || {};
      const ago = l.handshake ? now - l.handshake : null;
      return { name: p.name, ip: (p.allowedIps.find((a) => /\/32$/.test(a)) || '').replace('/32', ''), allowedIps: p.allowedIps, publicKey: p.publicKey, endpoint: l.endpoint || null, handshakeAgoSec: ago, online: ago != null && ago < 180, rx: l.rx || 0, tx: l.tx || 0, hasConfig: fs.existsSync(peerFile(p.name)) };
    }),
  };
}

function createPeer(name, behind) {
  if (!NAME_RE.test(name)) throw Object.assign(new Error('Name: 1–20 Zeichen, a–z, 0–9, Bindestrich.'), { status: 400 });
  if (!ENDPOINT_HOST || ENDPOINT_HOST === 'auto') throw Object.assign(new Error('WG_SERVERURL ist nicht gesetzt.'), { status: 500 });
  const text = fs.readFileSync(CONF, 'utf8');
  if (parseConf(text).peers.some((p) => p.name === name)) throw Object.assign(new Error('Diesen Namen gibt es schon.'), { status: 409 });
  const ip = nextIp(text);
  const k = genKeys();
  const block = peerBlock({ name, pub: k.pub, psk: k.psk, ips: behind ? [`${ip}/32`, DEVICE_NET] : [`${ip}/32`] });
  fs.copyFileSync(CONF, `${CONF}.bak`);
  fs.writeFileSync(CONF, addPeer(text, block), { mode: 0o600 });
  try { apply(); } catch (e) { fs.copyFileSync(`${CONF}.bak`, CONF); throw new Error(`WireGuard konnte die Änderung nicht übernehmen: ${e.message.split('\n')[0]}`); }
  const conf = clientConf({ ip, priv: k.priv, serverPub: serverPub(), psk: k.psk, endpoint: `${ENDPOINT_HOST}:${PORT}` });
  fs.mkdirSync(path.dirname(peerFile(name)), { recursive: true });
  fs.writeFileSync(peerFile(name), conf, { mode: 0o600 });
  return { name, ip, config: conf };
}

function deletePeer(name) {
  const text = fs.readFileSync(CONF, 'utf8');
  const p = parseConf(text).peers.find((x) => x.name === name);
  if (!p) throw Object.assign(new Error('Nicht gefunden.'), { status: 404 });
  const next = removePeer(text, p.publicKey);
  fs.copyFileSync(CONF, `${CONF}.bak`);
  fs.writeFileSync(CONF, next, { mode: 0o600 });
  try { apply(); } catch (e) { fs.copyFileSync(`${CONF}.bak`, CONF); throw new Error(`WireGuard konnte die Änderung nicht übernehmen: ${e.message.split('\n')[0]}`); }
  fs.rmSync(path.dirname(peerFile(name)), { recursive: true, force: true });
  return { ok: true };
}

http.createServer((req, res) => {
  const out = (code, obj, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(obj) : obj); };
  if (!authOk(req)) return out(401, { error: 'unauthorized' });
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    try {
      const u = req.url.split('?')[0];
      if (req.method === 'GET' && u === '/status') return out(200, status());
      if (req.method === 'POST' && u === '/peers') { const j = JSON.parse(body || '{}'); return out(200, createPeer(String(j.name || '').toLowerCase().trim(), !!j.behind)); }
      let m;
      if (req.method === 'DELETE' && (m = /^\/peers\/([a-z0-9-]+)$/.exec(u))) return out(200, deletePeer(m[1]));
      if (req.method === 'GET' && (m = /^\/peers\/([a-z0-9-]+)\/config$/.exec(u))) {
        if (!fs.existsSync(peerFile(m[1]))) return out(404, { error: 'Keine gespeicherte Konfiguration.' });
        return out(200, fs.readFileSync(peerFile(m[1]), 'utf8'), 'text/plain');
      }
      return out(404, { error: 'not found' });
    } catch (e) { out(e.status || 500, { error: e.message }); }
  });
}).listen(Number(process.env.WGCTL_PORT || 3100), '127.0.0.1', () => console.log('[wgctl] bereit auf 127.0.0.1:3100'));
