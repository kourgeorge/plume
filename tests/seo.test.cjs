require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
const { auditPages, dailyFixes, markFixDone } = require('../src/agents/seoAudit');
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

test('two fixes a day, stable within the day, new ones the next day', () => {
  const r = auditPages([page({ url: 'https://a.com/x', title: '', meta_description: '', canonical: '', h1: '' })]);
  const d1 = dailyFixes(r, 2, '2026-10-16');
  assert.equal(d1.length, 2);
  assert.deepEqual(dailyFixes(r, 2, '2026-10-16').map((i) => i.id), d1.map((i) => i.id));
  markFixDone(d1[0].id);
  const d2 = dailyFixes(r, 2, '2026-10-17');
  assert.ok(!d2.some((i) => d1.some((j) => j.id === i.id)), 'repeated a fix');
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
