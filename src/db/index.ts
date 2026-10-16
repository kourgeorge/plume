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
-- One row per day, so any window (7, 28, 30 days) can be summed. Replaces the old 28-day snapshot tables.
DROP TABLE IF EXISTS gsc_rows;
DROP TABLE IF EXISTS ga_pages;
CREATE TABLE IF NOT EXISTS gsc_daily (
  date TEXT NOT NULL,             -- YYYY-MM-DD
  query TEXT NOT NULL,
  page TEXT NOT NULL,
  clicks INTEGER, impressions INTEGER, position REAL,
  PRIMARY KEY (date, query, page)
);
CREATE TABLE IF NOT EXISTS ga_daily (
  date TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER, sessions INTEGER, engagement_rate REAL, avg_seconds REAL,
  PRIMARY KEY (date, path)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,            -- info | warn | error
  source TEXT NOT NULL,           -- task id, agent id, "server", ...
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,           -- running | done | failed | skipped
  message TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT                     -- the user's words, may be empty
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
