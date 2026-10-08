import fs from 'node:fs';
import path from 'node:path';
import { getDb, dataDirPath, logEvent } from './db.js';
import { settings } from './settings.js';
import { sendNotify } from './notify.js';

const NAME = /^party-\d{8}-\d{6}(-[a-z0-9-]+)?\.db$/;
const dir = () => (dataDirPath ? path.join(dataDirPath, 'backups') : null);
const stamp = (d = new Date()) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})(\d{6})$/, '$1-$2');

export function listBackups() {
  const d = dir();
  if (!d || !fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => NAME.test(f)).map((f) => {
    const st = fs.statSync(path.join(d, f));
    return { name: f, size: st.size, ts: st.mtimeMs };
  }).sort((a, b) => b.ts - a.ts);
}

export const backupPath = (name) => (NAME.test(name) && dir() ? path.join(dir(), name) : null);

// Konsistente Kopie der laufenden Datenbank (VACUUM INTO)
export function backupNow(reason = '') {
  const d = dir();
  if (!d) throw new Error('Backups sind im Speicher-Modus nicht möglich.');
  fs.mkdirSync(d, { recursive: true });
  const tag = reason ? `-${String(reason).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20).replace(/^-|-$/g, '')}` : '';
  const ms = String(Date.now() % 1000).padStart(3, '0'); // eindeutig, auch bei zwei Backups in derselben Sekunde
  const file = path.join(d, `party-${stamp()}${tag}-${ms}.db`);
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  prune();
  return { name: path.basename(file), size: fs.statSync(file).size };
}

function prune() {
  const keep = settings().backup.keep;
  for (const b of listBackups().slice(keep)) fs.rmSync(path.join(dir(), b.name), { force: true });
}

export function startBackupScheduler() {
  const t = setInterval(() => {
    try {
      const b = settings().backup;
      if (!b.enabled || !dir()) return;
      const last = listBackups()[0];
      if (!last || Date.now() - last.ts >= b.everyMin * 60000) backupNow('auto');
    } catch (e) {
      logEvent('live', 'backup-error', { msg: e.message });
      if (settings().notify.events.backup) sendNotify({ title: '⚠️ Backup fehlgeschlagen', message: e.message, priority: 3, tags: ['floppy_disk'], key: 'backup-fail' });
    }
  }, 60000);
  t.unref?.();
  return () => clearInterval(t);
}
