// Reine Logik zur Verwaltung der WireGuard-Konfiguration (ohne Systemaufrufe, damit testbar)
import crypto from 'node:crypto';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;
export const DEVICE_NET = '10.8.0.192/26';   // fuer Geraete hinter einem Peer (z. B. X32 hinter dem Pi) reserviert

// Schluesselpaar im WireGuard-Format (Curve25519, base64)
export function genKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const raw = (k, pub) => k.export({ format: 'der', type: pub ? 'spki' : 'pkcs8' }).subarray(-32).toString('base64');
  return { priv: raw(privateKey, false), pub: raw(publicKey, true), psk: crypto.randomBytes(32).toString('base64') };
}

// wg0.conf in Interface-Teil und Peers zerlegen
export function parseConf(text) {
  const parts = String(text).split(/^(?=\[(?:Interface|Peer)\])/m);
  const peers = [];
  let head = '';
  for (const p of parts) {
    if (/^\[Peer\]/.test(p)) {
      const get = (k) => (p.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm')) || [])[1]?.trim() || '';
      const c = (p.match(/^#\s*(?:ID\s*=\s*)?(\S+)/m) || [])[1] || '';
      peers.push({ name: c.replace(/^peer_/, ''), publicKey: get('PublicKey'), presharedKey: get('PresharedKey'), allowedIps: get('AllowedIPs').split(',').map((s) => s.trim()).filter(Boolean), raw: p });
    } else head += p;
  }
  return { head, peers };
}

const ipNum = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);

// naechste freie Tunnel-Adresse 10.8.0.2 .. 10.8.0.190
export function nextIp(text) {
  const used = new Set(['10.8.0.1']);
  for (const m of String(text).matchAll(/\b(10\.8\.0\.\d{1,3})(?:\/32)?\b/g)) used.add(m[1]);
  for (let i = 2; i < 192; i++) { const ip = `10.8.0.${i}`; if (!used.has(ip)) return ip; }
  throw new Error('Keine freie Adresse mehr im Tunnelnetz.');
}

export function peerBlock({ name, pub, psk, ips }) {
  return `[Peer]\n# peer_${name}\nPublicKey = ${pub}\nPresharedKey = ${psk}\nAllowedIPs = ${ips.join(',')}\n`;
}

export function addPeer(text, block) { return String(text).replace(/\s*$/, '\n\n') + block; }

export function removePeer(text, publicKey) {
  const { head, peers } = parseConf(text);
  const keep = peers.filter((p) => p.publicKey !== publicKey);
  if (keep.length === peers.length) return null;
  return head.replace(/\s*$/, '\n\n') + keep.map((p) => p.raw.replace(/\s*$/, '\n')).join('\n');
}

export function clientConf({ ip, priv, serverPub, psk, endpoint, allowed = '10.8.0.0/24' }) {
  return `[Interface]\nAddress = ${ip}/32\nPrivateKey = ${priv}\n\n[Peer]\nPublicKey = ${serverPub}\nPresharedKey = ${psk}\nEndpoint = ${endpoint}\nAllowedIPs = ${allowed}\nPersistentKeepalive = 25\n`;
}

// `wg show wg0 dump` -> Liste (erste Zeile ist die Schnittstelle)
export function parseDump(dump) {
  return String(dump).trim().split('\n').slice(1).map((l) => {
    const f = l.split('\t');
    return { publicKey: f[0], endpoint: f[2] === '(none)' ? null : f[2], allowedIps: (f[3] || '').split(','), handshake: Number(f[4]) || 0, rx: Number(f[5]) || 0, tx: Number(f[6]) || 0 };
  });
}
export { ipNum };
