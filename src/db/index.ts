import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';
import { currentSite, siteDir } from '../site';

const SITE_SCHEMA = `
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
  crawled_at TEXT,
  schema_types TEXT NOT NULL DEFAULT '[]', -- JSON array of structured-data @types found on the page
  page_date TEXT          -- newest date the page states about itself (published/updated); null = none
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
-- One row per day, so any window (7, 28, 30 days) can be summed.
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
-- Whole-site numbers per day. Visitors can't be added up from pages (one visitor sees many), so they come separately.
CREATE TABLE IF NOT EXISTS ga_site_daily (
  date TEXT PRIMARY KEY,
  users INTEGER, sessions INTEGER, revenue REAL
);
CREATE TABLE IF NOT EXISTS ga_sources (
  date TEXT NOT NULL,
  channel TEXT NOT NULL,          -- GA4 default channel group: Organic Search, Direct, ...
  users INTEGER, sessions INTEGER,
  PRIMARY KEY (date, channel)
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
CREATE TABLE IF NOT EXISTS competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT,                       -- origin, e.g. https://rival.com; null if they have no site
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,           -- research | user
  watch INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS competitor_snapshots (
  competitor_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL              -- JSON: pages, headline, description, prices
);
CREATE TABLE IF NOT EXISTS competitor_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  changes TEXT NOT NULL,          -- JSON list of {kind, text}
  dismissed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS competitor_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competitor_id INTEGER NOT NULL,
  at TEXT NOT NULL,
  scope TEXT NOT NULL,            -- site (free website check) | news-social (AI + web search)
  outcome TEXT NOT NULL,          -- baseline | changed | unchanged | failed
  findings TEXT NOT NULL          -- JSON list of {area, kind, text, url, items?}
);
CREATE TABLE IF NOT EXISTS competitor_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT,
  reason TEXT NOT NULL,
  source_url TEXT,
  at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'   -- open | added | dismissed
);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  x_handle TEXT NOT NULL DEFAULT '',
  linkedin_url TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  system TEXT NOT NULL,           -- JSON system blocks, frozen when the chat starts so history stays append-only
  running INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  notes TEXT NOT NULL DEFAULT '[]', -- JSON: facts to tell the model with the next message ("the owner applied …")
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  role TEXT NOT NULL,             -- user | assistant, as sent to the model
  kind TEXT NOT NULL,             -- text (the owner typed it) | assistant | tool (tool results)
  content TEXT NOT NULL,          -- JSON content blocks, exactly as sent or received
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  kind TEXT NOT NULL,             -- doc-change | draft | job | competitor
  data TEXT NOT NULL,             -- JSON
  status TEXT NOT NULL,           -- pending | applied | discarded | done | undone
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracked_keywords (
  keyword TEXT PRIMARY KEY,       -- lowercased search term
  source TEXT NOT NULL,           -- user | suggested
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS serp_snapshots (
  keyword TEXT NOT NULL,
  at TEXT NOT NULL,
  location TEXT NOT NULL,         -- e.g. "Israel"; results differ by country
  results TEXT NOT NULL,          -- JSON list of {position, url, domain, title}
  our_position INTEGER,           -- null = not in the top results
  cost REAL NOT NULL DEFAULT 0,   -- what the lookup cost, in USD, as the provider reported it
  PRIMARY KEY (keyword, at)
);
CREATE TABLE IF NOT EXISTS rank_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  week TEXT NOT NULL,             -- the week (Monday) the move was measured
  from_position REAL NOT NULL,
  to_position REAL NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  UNIQUE (keyword, week)
);
-- What was done to the site, dated, so its effect can be measured afterwards.
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,             -- fix-done | published | doc-edited | code-pr
  ref TEXT NOT NULL,              -- issue id / draft id / document id
  url TEXT,                       -- the page it affects; null = the whole site
  title TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' -- JSON: severity, target, PR link, ...
);
-- One row per day with a site check, so the score and the problems can be followed over time.
CREATE TABLE IF NOT EXISTS audit_history (
  day TEXT PRIMARY KEY,           -- YYYY-MM-DD; a second check the same day replaces the first
  at TEXT NOT NULL,
  score INTEGER NOT NULL,
  critical INTEGER NOT NULL,
  warnings INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  issue_ids TEXT NOT NULL         -- JSON list of the problems found
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL     -- JSON
);
-- Lookups the app makes on every page load or task run.
CREATE INDEX IF NOT EXISTS actions_by_kind ON actions (kind, ref);
CREATE INDEX IF NOT EXISTS chat_messages_by_thread ON chat_messages (thread_id, id);
CREATE INDEX IF NOT EXISTS chat_actions_by_thread ON chat_actions (thread_id);
CREATE INDEX IF NOT EXISTS drafts_by_status ON drafts (status, agent);
CREATE INDEX IF NOT EXISTS draft_events_by_draft ON draft_events (draft_id);
CREATE INDEX IF NOT EXISTS jobs_by_kind ON jobs (kind, status);
CREATE INDEX IF NOT EXISTS task_runs_by_task ON task_runs (task, id);
CREATE INDEX IF NOT EXISTS feedback_by_agent ON feedback (agent, id);
CREATE INDEX IF NOT EXISTS snapshots_by_competitor ON competitor_snapshots (competitor_id, at);
CREATE INDEX IF NOT EXISTS scans_by_competitor ON competitor_scans (competitor_id, id);
CREATE INDEX IF NOT EXISTS changes_by_competitor ON competitor_changes (competitor_id, dismissed);
CREATE INDEX IF NOT EXISTS gsc_by_query ON gsc_daily (query, date);
`;

