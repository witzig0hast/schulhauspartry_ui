import express from 'express';
import { requirePerm, can } from '../auth.js';
import { requireFeature } from '../features.js';
import { queryLogs, logCounts, CATS, LEVELS, ADMIN_ONLY } from '../log.js';

// Live-Protokoll lesen (Technik und Admin). Sicherheit/Admin-Eintraege (Logins, IP-Adressen) nur fuer den Admin.
export function logsRouter() {
  const r = express.Router();
  const guard = [requireFeature('viewLogs'), requirePerm('viewLogs')];
  const allowedCats = (role) => Object.keys(CATS).filter((c) => can(role, 'viewAdmin') || !ADMIN_ONLY.has(c));
  const filters = (req) => {
    const allowed = allowedCats(req.session.role);
    const want = String(req.query.cats || '').split(',').filter((c) => allowed.includes(c));
    return {
      env: ['live', 'test', 'system'].includes(req.query.env) ? req.query.env : null,
      minLevel: LEVELS.includes(req.query.level) ? req.query.level : 'info',
      cats: want.length ? want : allowed,
      q: String(req.query.q || '').slice(0, 80),
      before: Number(req.query.before) || null,
    };
  };
  r.get('/logs', ...guard, (req, res) => {
    res.json({ logs: queryLogs({ ...filters(req), limit: Number(req.query.limit) || 300 }), cats: Object.fromEntries(allowedCats(req.session.role).map((c) => [c, CATS[c]])), levels: LEVELS, counts: logCounts() });
  });
  // Export fuer Maschinen: eine JSON-Zeile pro Eintrag (jq, grep, Tabellen …)
  r.get('/logs/export', ...guard, (req, res) => {
    const rows = queryLogs({ ...filters(req), limit: 2000 });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="protokoll-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.jsonl"`);
    res.send(rows.map((e) => JSON.stringify({ ts: new Date(e.ts).toISOString(), env: e.env, level: e.level, cat: e.cat, event: e.event, msg: e.msg, actor: e.actor, data: e.data })).join('\n') + '\n');
  });
  return r;
}
