require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-tools-'));
process.env.PLUME_SITE = 'test.example';
const tools = require('../src/tools');
const { getDb, getGlobalDb } = require('../src/db');
getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://acme.example', 'Acme', 'now')`).run();

test('meta checker: finds what is missing and what is fine', () => {
  const bare = tools.checkMeta('<html><head><title>Hi</title></head><body></body></html>', 'https://acme.example/');
  assert.ok(bare.problems.some((p) => /only 2 characters/.test(p)));
  assert.ok(bare.problems.some((p) => /No meta description/.test(p)));
  assert.ok(bare.problems.some((p) => /og:title, og:description, og:image/.test(p)));
  assert.ok(bare.problems.some((p) => /what language/.test(p)));
  const good = tools.checkMeta(
    `<html lang="en"><head><title>Modular desk organisers for small desks</title>
     <meta name="description" content="Click-together desk organisers that fit small desks. Free returns and a two-year warranty on every kit.">
     <link rel="canonical" href="/"><meta property="og:title" content="t"><meta property="og:description" content="d"><meta property="og:image" content="i">
     <meta name="twitter:card" content="summary_large_image"></head></html>`,
    'https://acme.example/',
  );
  assert.deepEqual(good.problems, []);
  assert.equal(good.og.image, 'i');
  const off = tools.checkMeta('<html><head><link rel="canonical" href="https://other.example/x"><meta name="robots" content="noindex"></head></html>', 'https://acme.example/x', 404);
  assert.ok(off.problems.some((p) => /answered 404/.test(p)));
  assert.ok(off.problems.some((p) => /points to another site/.test(p)));
  assert.ok(off.problems.some((p) => /noindex/.test(p)));
});

test('meta checker reads a live page and says plainly when it cannot', async () => {
  const fetchFn = async (u) => (String(u).includes('ok') ? new Response(`<html><head><title>A good page title here</title></head><body><p>${'Real words on the page. '.repeat(40)}</p></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('x', { status: 500, headers: { 'content-type': 'text/html' } }));
  assert.equal((await tools.checkMetaUrl('ok.example', fetchFn)).title, 'A good page title here');
  await assert.rejects(tools.checkMetaUrl('bad.example', fetchFn), /Couldn't read https:\/\/bad\.example\//);
});

test('robots.txt: AI answer engines allowed by default, training crawlers your choice', () => {
  const r = tools.buildRobots({ aiSearch: true, aiTraining: false, disallow: ['admin', '/cart', '/cart'], sitemap: 'https://acme.example/sitemap.xml' });
  assert.match(r, /User-agent: \*\nDisallow: \/admin\nDisallow: \/cart\n/);
  assert.match(r, /User-agent: CCBot/);
  assert.doesNotMatch(r, /User-agent: GPTBot/);
  assert.match(r, /Sitemap: https:\/\/acme\.example\/sitemap\.xml\n$/);
  const open = tools.buildRobots({ aiSearch: true, aiTraining: true, disallow: [], sitemap: '' });
  assert.equal(open, '# Built with Plume\nUser-agent: *\nAllow: /\n');
  // Read back with the site check's own robots.txt reader: it must see exactly what was chosen.
  const { aiAccess } = require('../src/research/aiCrawlers');
  const seen = aiAccess(r);
  assert.ok(seen.filter((c) => c.kind === 'search').every((c) => c.allowed), 'answer engines can read the site');
  assert.ok(seen.filter((c) => c.kind === 'training').every((c) => !c.allowed), 'training crawlers are kept out');
  assert.ok(aiAccess(tools.buildRobots({ aiSearch: false, aiTraining: false, disallow: [], sitemap: '' })).every((c) => !c.allowed));
  assert.ok(aiAccess(open).every((c) => c.allowed));
});

test('sitemap lists only pages worth listing, escaped', () => {
  const ins = getDb().prepare('INSERT INTO pages (url, status, canonical, page_date, crawled_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('https://acme.example/', 200, 'https://acme.example/', null, 'now');
  ins.run('https://acme.example/kits?a=1&b=2', 200, null, '2026-09-01T10:00:00Z', 'now');
  ins.run('https://acme.example/old', 404, null, null, 'now');
  ins.run('https://acme.example/copy', 200, 'https://acme.example/', null, 'now');
  const pages = tools.sitemapPages();
  assert.deepEqual(pages.map((p) => p.url), ['https://acme.example/', 'https://acme.example/kits?a=1&b=2']);
  const xml = tools.buildSitemap(pages);
  assert.match(xml, /<loc>https:\/\/acme\.example\/kits\?a=1&amp;b=2<\/loc><lastmod>2026-09-01<\/lastmod>/);
});

test('UTM links: tidy values, required parts checked', () => {
  assert.equal(
    tools.buildUtm({ url: 'acme.example/kits?ref=x', source: 'Newsletter', medium: 'Email', campaign: 'Autumn Sale' }),
    'https://acme.example/kits?ref=x&utm_source=newsletter&utm_medium=email&utm_campaign=autumn-sale',
  );
  assert.throws(() => tools.buildUtm({ url: 'acme.example', source: 'x', medium: '', campaign: 'y' }), /utm_medium is needed/);
});

test('structured data: valid JSON-LD, empty fields left out, safe inside a script tag', () => {
  const org = tools.buildSchema({ kind: 'organization', name: 'Acme', url: 'https://acme.example', sameAs: ['https://x.com/acme', ' '], description: '' });
  const json = JSON.parse(org.replace(/^<script[^>]*>\n|\n<\/script>\n$/g, ''));
  assert.deepEqual(json, { '@context': 'https://schema.org', '@type': 'Organization', name: 'Acme', url: 'https://acme.example', sameAs: ['https://x.com/acme'] });
  const faq = tools.buildSchema({ kind: 'faq', faq: [{ q: 'Free returns?', a: 'Yes, 30 days. </script><b>' }, { q: '', a: 'skipped' }] });
  assert.equal((faq.match(/<\/script>/g) || []).length, 1, 'answer text cannot close the script block');
  assert.equal(JSON.parse(faq.replace(/^<script[^>]*>\n|\n<\/script>\n$/g, '')).mainEntity.length, 1);
  assert.throws(() => tools.buildSchema({ kind: 'faq', faq: [] }), /at least one question/);
  assert.throws(() => tools.buildSchema({ kind: 'article', headline: 'x', datePublished: 'soon' }), /isn't a date/);
});

test('the page starts filled in from the site', () => {
  const d = tools.toolDefaults();
  assert.equal(d.name, 'Acme');
  assert.equal(d.sitemapUrl, 'https://acme.example/sitemap.xml');
  assert.equal(d.sitemapPages, 2);
  assert.ok(d.aiCrawlers.some((c) => c.agent === 'GPTBot'));
});
