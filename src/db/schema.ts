/**
 * Every table Plume keeps, in one place.
 *
 * Each database records which version of its tables it has (SQLite's `user_version`). On opening, the
 * changes newer than that run in order, each one all or nothing, and the version moves up. To change a
 * table, add a new numbered step at the end — never edit a step that has already shipped.
 */

/** One step: the version it brings a database to, and the SQL that does it. */
export interface Migration {
  version: number;
  sql: string;
}

/** A site's own database: data/sites/<site>/site.db. */
export const SITE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
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
  page_date TEXT,         -- newest date the page states about itself (published/updated); null = none
  meta_robots TEXT,       -- robots meta tag(s); null = not recorded (older crawl)
  og TEXT,                -- JSON {title, description, image}
  links_out TEXT,         -- JSON array of same-site pages it links to
  images_no_size INTEGER,
  hero_lazy INTEGER,
  hreflang TEXT           -- JSON array of {lang, href}
);
-- What changed on the site's own pages between two reads: one row per read that found something.
CREATE TABLE IF NOT EXISTS page_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  changes TEXT NOT NULL,  -- JSON array of {url, check, severity, text, before, after}
  dismissed INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0 -- serious ones go to Telegram once
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
  users INTEGER, sessions INTEGER, revenue REAL,
  key_events INTEGER, engaged_sessions INTEGER, avg_seconds REAL, new_users INTEGER
);
CREATE TABLE IF NOT EXISTS ga_sources (
  date TEXT NOT NULL,
  channel TEXT NOT NULL,          -- GA4 default channel group: Organic Search, Direct, ...
  users INTEGER, sessions INTEGER,
  PRIMARY KEY (date, channel)
);
-- Where visits came from in detail: the channel plus the site that sent them (google, chatgpt.com, ...).
CREATE TABLE IF NOT EXISTS ga_source_detail (
  date TEXT NOT NULL,
  channel TEXT NOT NULL,
  source TEXT NOT NULL,
  users INTEGER, sessions INTEGER,
  PRIMARY KEY (date, channel, source)
);
-- The first page of each visit.
CREATE TABLE IF NOT EXISTS ga_landing (
  date TEXT NOT NULL,
  page TEXT NOT NULL,
  users INTEGER, sessions INTEGER,
  PRIMARY KEY (date, page)
);
-- Whole-site search numbers per day. Adding up gsc_daily falls short: Google leaves rare searches out of the by-search report.
CREATE TABLE IF NOT EXISTS gsc_site_daily (
  date TEXT PRIMARY KEY,
  clicks INTEGER, impressions INTEGER, position REAL
);
-- Google search clicks by the searcher's country (three-letter codes, e.g. isr).
CREATE TABLE IF NOT EXISTS gsc_country (
  date TEXT NOT NULL,
  country TEXT NOT NULL,
  clicks INTEGER, impressions INTEGER,
  PRIMARY KEY (date, country)
);
-- Google search clicks by the searcher's device: MOBILE, DESKTOP or TABLET.
CREATE TABLE IF NOT EXISTS gsc_device (
  date TEXT NOT NULL,
  device TEXT NOT NULL,
  clicks INTEGER, impressions INTEGER, position REAL,
  PRIMARY KEY (date, device)
);
-- Visitors by device and system (mobile + Android, desktop + Windows, ...). Search Console can't tell Android from iPhone.
CREATE TABLE IF NOT EXISTS ga_device (
  date TEXT NOT NULL,
  device TEXT NOT NULL,
  os TEXT NOT NULL,
  users INTEGER, sessions INTEGER,
  PRIMARY KEY (date, device, os)
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
  reason TEXT,                    -- the user's words, may be empty
  verdict TEXT NOT NULL DEFAULT 'rejected', -- rejected | approved
  draft_id INTEGER,
  kind TEXT,
  keyword TEXT,
  why TEXT,                       -- the agent's own reason for writing it
  edits TEXT                      -- approved only: a few lines the user changed, or null
);
CREATE TABLE IF NOT EXISTS competitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT,                       -- origin, e.g. https://rival.com; null if they have no site
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,           -- research | user
  watch INTEGER NOT NULL DEFAULT 0,
  socials TEXT NOT NULL DEFAULT '{}', -- JSON {x, linkedin, ...}
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

-- AI assistants: which questions are asked, each run, and what each assistant answered.
CREATE TABLE IF NOT EXISTS ai_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,            -- user | suggested
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  engines TEXT NOT NULL,           -- JSON {engine: model}
  status TEXT NOT NULL,            -- running | done | failed
  error TEXT,
  cost REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ai_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  question TEXT NOT NULL,          -- copied, so history survives deleting the question
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  answer TEXT,
  error TEXT,
  mentioned INTEGER,
  position INTEGER,                -- 1 = named first among the businesses it recommends
  sentiment TEXT,                  -- positive | neutral | negative
  competitors TEXT NOT NULL DEFAULT '[]',
  others TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS ai_answers_by_run ON ai_answers (run_id, question_id);

