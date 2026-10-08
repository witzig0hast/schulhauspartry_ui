import net from 'node:net';
import { settings } from './settings.js';

// IPv4/IPv6 gegen eine Liste aus Einzeladressen und CIDR-Bereichen pruefen
function toBig(ip) {
  const v = net.isIP(ip);
  if (v === 4) return { v, n: ip.split('.').reduce((a, b) => (a << 8n) + BigInt(b), 0n), bits: 32 };
  if (v === 6) {
    let h = ip.toLowerCase();
    const m4 = h.match(/(\d+\.\d+\.\d+\.\d+)$/); // ::ffff:1.2.3.4
    if (m4) { const p = m4[1].split('.').map(Number); h = h.replace(m4[1], `${((p[0] << 8) + p[1]).toString(16)}:${((p[2] << 8) + p[3]).toString(16)}`); }
    const [a, b = ''] = h.split('::');
    const left = a ? a.split(':') : [], right = b ? b.split(':') : [];
    const mid = h.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
    const parts = [...left, ...mid, ...right];
    if (parts.length !== 8) return null;
    return { v, n: parts.reduce((x, p) => (x << 16n) + BigInt(parseInt(p || '0', 16)), 0n), bits: 128 };
  }
  return null;
}

export function ipMatches(ip, entry) {
  const a = toBig(String(ip).replace(/^::ffff:/i, ''));
  const [base, len] = String(entry).split('/');
  const b = toBig(base);
  if (!a || !b) return false;
  // IPv4-gemappte Adressen als IPv4 behandeln
  if (a.v !== b.v) return false;
  const bits = len == null ? b.bits : Math.min(b.bits, Math.max(0, Number(len)));
  const shift = BigInt(b.bits - bits);
  return (a.n >> shift) === (b.n >> shift);
}

export function adminIpAllowed(ip) {
  const list = settings().security.adminIpAllow;
  if (!list.length) return true;
  return list.some((e) => ipMatches(ip, e));
}
