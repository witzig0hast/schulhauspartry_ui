import express from 'express';
import fs from 'node:fs';
import { requirePerm, requireAnyPerm, createAccount } from '../auth.js';
import { getDb } from '../db.js';
import { settings } from '../settings.js';
import { config } from '../config.js';
import * as rq from '../requests.js';
import { sendNotify } from '../notify.js';
import { backupNow, listBackups, backupPath } from '../backup.js';
import { setLogo, clearLogo } from '../brand.js';
import { setlistPdf } from '../pdf.js';
import { addMessage, recentMessages } from '../chat.js';
import { requireFeature } from '../features.js';

const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } };

// Vorbereitungs-Check: alles, was vor der Party stimmen muss, mit Status und (wo moeglich) Testknopf
export async function prepChecks(env, engine, engines) {
  const s = settings(), db = getDb();
  const checks = [];
  const add = (id, group, label, status, detail, action = null) => checks.push({ id, group, label, status, detail, action });
  const real = engine.spotify.kind === 'real';
  const hasSpotify = !!(s.spotify.clientId || config.spotifyClientId);

  add('url', 'Grundlagen', 'Öffentliche Adresse (PUBLIC_URL)', config.publicUrl ? 'ok' : 'warn', config.publicUrl || 'Nicht gesetzt – nötig für den Spotify-Login und QR-Codes.');
  add('codes', 'Grundlagen', 'Zugangscodes angelegt', (() => { const n = db.prepare("SELECT role, COUNT(*) c FROM accounts WHERE revoked = 0 GROUP BY role").all(); const m = Object.fromEntries(n.map((x) => [x.role, x.c])); return m.tech && m.mod ? 'ok' : 'fail'; })(),
    (() => { const n = db.prepare("SELECT role, COUNT(*) c FROM accounts WHERE revoked = 0 GROUP BY role").all(); return n.length ? n.map((x) => `${x.c}× ${x.role}`).join(', ') : 'Noch keine Codes (Admin → Codes).'; })());
  add('backup', 'Grundlagen', 'Automatische Backups', s.backup.enabled ? (listBackups().length ? 'ok' : 'warn') : 'warn', s.backup.enabled ? `alle ${s.backup.everyMin} Min., ${listBackups().length} vorhanden` : 'Ausgeschaltet', { id: 'backup-now', label: 'Backup jetzt' });
  add('notify', 'Grundlagen', 'Alarm aufs Handy (ntfy)', s.notify.enabled && s.notify.topic ? 'ok' : 'warn', s.notify.enabled && s.notify.topic ? `Topic „${s.notify.topic}“` : 'Nicht eingerichtet (Admin → Automatik).', s.notify.topic ? { id: 'notify-test', label: 'Test senden' } : null);

  add('spotifyapp', 'Spotify', 'Spotify-App eingerichtet', hasSpotify ? 'ok' : 'fail', hasSpotify ? 'Client-ID vorhanden' : 'Client-ID/Secret fehlen (Admin → Verbindungen).');
  for (const n of [1, 2]) {
    const p = s.spotify.players[n];
    const st = engine.players[n].status();
    const premium = /premium/i.test(p.user || '');
    add(`player${n}`, 'Spotify', `Player ${n}`, !p.connected && !p.refreshToken ? (real ? 'fail' : 'info') : st.connected ? (premium || !p.user ? 'ok' : 'warn') : 'fail',
      !p.refreshToken ? (real ? 'Nicht verbunden' : 'Simuliert (kein Spotify-Konto verbunden)') : `${p.user || 'verbunden'}${p.deviceName ? ` · ${p.deviceName}` : p.deviceId ? '' : ' · kein Wiedergabegerät gewählt'}${st.connected ? '' : ' · nicht erreichbar'}${p.user && !premium ? ' · Premium nötig!' : ''}`,
      p.refreshToken ? { id: `player-test:${n}`, label: 'Testton (8 s)' } : null);
  }
  const sp = engine.spotify.health();
  add('search', 'Spotify', 'Suche & Wünsche', sp.ok === false ? 'fail' : sp.ok === null ? 'warn' : real ? 'ok' : 'info', real ? sp.detail : 'Simuliert (Beispielkatalog) – Spotify noch nicht angebunden');

  const x = engine.x32.health();
  add('x32', 'Technik', 'X32 / Pi erreichbar', engine.x32.kind === 'mock' ? 'info' : x.ok ? 'ok' : 'fail', engine.x32.kind === 'mock' ? 'Simuliert – kein echtes Pult angebunden' : x.detail, { id: 'fader-test', label: 'Fader-Test' });
  const mics = engine.x32State.mics || [];
  add('mics', 'Technik', 'Mikrofone', mics.length ? 'ok' : 'warn', mics.length ? mics.map((m) => `${m.name}: ${m.open ? 'offen' : 'stumm'}`).join(' · ') : 'Keine Mic-Daten (Pi/X32 prüfen). Live-Pegel unten.');

  const testPlays = db.prepare("SELECT COUNT(*) c FROM plays WHERE env = 'test'").get().c;
  const testReq = db.prepare("SELECT COUNT(*) c FROM requests WHERE env = 'test' AND status IN ('approved','played','playing','denied')").get().c;
  add('testrun', 'Ablauf', 'Testlauf gemacht', testPlays > 0 && testReq > 0 ? 'ok' : 'warn', testPlays > 0 && testReq > 0 ? `${testReq} Test-Wünsche entschieden, ${testPlays} Songs abgespielt` : 'Einmal im Testmodus durchspielen: Wunsch → Annehmen → Crossfade.');
  add('testoff', 'Ablauf', 'Testmodus ausgeschaltet', s.test.enabled ? 'warn' : 'ok', s.test.enabled ? 'Testmodus ist noch an (Admin → Start & Links).' : 'aus');
  const liveCounts = rq.counts('live');
  add('livedata', 'Ablauf', 'Live-Daten leer', liveCounts.pending + liveCounts.approved + liveCounts.played + liveCounts.denied + liveCounts.later === 0 ? 'ok' : 'warn',
    liveCounts.pending + liveCounts.approved + liveCounts.played + liveCounts.denied + liveCounts.later === 0 ? 'Bereit für den ersten Wunsch' : `Noch Daten vom letzten Mal (${liveCounts.played} gespielt, ${liveCounts.pending} offen) – Admin → Zurücksetzen.`);
  add('emergency', 'Ablauf', 'Notfall-Playlist', s.emergency.playlist ? 'ok' : 'warn', s.emergency.playlist ? 'Eingetragen' : 'Nicht eingetragen (Admin → Automatik) – falls alles ausfällt.');
  add('filler', 'Ablauf', 'Lückenfüller', s.filler.enabled && s.filler.playlist ? 'ok' : 'info', s.filler.enabled && s.filler.playlist ? 'aktiv' : 'aus – bei leerer Warteschlange kann es still werden.');
  add('wish', 'Ablauf', 'Wünsche der Gäste', engine.wishMode === 'open' ? 'ok' : 'warn', { open: 'offen', paused: 'pausiert', closed: 'geschlossen' }[engine.wishMode], engine.wishMode !== 'open' ? { id: 'wish-open', label: 'Wünsche öffnen' } : null);
  void engines;
  if (engine.wishlist) { // ohne Wiedergabe ueber die App sind Player, Pult und Mics nicht noetig
    add('mode', 'Grundlagen', 'Betriebsart', 'info', 'Nur Wunschliste: Wünsche werden angenommen/abgelehnt, der DJ spielt selbst (Admin → Start).');
    for (const c of checks) if (/^(player\d|x32|mics|pi|fader)/.test(c.id)) { c.status = 'info'; c.detail = `nicht nötig (Wunschlisten-Modus) – ${c.detail}`; c.action = null; }
  }
  return checks;
}

