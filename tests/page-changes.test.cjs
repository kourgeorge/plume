require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { getDb } = require('../src/db');
const { crawlSite, extractPage } = require('../src/research/crawl');
const { pageChanges, openPageChanges, unsentSerious, markPageChangeSent } = require('../src/research/pageChanges');
const { todayFeed, pageChangeSeen } = require('../src/today');
const { updatesNear, updatesBetween, GOOGLE_UPDATES } = require('../src/seo/googleUpdates');
const { pageChangeMessage } = require('../src/phone/telegram');

const saved = (o) => ({
  url: 'https://acme.test/a', status: 200, title: 'Widgets for teams', meta_description: 'We make widgets.', canonical: 'https://acme.test/a',
  h1: 'Widgets', headings: '[]', images_missing_alt: 0, has_schema: 1, word_count: 600, schema_types: '["Organization"]',
  meta_robots: '', og: '{"image":"https://acme.test/og.jpg"}', ...o,
});
const now = (o) => ({
  url: 'https://acme.test/a', status: 200, title: 'Widgets for teams', metaDescription: 'We make widgets.', canonical: 'https://acme.test/a/',
  h1: 'Widgets', wordCount: 600, schemaTypes: ['Organization'], metaRobots: '', og: { image: 'https://acme.test/og.jpg' }, ...o,
});

test('an unchanged page (same canonical written with a slash) reports nothing; a first read reports nothing', () => {
  assert.deepEqual(pageChanges(saved(), now()), []);
  assert.deepEqual(pageChanges(undefined, now({ metaRobots: 'noindex' })), []);
});

test('serious changes are found and marked critical', () => {
  const checks = (o) => pageChanges(saved(), now(o)).map((c) => `${c.check}:${c.severity}`);
  assert.deepEqual(checks({ metaRobots: 'noindex, follow' }), ['noindex-added:critical']);
  assert.deepEqual(checks({ canonical: 'https://acme.test/other' }), ['canonical-changed:critical']);
  assert.deepEqual(checks({ canonical: '' }), ['canonical-removed:critical']);
  assert.deepEqual(checks({ schemaTypes: [] }), ['schema-removed:critical']);
  assert.deepEqual(checks({ title: '' }), ['title-removed:critical']);
  assert.deepEqual(checks({ status: 404 }), ['page-broken:critical']);
  assert.deepEqual(checks({ wordCount: 100 }), ['content-shrank:high']);
  assert.deepEqual(checks({ og: { image: '' } }), ['og-image-removed:high']);
  assert.deepEqual(checks({ metaDescription: 'Something new.' }), ['description-changed:low']);
});

test('columns an older crawl never recorded are not reported as changes', () => {
  assert.deepEqual(pageChanges(saved({ meta_robots: null, og: null }), now({ metaRobots: 'noindex', og: { image: '' } })), []);
});

test('extractPage reads robots, social tags, links, image sizes, a lazy main image and language links', () => {
  const html = `<html><head><title>T</title><meta name="robots" content="noindex"><meta property="og:image" content="/og.jpg">
    <link rel="alternate" hreflang="he" href="/he/"><link rel="alternate" hreflang="en" href="/"></head>
    <body><header><img src="logo.png" width="10" height="10"></header><img src="hero.jpg" loading="lazy"><img src="b.jpg">
    <a href="/pricing">p</a><a href="/pricing#x">p</a><a href="https://other.test/">o</a></body></html>`;
  const { page } = extractPage('https://acme.test/', 200, html);
  assert.equal(page.metaRobots, 'noindex');
  assert.equal(page.og.image, '/og.jpg');
  assert.deepEqual(page.linksOut, ['https://acme.test/pricing']);
  assert.equal(page.imagesNoSize, 2);
  assert.equal(page.heroLazy, true, 'the header logo is not the main image');
  assert.deepEqual(page.hreflang.map((h) => h.href), ['https://acme.test/he/', 'https://acme.test/']);
});

test('a second crawl that finds a noindex page saves one card, shows it first on the Dashboard, and sends it once', async () => {
  let home = '<html><head><title>Acme</title><meta name="robots" content="index"></head><body><h1>Acme</h1><a href="/b">b</a></body></html>';
  const site = () => ({ 'https://acme.test/': home, 'https://acme.test/b': '<html><head><title>B</title></head><body><h1>B</h1></body></html>' });
  const fakeFetch = async (url) => {
    const body = site()[String(url)];
    return new Response(body ?? 'nope', { status: body ? 200 : 404, headers: { 'content-type': 'text/html' } });
  };
  await crawlSite('https://acme.test/', { fetchFn: fakeFetch, browserFn: null });
  assert.equal(openPageChanges().length, 0, 'the first read is the baseline');
  home = home.replace('content="index"', 'content="noindex"');
  await crawlSite('https://acme.test/', { fetchFn: fakeFetch, browserFn: null });
  const cards = openPageChanges();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].worst, 'critical');
  assert.equal(todayFeed()[0].kind, 'page-change');
  assert.match(pageChangeMessage(cards[0]), /hidden from Google/);
  assert.equal(unsentSerious().length, 1);
  markPageChangeSent(cards[0].id);
  assert.equal(unsentSerious().length, 0, 'a change goes to the phone once');
  pageChangeSeen(cards[0].id);
  assert.equal(openPageChanges().length, 0);
});

test('Google updates: in date order, each from a Google address, and found near a ranking move', () => {
  for (const u of GOOGLE_UPDATES) assert.match(u.source, /^https:\/\/(developers\.google\.com|status\.search\.google\.com|blog\.google)\//, u.name);
  assert.deepEqual([...GOOGLE_UPDATES].sort((a, b) => a.date.localeCompare(b.date)), GOOGLE_UPDATES);
  // Week of 2026-05-25: the May 2026 core update (05-21) was still rolling out.
  assert.deepEqual(updatesNear('2026-05-25').map((u) => u.name), ['May 2026 Core Update']);
  assert.deepEqual(updatesNear('2026-01-12'), []);
  assert.equal(updatesBetween('2026-03-01', '2026-03-31').length, 2);
});
