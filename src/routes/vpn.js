import express from 'express';
import { requirePerm, adminIpGuard, clientIp } from '../auth.js';
import { requireFeature } from '../features.js';
import { audit } from '../audit.js';
import { config } from '../config.js';

// VPN-Verwaltung: reicht Anfragen des Admins an den Dienst "wgctl" weiter (nur im Container-Netzwerk erreichbar, mit Token).
// Nur der Head-Admin; Konfigurationsdateien enthalten private Schluessel und werden nie gespeichert oder gecacht.
export function vpnRouter() {
  const r = express.Router();
  const guard = [requireFeature('vpnAdmin'), adminIpGuard, requirePerm('viewAdmin'), (req, res, next) => (req.session.accountId == null ? next() : res.status(403).json({ error: 'Nur der Head-Admin.' }))];
  const call = async (method, path, body) => {
    if (!config.wgctlToken) throw Object.assign(new Error('Die VPN-Verwaltung ist nicht eingerichtet (WGCTL_TOKEN fehlt in der .env).'), { status: 503 });
    let res;
    try {
      res = await fetch(config.wgctlUrl + path, { method, headers: { Authorization: `Bearer ${config.wgctlToken}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    } catch { throw Object.assign(new Error('Der VPN-Dienst (wgctl) ist nicht erreichbar. Läuft docker-compose.vpn.yml?'), { status: 503 }); }
    const text = await res.text();
    if (!res.ok) { let msg = `Fehler ${res.status}`; try { msg = JSON.parse(text).error || msg; } catch { /* kein JSON */ } throw Object.assign(new Error(msg), { status: res.status === 401 ? 502 : res.status }); }
    return text;
  };
  const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };
  r.get('/admin/vpn', ...guard, wrap(async (req, res) => res.type('json').send(await call('GET', '/status'))));
  r.post('/admin/vpn/peers', express.json({ limit: '1kb' }), ...guard, wrap(async (req, res) => {
    const out = await call('POST', '/peers', { name: String(req.body?.name || ''), behind: !!req.body?.behind });
    audit('vpn.peer.add', req.session.label, clientIp(req), String(req.body?.name || '').slice(0, 20));
    res.type('json').send(out);
  }));
  r.delete('/admin/vpn/peers/:name', ...guard, wrap(async (req, res) => {
    const out = await call('DELETE', `/peers/${encodeURIComponent(req.params.name)}`);
    audit('vpn.peer.remove', req.session.label, clientIp(req), req.params.name.slice(0, 20));
    res.type('json').send(out);
  }));
  r.get('/admin/vpn/peers/:name/config', ...guard, wrap(async (req, res) => {
    const out = await call('GET', `/peers/${encodeURIComponent(req.params.name)}/config`);
    audit('vpn.peer.config', req.session.label, clientIp(req), req.params.name.slice(0, 20));
    res.set({ 'Content-Disposition': `attachment; filename="${req.params.name.replace(/[^a-z0-9-]/g, '')}.conf"`, 'Cache-Control': 'no-store' }).type('text/plain').send(out);
  }));
  return r;
}
