import express from 'express';
import crypto from 'node:crypto';
import { requirePerm, createAccount, revokeAccount, deleteAccount, ROLES, ROLE_LABELS } from '../auth.js';
import { getDb } from '../db.js';
import { applyPatch, publicSettings, settings, setPlayerToken } from '../settings.js';
import * as rq from '../requests.js';
import { config } from '../config.js';
import { authorizeUrl, exchangeCode } from '../adapters/spotify-real.js';
import { RealPlayer } from '../adapters/spotify-real.js';

const oauthStates = new Map(); // state -> {player, exp}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // CSV-Injection verhindern
  return `"${s.replace(/"/g, '""')}"`;
};

export function buildReport(env) {
  const db = getDb();
  const get = (sql, ...p) => db.prepare(sql).all(...p);
  const byStatus = Object.fromEntries(get('SELECT status, COUNT(*) c FROM requests WHERE env = ? GROUP BY status', env).map((r) => [r.status, r.c]));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const decided = (byStatus.approved || 0) + (byStatus.played || 0) + (byStatus.playing || 0) + (byStatus.denied || 0) + (byStatus.removed || 0);
  const approvedLike = (byStatus.approved || 0) + (byStatus.played || 0) + (byStatus.playing || 0);
  const top = get('SELECT title, artist, votes, status FROM requests WHERE env = ? ORDER BY votes DESC, id ASC LIMIT 10', env);
  const peaks = get('SELECT (created_at / 900000) * 900000 AS bucket, COUNT(*) c FROM requests WHERE env = ? GROUP BY bucket ORDER BY c DESC LIMIT 5', env);
  const perCode = get(`SELECT a.id, a.label, a.role,
      SUM(CASE WHEN r.status IN ('approved','playing','played','removed') THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN r.status = 'denied' THEN 1 ELSE 0 END) AS denied
    FROM accounts a LEFT JOIN requests r ON r.decided_by = a.id AND r.env = ?
    GROUP BY a.id ORDER BY a.id`, env);
  const prio = get('SELECT COUNT(*) c FROM requests WHERE env = ? AND prioritized_at IS NOT NULL', env)[0].c;
  const plays = get('SELECT COUNT(*) c, MIN(ts) first, MAX(ts) last FROM plays WHERE env = ?', env)[0];
  const devices = get('SELECT COUNT(DISTINCT device_id) c FROM guest_actions WHERE env = ?', env)[0].c;
  const errors = get("SELECT COUNT(*) c FROM events WHERE env = ? AND type = 'error'", env)[0].c;
  const panics = get("SELECT COUNT(*) c FROM events WHERE env = ? AND type = 'panic'", env)[0].c;
  return {
    env, totals: { requests: total, approved: approvedLike, denied: byStatus.denied || 0, pending: byStatus.pending || 0, played: (byStatus.played || 0) + (byStatus.playing || 0), approvalRate: decided ? Math.round(100 * approvedLike / decided) : null, prioritized: prio, guestDevices: devices },
    plays: { count: plays.c, first: plays.first, last: plays.last },
    top, peaks: peaks.map((p) => ({ from: p.bucket, count: p.c })), perCode, errors, panics,
  };
}

