import { getDb } from './db.js';
import { settings } from './settings.js';
import { isOn } from './features.js';
import { sendNotify } from './notify.js';

// Gast-Geraete: sperren/freigeben und Uebersicht (anonyme Kurz-IDs)
export const isBlocked = (env, deviceId) => isOn('deviceBlock') && !!getDb().prepare('SELECT 1 FROM blocked_devices WHERE env = ? AND device_id = ?').get(env, deviceId);
export const shortId = (id) => String(id).slice(0, 6).toUpperCase();

export function blockDevice(env, deviceId, reason) {
  getDb().prepare('INSERT OR REPLACE INTO blocked_devices(env, device_id, reason, ts) VALUES(?,?,?,?)').run(env, deviceId, String(reason || '').slice(0, 80) || null, Date.now());
  // offene Wuensche dieses Geraets ablehnen
  getDb().prepare("UPDATE requests SET status='denied', reason='Gerät gesperrt', decided_at=? WHERE env = ? AND device_id = ? AND status IN ('pending','later')").run(Date.now(), env, deviceId);
}
export const unblockDevice = (env, deviceId) => getDb().prepare('DELETE FROM blocked_devices WHERE env = ? AND device_id = ?').run(env, deviceId).changes > 0;
export const deviceOfRequest = (env, requestId) => getDb().prepare('SELECT device_id FROM requests WHERE id = ? AND env = ?').get(requestId, env)?.device_id || null;

export function listDevices(env) {
  const rows = getDb().prepare(`SELECT device_id, COUNT(*) total, SUM(status='denied') denied, MAX(created_at) last
    FROM requests WHERE env = ? AND device_id NOT IN ('staff','auto') GROUP BY device_id ORDER BY last DESC LIMIT 80`).all(env);
  const blocked = new Map(getDb().prepare('SELECT device_id, reason FROM blocked_devices WHERE env = ?').all(env).map((b) => [b.device_id, b.reason]));
  return rows.map((r) => ({ id: r.device_id, short: shortId(r.device_id), total: r.total, denied: r.denied || 0, last: r.last, blocked: blocked.has(r.device_id), reason: blocked.get(r.device_id) || null }));
}

// Flut-Erkennung: ungewoehnlich viele Wuensche pro Minute
const stamps = { live: [], test: [] };
export function noteWish(env, now = Date.now()) {
  const list = stamps[env] ||= [];
  list.push(now);
  while (list.length && list[0] < now - 60000) list.shift();
  if (isOn('floodAlarm') && list.length >= settings().security.floodPerMin && settings().notify.events.flood !== false) {
    sendNotify({ title: '🌊 Ungewöhnlich viele Wünsche', message: `${list.length} Wünsche in der letzten Minute – evtl. Missbrauch. Moderation → Gerät sperren.`, priority: 4, tags: ['ocean'], key: `flood:${env}`, env }).catch(() => {});
  }
  return list.length;
}
