import { getDb } from './db.js';

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);

export function addMessage(env, accountId, name, text) {
  name = clean(name, 24); text = clean(text, 400);
  if (!name) throw new Error('Bitte gib deinen Namen an.');
  if (!text) throw new Error('Nachricht ist leer.');
  const now = Date.now();
  const info = getDb().prepare('INSERT INTO chat(env, ts, account_id, name, text) VALUES(?,?,?,?,?)').run(env, now, accountId ?? null, name, text);
  return { id: Number(info.lastInsertRowid), ts: now, name, text };
}

export const recentMessages = (env, limit = 60) =>
  getDb().prepare('SELECT id, ts, name, text FROM chat WHERE env = ? ORDER BY id DESC LIMIT ?').all(env, limit).reverse();
