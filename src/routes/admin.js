import express from 'express';
import crypto from 'node:crypto';
import { requirePerm, adminIpGuard, clientIp, createAccount, revokeAccount, deleteAccount, ROLES, ROLE_LABELS, START_VIEWS, startViewAllowed, can } from '../auth.js';
import { getDb } from '../db.js';
import { applyPatch, publicSettings, settings, setPlayerToken, spotifyApps } from '../settings.js';
import * as rq from '../requests.js';
import { config } from '../config.js';
import { authorizeUrl, exchangeCode, explainSpotifyError } from '../adapters/spotify-real.js';
import * as L from '../log.js';
import { RealPlayer } from '../adapters/spotify-real.js';
import { HttpX32 } from '../adapters/x32.js';
import { audit } from '../audit.js';
import { testConnection, unlinkFor } from '../sso.js';
import { backupNow } from '../backup.js';
import { cacheInfo, cacheClear } from '../apicache.js';
import { FEATURES, GROUPS, allFlags, isOn } from '../features.js';

const oauthStates = new Map(); // state -> {player, appId, exp}

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
  r.use('/admin', adminIpGuard, adm, json);

  r.get('/admin/settings', (req, res) => {
    const s = publicSettings();
    res.json({
      settings: s,
      roles: ROLES.filter((x) => x !== 'admin').map((id) => ({ id, label: ROLE_LABELS[id], views: START_VIEWS.filter((v) => can(id, v.perm) && (!v.feature || isOn(v.feature))).map((v) => v.path) })),
      startViews: START_VIEWS.map(({ path, label }) => ({ path, label })),
      publicUrl: config.publicUrl,
      features: { list: FEATURES, groups: GROUPS, flags: allFlags() },
      redirectUri: `${config.publicUrl || ''}/api/admin/spotify/callback`,
      evening: Object.fromEntries(Object.entries(engines).map(([k, v]) => [k, v.snapshot().opening])),
      ssoRedirectUri: `${config.publicUrl || ''}/api/sso/callback`,
      spotifyConfigured: spotifyApps(config).length > 0,
      spotifyEnvApp: !s.spotify.apps.length && !!config.spotifyClientId,
      env,
      counts: Object.fromEntries(Object.keys(engines).map((e) => [e, rq.counts(e)])),
      connections: Object.fromEntries(Object.entries(engines).map(([k, v]) => [k, v.connections()])),
      apiCache: cacheInfo(),
    });
  });

  r.post('/admin/settings', wrap((req, res) => {
    const allow = ['start', 'opening', 'operation', 'sso', 'limit', 'explicitMode', 'rejectReasons', 'notice', 'wishMessages', 'priorityWithin', 'replay', 'features', 'security', 'voting', 'handover', 'limits', 'pause', 'roleHome', 'roleBoards', 'timezone', 'autoOrder', 'filler', 'emergency', 'notify', 'backup', 'brand', 'fadePresets', 'auto', 'ducking', 'x32', 'test', 'spotify', 'levels', 'ai', 'logs', 'companion'];
    const before = settings().test.realEnv;
    const beforeEnabled = settings().test.enabled;
    const modeBefore = settings().operation.mode;
    const appsBefore = JSON.stringify([settings().spotify.apps, [1, 2].map((p) => settings().spotify.players[p].appId)]);
    const gateBefore = settings().opening.enabled, atBefore = settings().opening.at, autoBefore = settings().opening.auto;
    const x32Before = `${settings().x32.host}:${settings().x32.port}`;
    applyPatch(req.body || {}, { allow });
    if (`${settings().x32.host}:${settings().x32.port}` !== x32Before) {
      const x = settings().x32;
      L.info('verbindung', 'x32.host', x.host ? `X32-Adresse auf ${x.host}:${x.port} gesetzt` : 'X32-Adresse zurückgesetzt (gilt wieder die vom Pi)', { env: 'system', actor: { kind: 'staff', label: req.session.label }, data: { before: x32Before, host: x.host, port: x.port } });
    }
    const gate = settings().opening;
    if (gate.enabled && !gateBefore) for (const e of Object.values(engines)) e.armOpening();
    else if (!gate.enabled && gateBefore) for (const e of Object.values(engines)) { if (e.state.awaitOpen) e.openWishes(); }
    else if (gate.enabled && (gate.at !== atBefore || gate.auto !== autoBefore)) for (const e of Object.values(engines)) { if (e.state.awaitOpen) e.armOpening(); }
    if (settings().operation.mode !== modeBefore) {
      audit('mode.change', req.session.label, clientIp(req), `${modeBefore} -> ${settings().operation.mode}`);
      // beim Wechsel in den Wunschlisten-Modus laufende Player anhalten (die App steuert sie danach nicht mehr)
      if (settings().operation.mode === 'wishlist') for (const e of Object.values(engines)) for (const n of [1, 2]) e.players[n].pause().catch(() => {});
    }
    audit('settings.change', req.session.label, clientIp(req), Object.keys(req.body || {}).filter((k) => allow.includes(k)).join(', ').slice(0, 200));
    if (settings().test.realEnv !== before) setRealEnv();
    // andere Apps / Zugangsdaten: Spotify-Adapter neu aufbauen (Player sprechen dann ueber ihre neue App)
    else if (JSON.stringify([settings().spotify.apps, [1, 2].map((p) => settings().spotify.players[p].appId)]) !== appsBefore) for (const e of Object.values(engines)) e.setReal(e.realConnections, true);
    if (!settings().test.enabled && beforeEnabled) hub.closeEnv('test');
    for (const e of Object.keys(engines)) engines[e].syncSettings();
    res.json({ ok: true });
  }));

  // Gespeicherte Spotify-Antworten und Cover leeren (danach fragt die App bei Bedarf neu)
  r.post('/admin/cache/clear', wrap((req, res) => { cacheClear(); audit('cache.clear', req.session.label, clientIp(req)); res.json({ ok: true }); }));

  r.post('/admin/sso/test', wrap(async (req, res) => {
    try { res.json({ ok: true, ...(await testConnection()) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  }));

  // ----- Codes -----
  r.get('/admin/accounts', (req, res) => {
    const rows = getDb().prepare(`SELECT a.id, a.role, a.label, a.created_at, a.revoked, a.last_seen,
      (SELECT COUNT(*) FROM requests WHERE decided_by = a.id AND status IN ('approved','playing','played','removed')) AS approved,
      (SELECT COUNT(*) FROM requests WHERE decided_by = a.id AND status = 'denied') AS denied,
      (SELECT COUNT(*) FROM requests WHERE prioritized_by = a.id) AS prioritized,
      (a.code_hash LIKE 'sso:%') AS sso, a.email AS email, a.home AS home,
      (SELECT COUNT(*) FROM sso_links l WHERE l.kind = 'account' AND l.account_id = a.id) AS sso_links
      FROM accounts a ORDER BY a.id`).all();
    res.json({ accounts: rows.map((x) => ({ ...x, revoked: !!x.revoked, sso: !!x.sso, ssoLinked: x.sso_links > 0, roleLabel: ROLE_LABELS[x.role] })) });
  });
  r.post('/admin/accounts', wrap((req, res) => {
    const out = createAccount(String(req.body?.role), String(req.body?.label || ''));
    const home = String(req.body?.home || '');
    if (home && startViewAllowed(out.role, home)) getDb().prepare('UPDATE accounts SET home = ? WHERE id = ?').run(home, out.id);
    audit('account.create', req.session.label, clientIp(req), `${out.role} #${out.id}${home ? ` → ${home}` : ''}`);
    res.json({ ok: true, ...out }); // Klartext-Code nur dieses eine Mal
  }));
  // E-Mail fuer die automatische SSO-Zuordnung und Verbindung zu einem SSO-Konto loesen
  r.post('/admin/accounts/:id/email', wrap((req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Ungültige E-Mail-Adresse.');
    getDb().prepare("UPDATE accounts SET email = ? WHERE id = ? AND code_hash NOT LIKE 'sso:%'").run(email || null, Number(req.params.id));
    audit('account.email', req.session.label, clientIp(req), `#${req.params.id}`);
    res.json({ ok: true });
  }));
  // Startansicht/Dashboard eines Codes (leer = Standard der Rolle)
  r.post('/admin/accounts/:id/home', wrap((req, res) => {
    const acc = getDb().prepare('SELECT role FROM accounts WHERE id = ?').get(Number(req.params.id));
    if (!acc) throw Object.assign(new Error('Zugang nicht gefunden'), { status: 404 });
    const home = String(req.body?.home || '');
    if (home && !startViewAllowed(acc.role, home)) throw new Error('Diese Ansicht darf die Rolle nicht öffnen.');
    getDb().prepare('UPDATE accounts SET home = ? WHERE id = ?').run(home || null, Number(req.params.id));
    audit('account.home', req.session.label, clientIp(req), `#${req.params.id} → ${home || 'Standard'}`);
    res.json({ ok: true });
  }));
  r.delete('/admin/accounts/:id/sso', wrap((req, res) => {
    const n = unlinkFor(Number(req.params.id));
    audit('sso.unlink', req.session.label, clientIp(req), `#${req.params.id}`);
    res.json({ ok: true, removed: n });
  }));
  r.post('/admin/accounts/:id/revoke', wrap((req, res) => { audit('account.revoke', req.session.label, clientIp(req), `#${req.params.id}`); revokeAccount(Number(req.params.id)); hub.kickSession(Number(req.params.id)); res.json({ ok: true }); }));
  r.delete('/admin/accounts/:id', wrap((req, res) => { audit('account.delete', req.session.label, clientIp(req), `#${req.params.id}`); deleteAccount(Number(req.params.id)); hub.kickSession(Number(req.params.id)); res.json({ ok: true }); }));
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
    const out = authorizeUrl(state, `${config.publicUrl}/api/admin/spotify/callback`, String(req.body?.appId || ''));
    oauthStates.set(state, { player: p, appId: out.appId, exp: Date.now() + 10 * 60000 });
    res.json({ url: out.url });
  }));
  r.get('/admin/spotify/devices/:player', wrap(async (req, res) => {
    const p = Number(req.params.player);
    const probe = new RealPlayer(p);
    res.json({ devices: (await probe.devices()).map((d) => ({ id: d.id, name: d.name, type: d.type, active: d.is_active })) });
  }));

  // ----- X32: aktuelle Adresse am Relay und Suche im Netz des Pi -----
  const relay = () => {
    if (settings().x32.adapter !== 'http' || !settings().x32.piUrl) throw new Error('Erst die Anbindung „Pi 5 / X32 über HTTP-Relay“ mit Pi-URL und Token speichern.');
    return new HttpX32();
  };
  r.get('/admin/x32/status', wrap(async (req, res) => {
    const a = relay();
    await a._pushConfig(true);
    await a.readState();
    const d = a.desk || {};
    res.json({ host: d.host || null, port: d.port || null, source: d.source || null, envHost: d.envHost || null, deskOk: !!d.ok, lastSeenMs: d.lastSeenMs ?? null });
  }));
  r.post('/admin/x32/discover', wrap(async (req, res) => {
    const found = await relay().discover();
    L.info('verbindung', 'x32.discover', `X32-Suche im Netz des Pi: ${found.length ? found.map((f) => `${f.name || f.model || 'X32'} (${f.host})`).join(', ') : 'nichts gefunden'}`, { env: 'system', actor: { kind: 'staff', label: req.session.label }, data: { found } });
    res.json({ found });
  }));

  // ----- X32-Einrichtung: laeuft ueber die Umgebung mit den echten Verbindungen (sonst simuliert) -----
  const realEngine = () => engines[settings().test.realEnv] || engine;
  const chNum = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 32) throw new Error('Ungültiger Kanal'); return n; };
  r.get('/admin/x32/channels', wrap(async (req, res) => {
    const e = realEngine();
    if (!e.x32.channels) throw new Error('Diese Anbindung kennt keine Kanalübersicht.');
    const out = await e.x32.channels();
    res.json({ ...out, simulated: e.x32.kind === 'mock', env: e.env, assigned: settings().x32.channels });
  }));
  r.post('/admin/x32/select', wrap(async (req, res) => { await realEngine().x32.selectChannel?.(chNum(req.body?.channel)); res.json({ ok: true }); }));
  r.post('/admin/x32/test-music', wrap(async (req, res) => {
    const e = realEngine();
    if (req.body?.stop) { await e.levelTestStop(); return res.json({ ok: true }); }
    const p = Number(req.body?.player);
    if (p !== 1 && p !== 2) throw new Error('Ungültiger Player');
    const t = await e.levelTest(p);
    res.json({ ok: true, title: t.title, artist: t.artist });
  }));
  // Sanfter Fader-Test: Player-Kanaele auf -10 dB und nach 3 s zurueck (die Fahrt selbst macht das Relay gleichmaessig)
  r.post('/admin/x32/fader-test', wrap(async (req, res) => {
    const e = realEngine(), p = Number(req.body?.player);
    if (p !== 1 && p !== 2) throw new Error('Ungültiger Player');
    if (e.state.panic) throw new Error('Not-Aus ist aktiv.');
    e.faderTest = true;
    await e.x32.setPlayerLevel(p, Math.pow(10, -10 / 20) * Math.pow(10, settings().levels.playerDb[p] / 20));
    setTimeout(() => { e.faderTest = false; e.lastSent = { 1: -1, 2: -1 }; }, 3000).unref?.();
    L.info('pult', 'x32.fader_test', `Fader-Test Player ${p} (Kanal ${settings().x32.channels[`p${p}`].join('/')})`, { env: e.env, actor: { kind: 'staff', label: req.session.label } });
    res.json({ ok: true });
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
    if (target === 'live') { try { backupNow('vor-reset'); } catch { /* ohne Backup-Ordner (Tests) */ } }
    audit('reset', req.session.label, clientIp(req), target);
    rq.resetEnv(target);
    engines[target].resetAll();
    hub.pushEnv(target, { guests: true });
    res.json({ ok: true });
  }));
  return r;
}