-- Search volume and difficulty (DataForSEO), and the searches competitors rank for.
CREATE TABLE IF NOT EXISTS keyword_metrics (
  keyword TEXT NOT NULL,
  location TEXT NOT NULL,
  volume INTEGER,                  -- monthly searches; null = DataForSEO has no figure for it
  difficulty INTEGER,              -- 0-100
  intent TEXT,                     -- informational | navigational | commercial | transactional
  cpc REAL,                        -- what advertisers pay per click, USD
  at TEXT NOT NULL,
  PRIMARY KEY (keyword, location)
);
CREATE TABLE IF NOT EXISTS competitor_keywords (
  competitor_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  position INTEGER NOT NULL,
  url TEXT,
  volume INTEGER,
  difficulty INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (competitor_id, keyword)
);

-- Creators and sites to contact, and what was found about each link prospect.
CREATE TABLE IF NOT EXISTS outreach_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,              -- creator | link
  name TEXT NOT NULL,
  url TEXT NOT NULL,               -- creator profile, or the page that could link to us
  platform TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',  -- as stated on the page ("12k subscribers"); never estimated
  email TEXT NOT NULL DEFAULT '',
  email_source TEXT NOT NULL DEFAULT '', -- the page the address was read from
  email_verified INTEGER NOT NULL DEFAULT 0, -- 1 = Plume saw the address on that page, or the owner typed it
  why TEXT NOT NULL DEFAULT '',
  opportunity TEXT NOT NULL DEFAULT '', -- link prospects: unlinked-mention | lists-competitors
  status TEXT NOT NULL DEFAULT 'found',
  rate TEXT NOT NULL DEFAULT '',
  deliverable_url TEXT NOT NULL DEFAULT '',
  paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  last_emailed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, url)
);
CREATE TABLE IF NOT EXISTS link_evidence (
  contact_id INTEGER PRIMARY KEY,
  evidence TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  verification TEXT,
  verified_url TEXT,
  verification_at TEXT,
  verification_note TEXT
);
CREATE TABLE IF NOT EXISTS link_discovery_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS outreach_by_status ON outreach_contacts (kind, status);

-- Pull requests that fix a problem on the site.
CREATE TABLE IF NOT EXISTS code_fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,            -- proposed | cancelled | opened | merged | verified | closed | failed | not-fixable
  pr_url TEXT,
  files TEXT NOT NULL DEFAULT '[]',
  message TEXT,
  pr_number INTEGER,
  proposal TEXT,
  checked_at TEXT
);
CREATE INDEX IF NOT EXISTS code_fixes_by_issue ON code_fixes (issue_id, id);
-- Which repository file a page comes from, found once by matching the live page's text, reused after.
CREATE TABLE IF NOT EXISTS page_sources (
  url TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  how TEXT NOT NULL,
  at TEXT NOT NULL
);

-- Telegram: which message carries which draft, and the "what was wrong?" questions.
CREATE TABLE IF NOT EXISTS telegram_sent (
  draft_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS telegram_sent_by_draft ON telegram_sent (draft_id);
-- "Why wasn't it useful?" questions: a reply to one is the reason for that draft.
CREATE TABLE IF NOT EXISTS telegram_why (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  draft_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
`,
  },
  {
    // Problems kept between scans, like drafts: a scan updates them, it never wipes them.
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,            -- check + address, e.g. "missing-title:https://a.com/about"
  agent TEXT NOT NULL,            -- who found it: site-check | compliance | red
  check_id TEXT NOT NULL,
  url TEXT NOT NULL,              -- the page (or "repo:..." for a file in the repository)
  severity TEXT NOT NULL,
  area TEXT NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  steps TEXT NOT NULL,            -- JSON list
  snippet TEXT,
  state TEXT NOT NULL,            -- open | fixed | gone | wont-fix
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,        -- the last scan that found it
  closed_at TEXT                  -- when it was fixed, stopped being found, or turned down
);
CREATE INDEX IF NOT EXISTS issues_by_agent ON issues (agent, state);
-- What happened to each problem, in order: found, fixed, found again, no longer found, won't fix, reopened.
CREATE TABLE IF NOT EXISTS issue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  at TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS issue_events_by_issue ON issue_events (issue_id, id);
`,
  },
];

/** The shared database: data/plume.db. Site list, AI usage (one budget for all sites), logs, app-wide settings. */
export const GLOBAL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
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
`,
  },
];
