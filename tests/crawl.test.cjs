require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { getDb } = require('../src/db');
const { crawlSite, normaliseUrl, parseRobots } = require('../src/research/crawl');

const FIX = path.join(__dirname, 'fixtures/site');
const site = {
  'https://acme.test/robots.txt': 'User-agent: *\nDisallow: /private\n',
  'https://acme.test/': fs.readFileSync(path.join(FIX, 'index.html'), 'utf8'),
  'https://acme.test/pricing': fs.readFileSync(path.join(FIX, 'pricing.html'), 'utf8'),
};
const fetched = [];
const fakeFetch = async (url) => {
  fetched.push(String(url));
  const body = site[String(url)];
  const type = String(url).endsWith('.txt') ? 'text/plain' : 'text/html';
  return new Response(body ?? 'not found', { status: body ? 200 : 404, headers: { 'content-type': type } });
};

test('normaliseUrl keeps same-origin pages only', () => {
  const o = 'https://acme.test';
  assert.equal(normaliseUrl('/a/?x=1#top', o + '/', o), 'https://acme.test/a');
  assert.equal(normaliseUrl('https://other.com/', o, o), null);
  assert.equal(normaliseUrl('/logo.png', o, o), null);
});

test('parseRobots reads Disallow under the wildcard agent only', () => {
  assert.deepEqual(parseRobots('User-agent: Googlebot\nDisallow: /g\nUser-agent: *\nDisallow: /p # note\n'), ['/p']);
});

test('crawlSite follows links, honours robots, saves SEO facts', async () => {
  const pages = await crawlSite('https://acme.test/', { fetchFn: fakeFetch, browserFn: null });
  assert.deepEqual(pages.map((p) => p.url).sort(), ['https://acme.test/', 'https://acme.test/pricing']);
  assert.ok(!fetched.some((u) => u.includes('/private')), 'robots.txt disallow was ignored');
  const home = pages.find((p) => p.url === 'https://acme.test/');
  assert.equal(home.title, 'Acme Widgets');
  assert.equal(home.imagesMissingAlt, 1);
  assert.equal(home.hasSchema, true);
  assert.ok(!home.text.includes('menu'), 'nav text should be stripped');
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM pages').get().n, 2);
});

test('pages that are gone from the site are dropped, pages only skipped by the limit are kept', async () => {
  const db = getDb();
  db.prepare(`INSERT INTO pages (url, status, title) VALUES ('https://acme.test/old-page', 200, 'Gone')`).run();
  await crawlSite('https://acme.test/', { fetchFn: fakeFetch, browserFn: null });
  assert.ok(!db.prepare(`SELECT 1 FROM pages WHERE url = 'https://acme.test/old-page'`).get(), 'a page the site no longer has should be removed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM pages').get().n, 2);
  // With a limit of 1, /pricing is found but not opened: its saved copy must stay.
  await crawlSite('https://acme.test/', { fetchFn: fakeFetch, browserFn: null, maxPages: 1 });
  assert.ok(db.prepare(`SELECT 1 FROM pages WHERE url = 'https://acme.test/pricing'`).get(), 'a page skipped by the limit should keep its copy');
});

test('maxPages caps the crawl', async () => {
  const pages = await crawlSite('https://acme.test/', { fetchFn: fakeFetch, browserFn: null, maxPages: 1 });
  assert.equal(pages.length, 1);
});

test('withWorkingHost switches to www only when the bare address never connects', async () => {
  const { withWorkingHost } = require('../src/research/crawl');
  const html = '<html><body>' + 'word '.repeat(80) + '</body></html>';
  const timeout = () => Object.assign(new Error('x'), { name: 'TimeoutError' });
  const wwwOnly = async (url) => {
    if (String(url).startsWith('https://bare.test')) throw timeout();
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  assert.equal(await withWorkingHost('https://bare.test/', wwwOnly), 'https://www.bare.test/');
  // Bare address works: keep it.
  assert.equal(await withWorkingHost('https://acme.test/', fakeFetch), 'https://acme.test/');
  // Both dead: keep what the user typed.
  const dead = async () => { throw timeout(); };
  assert.equal(await withWorkingHost('https://bare.test/', dead), 'https://bare.test/');
});
