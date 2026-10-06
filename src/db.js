import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let db;

export function openDb(dataDir) {
  if (dataDir !== ':memory:') fs.mkdirSync(dataDir, { recursive: true });
  db = new DatabaseSync(dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'party.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      label TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env TEXT NOT NULL,
      track_id TEXT NOT NULL,
      uri TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      explicit INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reason TEXT,
      decided_by INTEGER,
      decided_at INTEGER,
      player INTEGER,
      queue_pos REAL,
      votes INTEGER NOT NULL DEFAULT 1,
      prioritized_by INTEGER,
      prioritized_at INTEGER,
      played_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_requests_env_status ON requests(env, status);
    CREATE TABLE IF NOT EXISTS votes (
      request_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (request_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS guest_actions (
      env TEXT NOT NULL,
      device_id TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_guest_actions ON guest_actions(env, device_id, ts);
    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env TEXT NOT NULL,
      ts INTEGER NOT NULL,
      player INTEGER NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      request_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT
    );
  `);
  return db;
}

export function getDb() { return db; }

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function logEvent(env, type, data = {}) {
  db.prepare('INSERT INTO events(env, ts, type, data) VALUES(?,?,?,?)').run(env, Date.now(), type, JSON.stringify(data));
}

export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
