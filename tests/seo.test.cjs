require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { auditPages } = require('../src/agents/seoAudit');
const { openIssues, trackedIssues, setWontFix, markFixed, recordScan, findTracked, issueEvents } = require('../src/issues');
const { cleanUrl, issueId } = require('../src/issueId');
const { setSetting } = require('../src/db');
const { filterNew, searchConsoleGaps } = require('../src/agents/seo');

const page = (o) => ({ url: 'https://a.com/', status: 200, title: 'Acme widgets for small teams', meta_description: 'x'.repeat(130), canonical: 'https://a.com/', h1: 'Widgets', headings: '[]', images_missing_alt: 0, has_schema: 1, word_count: 600, ...o });

test('clean site scores 100', () => {
  const r = auditPages([page(), page({ url: 'https://a.com/b', title: 'Another good page title', canonical: 'https://a.com/b' })], { robotsOk: true, sitemapOk: true });
  assert.equal(r.score, 100);
  assert.equal(r.issues.length, 0);
});

test('finds problems, critical first, with snippets', () => {
  const r = auditPages([
    page(),
    page({ url: 'https://a.com/x', title: '', meta_description: '', canonical: '', images_missing_alt: 2 }),
    page({ url: 'https://a.com/gone', status: 404 }),
    page({ url: 'https://a.com/dup' }),
  ], { sitemapOk: false });
  const checks = r.issues.map((i) => i.check);
  for (const c of ['broken-page', 'missing-title', 'missing-meta-description', 'missing-canonical', 'images-missing-alt', 'duplicate-title', 'missing-sitemap']) assert.ok(checks.includes(c), c);
  assert.equal(r.issues[0].severity, 'critical');
  assert.match(r.issues.find((i) => i.check === 'missing-meta-description').snippet, /<meta name="description"/);
  assert.ok(r.score < 100 && r.score >= 0);
  assert.equal(r.counts.critical, 2);
});

test('snippets escape page text', () => {
  const r = auditPages([page({ url: 'https://a.com/q', title: '', h1: '<script>x</script>' })]);
  assert.doesNotMatch(r.issues.find((i) => i.check === 'missing-title').snippet, /<script>x/);
});

const scan = (pages, at, covers = () => true) => {
  const r = { ...auditPages(pages), at };
  recordScan(r.issues, { agent: 'site-check', at, covers });
  return r;
};

test('every address is written one way, so the same problem always gets the same id', () => {
  assert.equal(cleanUrl('https://A.com/about/?x=1#top'), 'https://a.com/about');
  assert.equal(cleanUrl('https://a.com'), 'https://a.com/');
  assert.equal(cleanUrl('repo:acme/site/package.json'), 'repo:acme/site/package.json');
  assert.equal(issueId('missing-title', 'https://a.com/about/'), issueId('missing-title', 'https://a.com/about'));
});

test('problems survive a rescan: found again stays, not found is "gone", fixed and found again reopens', () => {
  const bad = page({ url: 'https://k.com/x', title: '', meta_description: '' });
  const first = scan([bad], '2026-10-16T05:00:00.000Z');
  const title = first.issues.find((i) => i.check === 'missing-title').id;
  const desc = first.issues.find((i) => i.check === 'missing-meta-description').id;
  assert.equal(openIssues('site-check').filter((i) => i.url === 'https://k.com/x').length, first.issues.length, 'every problem waits, not two a day');

  // The title gets fixed on the site; the next scan no longer finds it.
  scan([{ ...bad, title: 'A good title for the page' }], '2026-10-17T05:00:00.000Z');
  assert.equal(findTracked(title).state, 'gone');
  assert.equal(findTracked(title).status, 'published', 'no longer found counts as resolved');
  assert.equal(findTracked(desc).state, 'open');

  // The owner marks the description fixed, but the next scan still finds it: it is waiting again.
  markFixed(desc, new Date('2026-10-17T10:00:00Z'));
  assert.equal(findTracked(desc).state, 'fixed');
  scan([{ ...bad, title: 'A good title for the page' }], '2026-10-18T05:00:00.000Z');
  assert.equal(findTracked(desc).state, 'open');
  assert.deepEqual(issueEvents(desc).map((e) => e.note), ['found by site-check', 'marked fixed', 'found again after it was marked fixed']);
});

