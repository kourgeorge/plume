require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-schema-'));
process.env.PLUME_SITE = 'test.example';
const { getDb, getGlobalDb, migrate } = require('../src/db');
const { SITE_MIGRATIONS, GLOBAL_MIGRATIONS } = require('../src/db/schema');

const tables = (d) => d.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name);
const columns = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('versions go up by one, starting at 1', () => {
  for (const steps of [SITE_MIGRATIONS, GLOBAL_MIGRATIONS]) assert.deepEqual(steps.map((s) => s.version), steps.map((_, i) => i + 1));
});

test('a new site database gets every table, including the ones features used to make for themselves', () => {
  const d = getDb();
  assert.equal(d.pragma('user_version', { simple: true }), SITE_MIGRATIONS.at(-1).version);
  for (const t of ['drafts', 'feedback', 'ai_answers', 'keyword_metrics', 'outreach_contacts', 'link_evidence', 'code_fixes', 'page_sources', 'telegram_sent', 'telegram_why']) {
    assert.ok(tables(d).includes(t), `missing ${t}`);
  }
  assert.ok(columns(d, 'code_fixes').includes('pr_number'));
  assert.ok(columns(d, 'competitors').includes('socials'));
  assert.equal(getGlobalDb().pragma('user_version', { simple: true }), GLOBAL_MIGRATIONS.at(-1).version);
});

test('only newer steps run, each one all or nothing', () => {
  const d = new Database(':memory:');
  const steps = [
    { version: 1, sql: 'CREATE TABLE a (x)' },
    { version: 2, sql: 'CREATE TABLE b (x)' },
  ];
  migrate(d, steps);
  assert.equal(d.pragma('user_version', { simple: true }), 2);
  migrate(d, steps); // nothing to do: would fail on "table a already exists" if it ran again
  // A broken step leaves no half-done change behind and keeps the old version.
  assert.throws(() => migrate(d, [...steps, { version: 3, sql: 'CREATE TABLE c (x); CREATE TABLE a (x)' }]), /already exists/);
  assert.equal(d.pragma('user_version', { simple: true }), 2);
  assert.ok(!tables(d).includes('c'));
});
