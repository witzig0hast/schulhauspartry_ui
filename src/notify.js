import { settings, notifyToken } from './settings.js';
import { logEvent } from './db.js';

// Push-Benachrichtigungen ueber ntfy (https://ntfy.sh oder eigener Server). Per JSON-Publish, damit Umlaute/Emojis unproblematisch sind.
const lastSent = new Map();

export async function sendNotify({ title, message, priority = 3, tags = [], key = null, force = false, env = 'live' }) {
  const n = settings().notify;
  if (!force && !n.enabled) return { sent: false, reason: 'ausgeschaltet' };
  if (!n.topic) return { sent: false, reason: 'Kein Topic eingetragen' };
  if (key && !force) { // gleiche Meldung nicht mehr als einmal pro Minute
    const last = lastSent.get(key) || 0;
    if (Date.now() - last < 60000) return { sent: false, reason: 'gerade erst gesendet' };
    lastSent.set(key, Date.now());
  }
  try {
    const token = notifyToken();
    const res = await fetch(n.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ topic: n.topic, title: `${env === 'test' ? '[TEST] ' : ''}${title}`, message, priority, tags }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`ntfy antwortete mit ${res.status}`);
    logEvent(env, 'notify', { title });
    return { sent: true };
  } catch (e) {
    logEvent(env, 'notify-error', { msg: e.message });
    return { sent: false, reason: e.message };
  }
}