test("a scan that didn't look at a page, or skipped a check, leaves its problems alone", () => {
  const p = page({ url: 'https://s.com/y', title: '' });
  const id = scan([p], '2026-10-16T05:00:00.000Z').issues.find((i) => i.check === 'missing-title').id;
  scan([], '2026-10-17T05:00:00.000Z', () => false);
  assert.equal(findTracked(id).state, 'open', 'a scan that covered nothing closed a problem');
  // A page that now returns an error only had the "broken page" check, so its old problems stay as they were.
  scan([{ ...p, status: 500 }], '2026-10-18T05:00:00.000Z', (check, url) => check === 'broken-page' || url !== 'https://s.com/y');
  assert.equal(findTracked(id).state, 'open');
});

test("won't fix stays out even when a later scan finds it again, until reopened", () => {
  const p = page({ url: 'https://w.com/z', h1: '' });
  const id = scan([p], '2026-10-16T05:00:00.000Z').issues.find((i) => i.check === 'missing-h1').id;
  setWontFix(id, true);
  scan([p], '2026-10-17T05:00:00.000Z');
  assert.equal(findTracked(id).status, 'rejected');
  assert.ok(!openIssues('site-check').some((i) => i.id === id));
  setWontFix(id, false);
  assert.ok(openIssues('site-check').some((i) => i.id === id));
});

test('problems from the compliance check belong to the compliance agent', () => {
  recordScan([{ id: 'no-banner:https://a.com/', check: 'no-banner', severity: 'critical', area: 'privacy', url: 'https://a.com/', title: 'No banner', why: 'w', steps: ['s'] }], { agent: 'compliance', at: '2026-10-17T05:00:00.000Z', covers: () => false });
  assert.deepEqual(openIssues('compliance').map((i) => i.id), ['no-banner:https://a.com/']);
});

test('filterNew drops covered and duplicate keywords', () => {
  const opps = [{ keyword: 'Widget pricing' }, { keyword: 'widget pricing' }, { keyword: 'best widgets' }, { keyword: 'acme widgets' }, { keyword: '' }];
  const out = filterNew(opps, new Set(['best widgets']), ['Acme Widgets for teams']);
  assert.deepEqual(out.map((o) => o.keyword), ['Widget pricing']);
});

test('searchConsoleGaps picks page-2 terms with real impressions', () => {
  const out = searchConsoleGaps([
    { query: 'a', impressions: 500, position: 12 },
    { query: 'b', impressions: 900, position: 3 },
    { query: 'c', impressions: 10, position: 15 },
    { query: 'd', impressions: 800, position: 20 },
  ]);
  assert.deepEqual(out.map((o) => o.keyword), ['d', 'a']);
});

test('new checks: hidden from Google, social preview, late main image, unsized images', () => {
  const r = auditPages([
    page({ meta_robots: 'noindex', og: '{"title":"A"}', hero_lazy: 1, images_no_size: 4 }),
    page({ url: 'https://a.com/b', title: 'Another good page title', canonical: 'https://a.com/b', meta_robots: '', og: '{"title":"B","image":"/i.jpg"}', hero_lazy: 0, images_no_size: 0 }),
  ]);
  const by = (c) => r.issues.filter((i) => i.check === c);
  assert.equal(by('noindex')[0].severity, 'critical', 'a hidden home page is critical');
  assert.equal(by('missing-social-preview').length, 1);
  assert.match(by('missing-social-preview')[0].snippet, /og:image/);
  assert.equal(by('hero-image-lazy').length, 1);
  assert.equal(by('images-no-size').length, 1);
  // Rows from an older crawl (no new columns) skip these checks instead of failing them.
  assert.equal(auditPages([page()]).issues.length, 0);
});

test('pages nothing links to are reported only after a complete read', () => {
  const pages = [
    page({ links_out: '["https://a.com/b"]' }),
    page({ url: 'https://a.com/b', title: 'Linked page title here', canonical: 'https://a.com/b', links_out: '[]' }),
    page({ url: 'https://a.com/lost', title: 'Lost page title here', canonical: 'https://a.com/lost', links_out: '[]' }),
  ];
  assert.deepEqual(auditPages(pages, { crawlComplete: true }).issues.filter((i) => i.check === 'orphan-page').map((i) => i.url), ['https://a.com/lost']);
  assert.equal(auditPages(pages, { crawlComplete: false }).issues.filter((i) => i.check === 'orphan-page').length, 0);
});