export function setlistCsv(env) {
  const rows = getDb().prepare(`SELECT p.ts, p.player, p.title, p.artist, p.request_id, r.votes, r.prioritized_at
    FROM plays p LEFT JOIN requests r ON r.id = p.request_id WHERE p.env = ? ORDER BY p.ts ASC`).all(env);
  const head = ['Nr', 'Uhrzeit', 'Player', 'Titel', 'Interpret', 'Gewuenscht', 'Votes', 'Priorisiert'];
  const lines = [head.join(';')];
  rows.forEach((x, i) => lines.push([
    i + 1, new Date(x.ts).toISOString(), x.player, x.title, x.artist, x.request_id ? 'ja' : 'nein', x.votes ?? '', x.prioritized_at ? 'ja' : '',
  ].map(csvCell).join(';')));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function adminRouter(env, engine, hub, { engines, setRealEnv }) {
  const r = express.Router();
  const json = express.json({ limit: '16kb' });
  const adm = requirePerm('viewAdmin');
  r.use('/admin', adm, json);

  r.get('/admin/settings', (req, res) => {
    const s = publicSettings();
    res.json({
      settings: s,
      roles: ROLES.filter((x) => x !== 'admin').map((id) => ({ id, label: ROLE_LABELS[id] })),
      publicUrl: config.publicUrl,
      redirectUri: `${config.publicUrl || ''}/api/admin/spotify/callback`,
      spotifyConfigured: !!(s.spotify.clientId && s.spotify.clientSecret) || !!config.spotifyClientId,
      env,
      counts: Object.fromEntries(Object.keys(engines).map((e) => [e, rq.counts(e)])),
      connections: Object.fromEntries(Object.entries(engines).map(([k, v]) => [k, v.connections()])),
    });
  });

  r.post('/admin/settings', wrap((req, res) => {
    const allow = ['limit', 'explicitMode', 'rejectReasons', 'notice', 'wishMessages', 'priorityWithin', 'replay', 'fadePresets', 'auto', 'ducking', 'x32', 'test', 'spotify'];
    const before = settings().test.realEnv;
    const beforeEnabled = settings().test.enabled;
    applyPatch(req.body || {}, { allow });
    if (settings().test.realEnv !== before) setRealEnv();
    if (!settings().test.enabled && beforeEnabled) hub.closeEnv('test');
    for (const e of Object.keys(engines)) engines[e].syncSettings();
    res.json({ ok: true });
  }));

  // ----- Codes -----
  r.get('/admin/accounts', (req, res) => {
    const rows = getDb().prepare(`SELECT a.id, a.role, a.label, a.created_at, a.revoked, a.last_seen,
      (SELECT COUNT(*) FROM requests WHERE decided_by = a.id AND status IN ('approved','playing','played','removed')) AS approved,
      (SELECT COUNT(*) FROM requests WHERE decided_by = a.id AND status = 'denied') AS denied,
      (SELECT COUNT(*) FROM requests WHERE prioritized_by = a.id) AS prioritized
      FROM accounts a ORDER BY a.id`).all();
    res.json({ accounts: rows.map((x) => ({ ...x, revoked: !!x.revoked, roleLabel: ROLE_LABELS[x.role] })) });
  });
  r.post('/admin/accounts', wrap((req, res) => {
    const out = createAccount(String(req.body?.role), String(req.body?.label || ''));
    res.json({ ok: true, ...out }); // Klartext-Code nur dieses eine Mal
  }));
  r.post('/admin/accounts/:id/revoke', wrap((req, res) => { revokeAccount(Number(req.params.id)); hub.kickSession(Number(req.params.id)); res.json({ ok: true }); }));
  r.delete('/admin/accounts/:id', wrap((req, res) => { deleteAccount(Number(req.params.id)); hub.kickSession(Number(req.params.id)); res.json({ ok: true }); }));
  r.get('/admin/accounts/:id/decisions', (req, res) => {
    const rows = getDb().prepare(`SELECT id, title, artist, status, reason, decided_at FROM requests WHERE decided_by = ? AND env = ? ORDER BY decided_at DESC LIMIT 200`).all(Number(req.params.id), env);
    res.json({ decisions: rows });
  });

  // ----- Spotify verbinden -----
  r.post('/admin/spotify/connect', wrap((req, res) => {
    const p = Number(req.body?.player);
    if (p !== 1 && p !== 2) throw new Error('Ungültiger Player');
    if (!config.publicUrl) throw new Error('PUBLIC_URL ist nicht gesetzt (nötig für den Spotify-Redirect).');
    const state = crypto.randomBytes(24).toString('base64url');
    oauthStates.set(state, { player: p, exp: Date.now() + 10 * 60000 });
    res.json({ url: authorizeUrl(state, `${config.publicUrl}/api/admin/spotify/callback`) });
  }));
  r.get('/admin/spotify/devices/:player', wrap(async (req, res) => {
    const p = Number(req.params.player);
    const probe = new RealPlayer(p);
    res.json({ devices: (await probe.devices()).map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active })) });
  }));

  // ----- Bericht / Export / Reset -----
  r.get('/admin/report', (req, res) => res.json(buildReport(req.query.env === 'test' ? 'test' : 'live')));
  r.get('/admin/setlist.csv', (req, res) => {
    const e = req.query.env === 'test' ? 'test' : 'live';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="setlist-${e}.csv"`);
    res.send(setlistCsv(e));
  });
  // Zuruecksetzen: loescht Wuensche, Queue, Setlist und Zaehler einer Umgebung und stoppt die Wiedergabe.
  // Codes und Einstellungen bleiben erhalten. Fuer "live" ist eine getippte Bestaetigung noetig.
  r.post('/admin/reset', wrap((req, res) => {
    const target = req.body?.env === 'test' ? 'test' : req.body?.env === 'live' ? 'live' : null;
    if (!target) throw new Error('Umgebung fehlt');
    if (target === 'live' && req.body?.confirm !== 'ZURÜCKSETZEN') throw new Error('Bestätigung fehlt');
    rq.resetEnv(target);
    engines[target].resetAll();
    hub.pushEnv(target, { guests: true });
    res.json({ ok: true });
  }));
  return r;
}

// Callback darf ohne Session-Cookie laufen (Strict-Cookie wird bei Redirect von Spotify nicht gesendet);
// der geheime, einmalige state-Wert ist hier der Nachweis.
export function spotifyCallbackRouter(onConnected) {
  const r = express.Router();
  r.get('/api/admin/spotify/callback', async (req, res) => {
    const st = oauthStates.get(String(req.query.state || ''));
    oauthStates.delete(String(req.query.state || ''));
    if (!st || st.exp < Date.now() || !req.query.code) return res.status(400).send('Ungültige oder abgelaufene Anfrage.');
    try {
      const out = await exchangeCode(String(req.query.code), `${config.publicUrl}/api/admin/spotify/callback`);
      setPlayerToken(st.player, out.refreshToken, `${out.user}${out.product ? ` (${out.product})` : ''}`);
      onConnected?.(st.player);
      res.redirect('/admin#verbindungen');
    } catch (e) { res.status(502).send('Spotify-Verbindung fehlgeschlagen.'); }
  });
  return r;
}
