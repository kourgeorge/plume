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

const pageHtml = (title, links = []) =>
  `<html lang="en"><head><title>${title}</title></head><body><h1>${title}</h1><p>${'word '.repeat(60)}</p>${links.map((l) => `<a href="${l}">x</a>`).join('')}</body></html>`;
const fakeSite = (pages, log = []) => async (url) => {
  url = String(url);
  log.push(url);
  let body = pages[url];
  let final = url;
  if (body && body.redirect) (final = body.redirect), (body = pages[final]);
  const type = url.endsWith('.txt') ? 'text/plain' : url.endsWith('.xml') ? 'application/xml' : 'text/html';
  const r = new Response(body ?? 'not found', { status: body ? 200 : 404, headers: { 'content-type': type } });
  Object.defineProperty(r, 'url', { value: final });
  return r;
};

test('pages linked from the site are read before pages only the sitemap lists', async () => {
  const urls = Array.from({ length: 50 }, (_, i) => `<url><loc>https://big.test/archive/${i}</loc></url>`).join('');
  const site = {
    'https://big.test/': pageHtml('Home', ['/pricing', '/about']),
    'https://big.test/pricing': pageHtml('Pricing'),
    'https://big.test/about': pageHtml('About'),
    'https://big.test/sitemap.xml': `<?xml version="1.0"?><urlset>${urls}</urlset>`,
  };
  for (let i = 0; i < 50; i++) site[`https://big.test/archive/${i}`] = pageHtml(`Old ${i}`);
  const pages = await crawlSite('https://big.test/', { fetchFn: fakeSite(site), browserFn: null, maxPages: 5 });
  const got = pages.map((p) => p.url);
  assert.equal(got.length, 5);
  assert.ok(got.includes('https://big.test/pricing') && got.includes('https://big.test/about'), 'menu pages should come before the sitemap archive');
  assert.equal(getDb().prepare('SELECT value FROM settings WHERE key = ?').get('crawlComplete').value, 'false');
});

test('sitemap index files and robots.txt sitemaps are followed', async () => {
  const { sitemapUrls, robotsSitemaps } = require('../src/research/crawl');
  const robots = 'User-agent: *\nDisallow:\nSitemap: https://idx.test/sitemaps/index.xml\nSitemap: https://elsewhere.test/s.xml\n';
  assert.deepEqual(robotsSitemaps(robots), ['https://idx.test/sitemaps/index.xml', 'https://elsewhere.test/s.xml']);
  const site = {
    'https://idx.test/sitemaps/index.xml': '<sitemapindex><sitemap><loc>https://idx.test/sitemaps/a.xml</loc></sitemap><sitemap><loc>https://idx.test/sitemaps/b.xml</loc></sitemap></sitemapindex>',
    'https://idx.test/sitemaps/a.xml': '<urlset><url><loc>https://idx.test/one</loc></url></urlset>',
    'https://idx.test/sitemaps/b.xml': '<urlset><url><loc>https://idx.test/two</loc></url></urlset>',
  };
  const log = [];
  const r = await sitemapUrls('https://idx.test', fakeSite(site, log), robots);
  assert.deepEqual(r.urls, ['https://idx.test/one', 'https://idx.test/two']);
  assert.equal(r.complete, true);
  assert.ok(!log.some((u) => u.includes('elsewhere.test')), 'another site\'s sitemap must not be read');
  // A sitemap robots.txt names but that is missing: the list may be short.
  const broken = await sitemapUrls('https://idx.test', fakeSite({}), robots);
  assert.equal(broken.complete, false);
  // No sitemap at all is fine.
  assert.equal((await sitemapUrls('https://idx.test', fakeSite({}))).complete, true);
});

test('a page that redirects is saved once, under the address it lands on, and links to the old address count', async () => {
  const site = {
    'https://moved.test/': pageHtml('Home', ['/old', '/new']),
    'https://moved.test/old': { redirect: 'https://moved.test/new' },
    'https://moved.test/new': pageHtml('New', ['/']),
  };
  getDb().prepare(`INSERT INTO pages (url, status, title) VALUES ('https://moved.test/old', 200, 'Old copy')`).run();
  const pages = await crawlSite('https://moved.test/', { fetchFn: fakeSite(site), browserFn: null });
  assert.deepEqual(pages.map((p) => p.url).sort(), ['https://moved.test/', 'https://moved.test/new']);
  const rows = getDb().prepare(`SELECT url FROM pages WHERE url LIKE 'https://moved.test/%'`).all().map((r) => r.url).sort();
  assert.deepEqual(rows, ['https://moved.test/', 'https://moved.test/new']);
  const home = getDb().prepare(`SELECT links_out FROM pages WHERE url = 'https://moved.test/'`).get();
  assert.deepEqual(JSON.parse(home.links_out), ['https://moved.test/new']);
});

test('a home page that redirects keeps its address; its real address is not read again', async () => {
  const site = {
    'https://www.ibmish.test/': { redirect: 'https://www.ibmish.test/us-en' },
    'https://www.ibmish.test/us-en': pageHtml('Home', ['/us-en', '/products']),
    'https://www.ibmish.test/products': pageHtml('Products', ['/us-en']),
  };
  const log = [];
  const pages = await crawlSite('https://www.ibmish.test/', { fetchFn: fakeSite(site, log), browserFn: null });
  assert.deepEqual(pages.map((p) => p.url).sort(), ['https://www.ibmish.test/', 'https://www.ibmish.test/products']);
  assert.equal(log.filter((u) => u.endsWith('/us-en')).length, 0, 'the home page was read twice');
});

test('several pages are read at the same time', async () => {
  const site = { 'https://fast.test/': pageHtml('Home', ['/a', '/b', '/c', '/d']) };
  for (const p of ['a', 'b', 'c', 'd']) site[`https://fast.test/${p}`] = pageHtml(p);
  let open = 0;
  let most = 0;
  const inner = fakeSite(site);
  const slow = async (u) => {
    open++, (most = Math.max(most, open));
    await new Promise((r) => setTimeout(r, 20));
    open--;
    return inner(u);
  };
  const pages = await crawlSite('https://fast.test/', { fetchFn: slow, browserFn: null });
  assert.equal(pages.length, 5);
  assert.ok(most > 1, 'pages were read one at a time');
});