const escHtml = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Callback darf ohne Session-Cookie laufen (Strict-Cookie wird bei Redirect von Spotify nicht gesendet);
// der geheime, einmalige state-Wert ist hier der Nachweis.
export function spotifyCallbackRouter(onConnected) {
  const r = express.Router();
  r.get('/api/admin/spotify/callback', async (req, res) => {
    const st = oauthStates.get(String(req.query.state || ''));
    oauthStates.delete(String(req.query.state || ''));
    const fail = (status, why, data) => {
      L.error('spotify', 'spotify.connect_failed', `Spotify-Player ${st?.player || '?'} nicht verbunden: ${why}`, { env: 'system', data });
      audit('spotify.connect.fail', null, clientIp(req), why);
      res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spotify-Verbindung</title>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 16px;line-height:1.5"><h1>Spotify-Verbindung fehlgeschlagen</h1><p>${escHtml(why)}</p><p><a href="/admin#verbindungen">Zurück zum Admin</a></p></body>`);
    };
    if (!st || st.exp < Date.now()) return fail(400, 'Ungültige oder abgelaufene Anfrage (Seite neu geladen, länger als 10 Minuten gewartet oder Server neu gestartet). Bitte im Admin neu auf „Verbinden“ drücken.', { known: !!st });
    if (req.query.error || !req.query.code) return fail(400, `Spotify hat abgelehnt: ${String(req.query.error || 'kein Code').slice(0, 60)}`, { error: String(req.query.error || '').slice(0, 60) });
    try {
      const out = await exchangeCode(String(req.query.code), `${config.publicUrl}/api/admin/spotify/callback`, st.appId);
      setPlayerToken(st.player, out.refreshToken, `${out.user}${out.product ? ` (${out.product})` : ''}`, out.appId);
      onConnected?.(st.player);
      L.info('spotify', 'spotify.connected', `Spotify-Player ${st.player} verbunden (${out.user})`, { env: 'system', data: { player: st.player, appId: out.appId, product: out.product || null } });
      res.redirect('/admin#verbindungen');
    } catch (e) {
      fail(400, explainSpotifyError(e), { player: st.player, appId: st.appId || null, message: e.message, spotify: e.spotify || null, redirectUri: `${config.publicUrl}/api/admin/spotify/callback` });
    }
  });
  return r;
}
