import Database from 'better-sqlite3';
import path from 'path';
import { DATA_DIR } from '../config';

let db: Database.Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  status INTEGER,
  title TEXT,
  meta_description TEXT,
  canonical TEXT,
  h1 TEXT,
  headings TEXT,          -- JSON array of {level, text}
  images_missing_alt INTEGER,
  has_schema INTEGER,
  word_count INTEGER,
  text TEXT,
  crawled_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,   -- running | done | failed
  progress TEXT,          -- latest human-readable step
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  web_searches INTEGER,
  cost_usd REAL,
  stop_reason TEXT
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,            -- seo | writer | ...
  kind TEXT NOT NULL,             -- blog_post | landing_page | article
  title TEXT NOT NULL,
  body TEXT NOT NULL,             -- Markdown, as currently edited
  original_body TEXT NOT NULL,    -- what the agent wrote, kept so edits can teach the voice doc
  meta TEXT NOT NULL,             -- JSON: slug, metaDescription, keyword, reason, sources, ...
  status TEXT NOT NULL,           -- draft | approved | published | failed | rejected
  target TEXT,                    -- wordpress | webflow | export
  scheduled_for TEXT,             -- ISO time; null = as soon as approved
  published_url TEXT,
  external_id TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS draft_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  note TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL     -- JSON
);
`;

/** One shared connection. `file` lets tests use ':memory:'. */
export function getDb(file = path.join(DATA_DIR, 'plume.db')): Database.Database {
  if (db) return db;
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function resetDbForTests(): void {
  db?.close();
  db = null;
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