test('language links: a bad code and a version that does not link back are reported', () => {
  const en = page({ hreflang: JSON.stringify([{ lang: 'en', href: 'https://a.com/' }, { lang: 'he', href: 'https://a.com/he' }, { lang: 'uk_UK', href: 'https://a.com/uk' }]) });
  const he = page({ url: 'https://a.com/he', title: 'Hebrew page title here', canonical: 'https://a.com/he', hreflang: JSON.stringify([{ lang: 'he', href: 'https://a.com/he' }]) });
  const issue = auditPages([en, he]).issues.find((i) => i.check === 'hreflang-errors' && i.url === 'https://a.com/');
  assert.ok(issue);
  assert.ok(issue.steps.some((s) => s.includes('"uk_UK"')));
  assert.ok(issue.steps.some((s) => s.includes("doesn't link back")));
  assert.equal(auditPages([page({ hreflang: JSON.stringify([{ lang: 'en', href: 'https://a.com/' }, { lang: 'x-default', href: 'https://a.com/' }]) })]).issues.length, 0);
});

test('http that does not move to https is reported', () => {
  assert.ok(auditPages([page()], { httpsRedirect: false }).issues.some((i) => i.check === 'no-https-redirect'));
  assert.equal(auditPages([page()], { httpsRedirect: true }).issues.length, 0);
});

test('brief: directories and own site are not competitors; competitor pages are read for headings', async () => {
  const { isCompetitor, readCompetitors, briefPrompt } = require('../src/seo/brief');
  assert.equal(isCompetitor({ url: 'https://en.wikipedia.org/x', domain: 'en.wikipedia.org' }, null), false);
  assert.equal(isCompetitor({ url: 'https://www.amazon.co.uk/x', domain: 'www.amazon.co.uk' }, null), false);
  assert.equal(isCompetitor({ url: 'https://dmv.ca.gov/x', domain: 'dmv.ca.gov' }, null), false);
  assert.equal(isCompetitor({ url: 'https://a.com/x', domain: 'a.com' }, 'https://www.a.com'), false);
  assert.equal(isCompetitor({ url: 'https://rival.com/x', domain: 'rival.com' }, null), true);
  const html = `<html><head><title>Rival guide</title></head><body><h1>Guide</h1><h2>Step one</h2><p>${'word '.repeat(300)}</p></body></html>`;
  const fakeFetch = async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  const got = await readCompetitors([
    { position: 1, url: 'https://en.wikipedia.org/x', domain: 'en.wikipedia.org', title: 'W' },
    { position: 2, url: 'https://rival.com/guide', domain: 'rival.com', title: 'R' },
  ], 4, fakeFetch);
  assert.equal(got.length, 1);
  assert.equal(got[0].position, 2);
  assert.deepEqual(got[0].headings, ['Guide', '  Step one']);
  const prompt = briefPrompt({ keyword: 'k', intent: 'informational', pageType: 'step-by-step guide', targetWords: 1200, covered: ['steps'], gaps: ['local prices'], outline: ['How long does it take?'], angle: 'First-hand.', competitors: got });
  assert.match(prompt, /step-by-step guide/);
  assert.match(prompt, /local prices/);
});

test('brief without DataForSEO: a web search finds the top pages; with no search at all it still plans, marked as such', async () => {
  const http = require('node:http');
  const { topResults } = require('../src/seo/brief');
  const { serpCreds } = require('../src/seo/serp');
  assert.equal(serpCreds({}), null, 'this test needs no DataForSEO login');
  let asked = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      asked = JSON.parse(body).query;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ title: 'Rival guide', url: 'https://rival.com/guide', content: '' }, { title: 'Wiki', url: 'https://en.wikipedia.org/w', content: '' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { TAVILY_API_KEY: 'k', TAVILY_API_URL: `http://127.0.0.1:${server.address().port}/search`, PLUME_SEARCH: 'local' };
  try {
    const got = await topResults('desk cable organizer', 'seo', env);
    assert.equal(asked, 'desk cable organizer');
    assert.equal(got.from, 'web-search');
    assert.deepEqual(got.results.map((r) => [r.position, r.domain]), [[1, 'rival.com'], [2, 'en.wikipedia.org']]);
  } finally {
    server.close();
  }
  const none = await topResults('desk cable organizer', 'seo', { PLUME_SEARCH: 'off' });
  assert.deepEqual(none, { results: [], from: 'none' });
});