export function opsRouter(env, engine, hub, { engines }) {
  const r = express.Router();
  const json = express.json({ limit: '8kb' });

  // ----- Vorbereitung -----
  r.get('/prep/status', requirePerm('viewPrep'), wrap(async (req, res) => {
    const checks = await prepChecks(env, engine, engines);
    res.json({ checks, fail: checks.filter((c) => c.status === 'fail').length, warn: checks.filter((c) => c.status === 'warn').length, env });
  }));
  r.post('/prep/action', requirePerm('viewPrep'), json, wrap(async (req, res) => {
    const id = String(req.body?.id || '');
    if (id === 'fader-test') {
      for (const p of [1, 2]) await engine.x32.setPlayerLevel(p, 0.35);
      setTimeout(() => { for (const p of [1, 2]) engine.x32.setPlayerLevel(p, 1).catch(() => {}); }, 1500).unref?.();
      return res.json({ ok: true, info: 'Beide Fader fahren kurz auf ca. 35 % und zurück – schau am X32.' });
    }
    if (id === 'notify-test') {
      const out = await sendNotify({ title: '🔔 Test', message: 'So sieht ein Alarm der Party-App aus.', priority: 3, tags: ['bell'], force: true, env });
      if (!out.sent) throw new Error(`Nicht gesendet: ${out.reason}`);
      return res.json({ ok: true, info: 'Test gesendet – ist die Nachricht auf deinem Handy?' });
    }
    if (id === 'backup-now') { const b = backupNow('manuell'); return res.json({ ok: true, info: `Backup gespeichert (${b.name}).` }); }
    if (id === 'wish-open') { engine.setWishMode('open'); return res.json({ ok: true, info: 'Wünsche sind offen.' }); }
    if (id.startsWith('player-test:')) {
      const n = Number(id.split(':')[1]);
      if (n !== 1 && n !== 2) throw new Error('Ungültiger Player');
      const t = await engine.testPlayer(n);
      return res.json({ ok: true, info: `Spielt 8 Sekunden leise: ${t.title} – ${t.artist}` });
    }
    throw new Error('Unbekannte Aktion');
  }));

  // ----- Backups (nur Admin) -----
  const adm = requirePerm('viewAdmin');
  r.get('/admin/backups', adm, (req, res) => res.json({ backups: listBackups(), enabled: settings().backup.enabled }));
  r.post('/admin/backups', adm, json, wrap((req, res) => res.json({ ok: true, ...backupNow('manuell') })));
  r.get('/admin/backups/:name', adm, (req, res) => {
    const f = backupPath(req.params.name);
    if (!f || !fs.existsSync(f)) return res.status(404).json({ error: 'Nicht gefunden' });
    res.download(f, req.params.name);
  });

  // ----- Benachrichtigung testen -----
  r.post('/admin/notify/test', adm, json, wrap(async (req, res) => {
    const out = await sendNotify({ title: '🔔 Test', message: 'Die Benachrichtigung funktioniert.', priority: 3, tags: ['bell'], force: true, env });
    if (!out.sent) throw new Error(out.reason);
    res.json({ ok: true });
  }));

  // ----- Design: Logo -----
  r.post('/admin/brand/logo', adm, express.raw({ type: '*/*', limit: '1100kb' }), wrap((req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('Keine Datei empfangen.');
    res.json({ ok: true, ...setLogo(req.body) });
  }));
  r.post('/admin/brand/logo/remove', adm, json, wrap((req, res) => { clearLogo(); res.json({ ok: true }); }));

  // ----- Setlist als PDF -----
  r.get('/admin/setlist.pdf', adm, (req, res) => {
    const e = req.query.env === 'test' ? 'test' : 'live';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="setlist-${e}.pdf"`);
    setlistPdf(e, res);
  });

  // ----- Moderator-Chat -----
  r.get('/chat', requireAnyPerm('viewMod'), (req, res) => res.json({ chat: recentMessages(env) }));
  r.post('/chat', requireFeature('chat'), requirePerm('chatWrite'), json, wrap((req, res) => {
    const m = addMessage(env, req.session.accountId, req.body?.name, req.body?.text);
    hub.pushEnv(env);
    res.json({ ok: true, message: m });
  }));

  // ----- "Wer bearbeitet gerade?" (weiche Sperre) -----
  r.post('/mod/claim', requireFeature('claims'), requirePerm('moderate'), json, wrap((req, res) => {
    hub.claim(env, Number(req.body?.id), req.session.label, req.session.accountId ?? 'admin');
    hub.pushEnv(env);
    res.json({ ok: true });
  }));
  r.post('/mod/claim/release', requirePerm('moderate'), json, wrap((req, res) => {
    hub.release(env, Number(req.body?.id), req.session.accountId ?? 'admin');
    hub.pushEnv(env);
    res.json({ ok: true });
  }));

  void createAccount;
  return r;
}