/** Shared by every site: the site list, AI usage (one budget for all sites), the event log, app-wide settings. */
const GLOBAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  slug TEXT PRIMARY KEY,          -- folder name under data/sites, e.g. "acme.com"
  url TEXT NOT NULL,              -- origin, e.g. https://acme.com
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_opened_at TEXT
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  site TEXT,                      -- which website the call was for; null = not site-specific
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
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  site TEXT,                      -- null = about Plume itself
  level TEXT NOT NULL,            -- info | warn | error
  source TEXT NOT NULL,           -- task id, agent id, "server", ...
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL     -- JSON
);
CREATE INDEX IF NOT EXISTS llm_calls_by_month ON llm_calls (at, site);
CREATE INDEX IF NOT EXISTS logs_by_site ON logs (site, id);
`;


let globalDb: Database.Database | null = null;
const siteDbs = new Map<string, Database.Database>();

/** Columns added after a table was first created. CREATE TABLE IF NOT EXISTS skips old databases, so these are added by hand. */
const ADDED_COLUMNS: { table: string; column: string; type: string }[] = [
  { table: 'pages', column: 'schema_types', type: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'pages', column: 'page_date', type: 'TEXT' },
  { table: 'competitors', column: 'socials', type: "TEXT NOT NULL DEFAULT '{}'" },
];

function open(file: string, schema: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.exec(schema);
  for (const c of ADDED_COLUMNS) {
    const cols = d.prepare(`PRAGMA table_info(${c.table})`).all() as { name: string }[];
    if (cols.length && !cols.some((x) => x.name === c.column)) d.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`);
  }
  return d;
}

/** The shared database (site list, AI usage, logs, app-wide settings). */
export function getGlobalDb(): Database.Database {
  if (globalDb) return globalDb;
  globalDb = open(path.join(DATA_DIR, 'plume.db'), GLOBAL_SCHEMA);
  return globalDb;
}

/** The database of the site this request or job is for (see `withSite`). */
export function getDb(slug = currentSite()): Database.Database {
  let d = siteDbs.get(slug);
  if (!d) {
    d = open(path.join(siteDir(slug), 'site.db'), SITE_SCHEMA);
    siteDbs.set(slug, d);
  }
  return d;
}

/** Close a site's database (before deleting its folder). */
export function closeSiteDb(slug: string): void {
  siteDbs.get(slug)?.close();
  siteDbs.delete(slug);
}

export function resetDbForTests(): void {
  for (const d of siteDbs.values()) d.close();
  siteDbs.clear();
  globalDb?.close();
  globalDb = null;
}

/** Settings for the current site. */
export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

/** Settings shared by all sites (e.g. the monthly AI budget). */
export function getGlobalSetting<T>(key: string, fallback: T): T {
  const row = getGlobalDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setGlobalSetting(key: string, value: unknown): void {
  getGlobalDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
