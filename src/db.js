import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

let db;
export let dataDirPath = null;

export function openDb(dataDir) {
  dataDirPath = dataDir === ':memory:' ? null : dataDir;
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
    CREATE TABLE IF NOT EXISTS blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,            -- 'track' | 'artist'
      key TEXT NOT NULL,             -- Track-ID bzw. normalisierter Interpretenname
      title TEXT,
      artist TEXT,
      reason TEXT,
      created_by INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(kind, key)
    );
    CREATE TABLE IF NOT EXISTS block_attempts (
      env TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,            -- 'blacklist' | 'played' | 'explicit'
      key TEXT
    );
    CREATE TABLE IF NOT EXISTS security_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      who TEXT,
      ip TEXT,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      account_id INTEGER,
      role TEXT NOT NULL,
      label TEXT NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used INTEGER
    );
    CREATE TABLE IF NOT EXISTS blocked_devices (
      env TEXT NOT NULL,
      device_id TEXT NOT NULL,
      reason TEXT,
      ts INTEGER NOT NULL,
      PRIMARY KEY (env, device_id)
    );
    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      option_idx INTEGER NOT NULL,
      PRIMARY KEY (poll_id, device_id)
    );
    CREATE TABLE IF NOT EXISTS schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env TEXT NOT NULL,
      at TEXT NOT NULL,
      title TEXT NOT NULL,
      note TEXT,
      public INTEGER NOT NULL DEFAULT 0,
      done INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sso_links (
      issuer TEXT NOT NULL,
      sub TEXT NOT NULL,
      kind TEXT NOT NULL,            -- 'account' (bestehender Code-Zugang) oder 'head' (Head-Admin)
      account_id INTEGER,
      email TEXT,
      name TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (issuer, sub)
    );
    CREATE TABLE IF NOT EXISTS vote_actions (
      env TEXT NOT NULL,
      device_id TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS track_gain (
      track_id TEXT PRIMARY KEY,
      gain REAL NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS brand_assets (
      name TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data BLOB NOT NULL,
      ver INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env TEXT NOT NULL,
      ts INTEGER NOT NULL,
      account_id INTEGER,
      name TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS track_meta (
      track_id TEXT PRIMARY KEY,
      intro_ms INTEGER,              -- Ende des Intros (ms), falls bekannt
      outro_ms INTEGER,              -- Beginn des Outros (ms), falls bekannt
      src TEXT,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      env TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      data TEXT
    );
  `);
  // Spaltenmigration fuer bestehende Datenbanken
  const addColumn = (table, col, def) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addColumn('requests', 'artist_ids', 'TEXT');
  addColumn('requests', 'genres', 'TEXT');
  addColumn('requests', 'year', 'INTEGER');
  addColumn('requests', 'popularity', 'INTEGER');
  addColumn('requests', 'tag', 'TEXT');
  addColumn('accounts', 'email', 'TEXT');
  addColumn('sessions', 'ip', 'TEXT');
  addColumn('sessions', 'ua', 'TEXT');
  addColumn('sessions', 'last_seen', 'INTEGER');
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
