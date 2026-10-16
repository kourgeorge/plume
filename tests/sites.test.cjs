require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// Build an OLD single-site data folder first, then load Plume on it: the move must happen on first use.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-sites-'));
{
  const old = new Database(path.join(DIR, 'plume.db'));
  old.exec(`CREATE TABLE pages (url TEXT PRIMARY KEY, status INTEGER, title TEXT, meta_description TEXT, canonical TEXT, h1 TEXT, headings TEXT, images_missing_alt INTEGER, has_schema INTEGER, word_count INTEGER, text TEXT, crawled_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE llm_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, web_searches INTEGER, cost_usd REAL, stop_reason TEXT);
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL);`);
  old.prepare(`INSERT INTO settings VALUES ('siteUrl', ?), ('monthlyBudgetUsd', '25')`).run(JSON.stringify('https://www.oldsite.example'));
  old.prepare(`INSERT INTO pages (url, status, title) VALUES ('https://www.oldsite.example/', 200, 'Old home')`).run();
  old.prepare(`INSERT INTO llm_calls (at, purpose, model, cost_usd) VALUES ('2026-10-16T10:00:00Z', 'research:product', 'claude-opus-5-5', 0.42)`).run();
  old.prepare(`INSERT INTO logs (at, level, source, message) VALUES ('2026-10-16T10:00:00Z', 'info', 'server', 'old line')`).run();
  old.close();
  fs.mkdirSync(path.join(DIR, 'profile'));
  fs.writeFileSync(path.join(DIR, 'profile', 'product.md'), '# Old product\n');
}
process.env.DATA_DIR = DIR;
delete process.env.PLUME_SITE;

const db = require('../src/db');
const { withSite, currentSite, siteDir } = require('../src/site');
const sites = require('../src/sites');
const { readDoc, writeDoc } = require('../src/context/profile');
const { getSetting, setSetting } = db;

test('the old single-site layout moves into its own site folder, keeping usage, logs and the budget', () => {
  const list = sites.listSites();
  assert.deepEqual(list.map((s) => s.slug), ['oldsite.example']);
  assert.ok(fs.existsSync(path.join(DIR, 'sites', 'oldsite.example', 'site.db')));
  assert.ok(!fs.existsSync(path.join(DIR, 'profile')), 'old profile folder should have moved');
  withSite('oldsite.example', () => {
    assert.equal(readDoc('product'), '# Old product\n');
    assert.equal(sites.siteUrl(), 'https://www.oldsite.example');
    assert.equal(getSetting('siteUrl', null), null, 'the copy in site settings should be gone');
    assert.equal(db.getDb().prepare('SELECT title FROM pages').get().title, 'Old home');
  });
  const g = db.getGlobalDb();
  assert.deepEqual(g.prepare('SELECT site, cost_usd FROM llm_calls').get(), { site: 'oldsite.example', cost_usd: 0.42 });
  assert.equal(g.prepare(`SELECT site FROM logs WHERE message = 'old line'`).get().site, 'oldsite.example');
  assert.equal(db.getGlobalSetting('monthlyBudgetUsd', 0), 25);
});

test('adding sites: one folder each, same site twice is the same site, bad addresses refused', () => {
  const a = sites.addSite('https://www.alpha.example/about');
  assert.equal(a.created, true);
  assert.equal(a.site.slug, 'alpha.example');
  assert.equal(a.site.url, 'https://www.alpha.example');
  assert.equal(sites.addSite('alpha.example').created, false);
  sites.addSite('beta.example');
  assert.throws(() => sites.addSite('not a site'), /not a website address/);
  withSite('alpha.example', () => assert.equal(sites.siteUrl(), 'https://www.alpha.example'));
});

test("two sites never see each other's data, even when their work interleaves", async () => {
  const work = (slug, n) =>
    withSite(slug, async () => {
      for (let i = 0; i < n; i++) {
        setSetting('counter', (getSetting('counter', 0)) + 1);
        writeDoc('voice', `# Voice of ${slug}\n`);
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        assert.equal(currentSite(), slug, 'site context leaked across awaits');
      }
    });
  await Promise.all([work('alpha.example', 20), work('beta.example', 7)]);
  withSite('alpha.example', () => {
    assert.equal(getSetting('counter', 0), 20);
    assert.equal(readDoc('voice'), '# Voice of alpha.example\n');
  });
  withSite('beta.example', () => assert.equal(getSetting('counter', 0), 7));
  assert.throws(() => currentSite(), /no website selected/);
});

test('removing a site deletes its folder but keeps AI usage for the budget', () => {
  withSite('beta.example', () => db.getGlobalDb().prepare(`INSERT INTO llm_calls (at, site, purpose, model, cost_usd) VALUES (?, 'beta.example', 'x', 'm', 1)`).run(new Date().toISOString()));
  sites.removeSite('beta.example');
  assert.ok(!fs.existsSync(siteDir('beta.example')));
  assert.ok(!sites.getSite('beta.example'));
  assert.equal(db.getGlobalDb().prepare(`SELECT COUNT(*) n FROM llm_calls WHERE site = 'beta.example'`).get().n, 1);
  assert.throws(() => siteDir('../etc'), /bad site name/);
});

test('server: requests must name a known site; the site list and budget work without one', async () => {
  const { buildServer } = require('../src/server');
  const app = buildServer(4499);
  const call = (url, headers = {}) => app.inject({ url, headers: { host: '127.0.0.1:4499', ...headers } });
  assert.equal((await call('/api/today')).statusCode, 400);
  assert.match((await call('/api/today')).json().error, /pick a website/);
  assert.equal((await call('/api/today', { 'x-plume-site': 'nope.example' })).statusCode, 404);
  assert.equal((await call('/api/today', { 'x-plume-site': '../../etc' })).statusCode, 404);
  assert.equal((await call('/api/sites')).statusCode, 200);
  assert.equal((await call('/api/budget')).statusCode, 200);
  const state = (await call('/api/state', { 'x-plume-site': 'alpha.example' })).json();
  assert.equal(state.slug, 'alpha.example');
  assert.equal(state.site, 'https://www.alpha.example');
  assert.equal((await call('/api/llms-txt?site=alpha.example')).statusCode, 404, 'query form works (404 = nothing read yet)');
  const page = await call('/s/alpha.example/');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<title>Plume<\/title>/);
  assert.equal((await call('/s/gone.example/')).statusCode, 302);
  assert.match((await call('/')).body, /Your websites/);
  await app.close();
});
