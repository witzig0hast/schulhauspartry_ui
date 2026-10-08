import { getDb } from './db.js';

// Sicherheitsprotokoll (nur fuer den Admin sichtbar): Anmeldungen, Codes, Passkeys, Einstellungen ...
export function audit(kind, who = null, ip = null, detail = null) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO security_log(ts, kind, who, ip, detail) VALUES(?,?,?,?,?)').run(Date.now(), kind, who ? String(who).slice(0, 60) : null, ip ? String(ip).slice(0, 60) : null, detail ? String(detail).slice(0, 300) : null);
    db.prepare('DELETE FROM security_log WHERE id <= (SELECT MAX(id) FROM security_log) - 1000').run();
  } catch { /* Protokoll darf nie etwas kaputt machen */ }
}

export const recentAudit = (limit = 150) => getDb().prepare('SELECT * FROM security_log ORDER BY id DESC LIMIT ?').all(limit);
