require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
delete process.env.DATAFORSEO_LOGIN;
delete process.env.DATAFORSEO_PASSWORD;

const { getDb, getGlobalDb } = require('../src/db');
const kd = require('../src/seo/keywordData');
const serp = require('../src/seo/serp');
const { addCompetitor } = require('../src/context/extra');
const { applyMetrics, gapOpportunity } = require('../src/agents/seo');

getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://www.acme.example', 'Acme', 'now')`).run();

const ok = (items, cost = 0.0125) => ({ status_code: 20000, tasks: [{ status_code: 20000, cost, result: [{ items }] }] });
const overviewItem = (keyword, volume, difficulty, intent = 'commercial') => ({
  keyword,
  keyword_info: { search_volume: volume, cpc: 1.5 },
  keyword_properties: { keyword_difficulty: difficulty },
  search_intent_info: { main_intent: intent },
});
const rankedItem = (keyword, position, volume, difficulty, url) => ({
  keyword_data: { keyword, keyword_info: { search_volume: volume }, keyword_properties: { keyword_difficulty: difficulty } },
  ranked_serp_element: { serp_item: { rank_group: position, url } },
});
const respond = (body) => async (url, init) => {
  respond.calls.push({ url, body: JSON.parse(init.body)[0] });
  return new Response(JSON.stringify(typeof body === 'function' ? body(JSON.parse(init.body)[0]) : body), { status: 200 });
};
respond.calls = [];

test('parses the keyword overview response', () => {
  const { items, cost } = kd.parseOverview(ok([overviewItem('Standing Desk', 1300, 22)]));
  assert.deepEqual(items, [{ keyword: 'standing desk', volume: 1300, difficulty: 22, intent: 'commercial', cpc: 1.5 }]);
  assert.equal(cost, 0.0125);
  assert.throws(() => kd.parseOverview({ tasks: [{ status_code: 40501, status_message: 'Invalid Field' }] }), /DataForSEO: Invalid Field/);
});

test('no login: nothing is looked up and nothing is charged', async () => {
  respond.calls = [];
  const r = await kd.keywordMetrics(['standing desk'], respond(ok([])));
  assert.equal(r.cost, 0);
  assert.equal(r.metrics.size, 0);
  assert.equal(respond.calls.length, 0);
});

test('looks up once, then reuses the saved numbers for a month', async () => {
  serp.saveSerpCreds('me@acme.example', 'secret');
  respond.calls = [];
  const fake = respond(ok([overviewItem('standing desk', 1300, 22), overviewItem('desk', 90000, 88)]));
  const first = await kd.keywordMetrics(['Standing Desk', 'desk', 'never searched thing'], fake);
  assert.equal(respond.calls.length, 1);
  assert.match(respond.calls[0].url, /keyword_overview\/live$/);
  assert.deepEqual(respond.calls[0].body.keywords.sort(), ['desk', 'never searched thing', 'standing desk']);
  assert.equal(respond.calls[0].body.location_name, 'United States');
  assert.equal(first.metrics.get('standing desk').volume, 1300);
  assert.equal(first.metrics.get('never searched thing').volume, null, 'unknown searches are saved as empty');
  const again = await kd.keywordMetrics(['standing desk', 'never searched thing'], fake);
  assert.equal(respond.calls.length, 1, 'nothing new to pay for');
  assert.equal(again.cost, 0);
  assert.equal(again.metrics.get('desk'), undefined, 'only what was asked for comes back');
  // Older than a month: looked up again.
  getDb().prepare("UPDATE keyword_metrics SET at = '2020-01-01T00:00:00Z' WHERE keyword = 'desk'").run();
  await kd.keywordMetrics(['desk', 'standing desk'], fake);
  assert.equal(respond.calls.length, 2);
  assert.deepEqual(respond.calls[1].body.keywords, ['desk']);
});

test('winnable: drops searches nobody makes or that are too hard; unknown passes', () => {
  assert.equal(kd.winnable(undefined), true);
  assert.equal(kd.winnable({ volume: null, difficulty: null }), true);
  assert.equal(kd.winnable({ volume: 0, difficulty: 5 }), false);
  assert.equal(kd.winnable({ volume: 500, difficulty: 50 }), true);
  assert.equal(kd.winnable({ volume: 500, difficulty: 51 }), false);
  assert.equal(kd.describeMetrics({ volume: 1300, difficulty: 22 }), 'about 1,300 searches a month, difficulty 22 of 100');
  assert.equal(kd.describeMetrics(undefined), '');
});

test("the SEO agent's ideas are filtered and ordered by the numbers", () => {
  const opps = [
    { keyword: 'desk', title: 'Desks', kind: 'blog_post', reason: 'Big.' },
    { keyword: 'unknown idea', title: 'U', kind: 'blog_post', reason: 'Maybe.' },
    { keyword: 'nobody searches', title: 'N', kind: 'blog_post', reason: 'Hm.' },
    { keyword: 'small desk', title: 'S', kind: 'blog_post', reason: 'Niche.' },
    { keyword: 'standing desk', title: 'SD', kind: 'blog_post', reason: 'Good.' },
  ];
  const metrics = new Map([
    ['desk', { keyword: 'desk', volume: 90000, difficulty: 88 }],
    ['nobody searches', { keyword: 'nobody searches', volume: 0, difficulty: 3 }],
    ['small desk', { keyword: 'small desk', volume: 200, difficulty: 10 }],
    ['standing desk', { keyword: 'standing desk', volume: 1300, difficulty: 22 }],
  ]);
  const out = applyMetrics(opps, metrics);
  assert.deepEqual(out.map((o) => o.keyword), ['standing desk', 'small desk', 'unknown idea']);
  assert.equal(out[0].reason, 'Good. (about 1,300 searches a month, difficulty 22 of 100)');
  assert.equal(out[2].reason, 'Maybe.', 'no numbers, reason unchanged');
  assert.deepEqual(applyMetrics(opps, new Map()).map((o) => o.keyword), opps.map((o) => o.keyword), 'no data: unchanged');
});

test('competitor keywords: saved per competitor, and gaps leave out what we already show for', async () => {
  const rival = addCompetitor({ name: 'Rival', url: 'https://www.rival.example' });
  const other = addCompetitor({ name: 'Other', url: 'https://other.example' });
  addCompetitor({ name: 'No site' });
  // We already show up (position 18) for "desk lamp" in Search Console.
  getDb().prepare('INSERT INTO gsc_daily (date, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?)').run('2026-10-01', 'desk lamp', 'https://acme.example/', 0, 40, 18);
  respond.calls = [];
  const byTarget = {
    'rival.example': [
      rankedItem('cable tray', 2, 900, 15, 'https://rival.example/cable'),
      rankedItem('desk lamp', 1, 5000, 20, 'https://rival.example/lamp'),
      rankedItem('office chair', 4, 40000, 80, 'https://rival.example/chair'),
      rankedItem('acme desk review', 3, 300, 5, 'https://rival.example/acme'),
    ],
    'other.example': [rankedItem('cable tray', 5, 900, 15, 'https://other.example/c'), rankedItem('monitor arm', 7, 400, 30, 'https://other.example/m')],
  };
  const fake = respond((body) => ok(byTarget[body.target] ?? [], 0.02));
  const r = await kd.refreshCompetitorKeywords(fake);
  assert.deepEqual(r, { checked: 2, keywords: 6, cost: 0.04, failed: null });
  assert.deepEqual(respond.calls.map((c) => c.body.target), ['rival.example', 'other.example'], 'bare domain, competitors without a site skipped');
  assert.match(respond.calls[0].url, /ranked_keywords\/live$/);
  assert.deepEqual(respond.calls[0].body.item_types, ['organic']);

  const gaps = kd.keywordGaps(10);
  assert.deepEqual(gaps.map((g) => g.keyword), ['cable tray', 'monitor arm'], 'not "desk lamp" (ours), "office chair" (too hard) or our own name');
  assert.deepEqual(gaps[0].competitors.map((c) => c.name), ['Rival', 'Other']);
  assert.deepEqual(kd.keywordGaps(10, ['cable tray']).map((g) => g.keyword), ['monitor arm'], 'already tracked can be skipped');
  // The numbers came with the results, so no separate lookup is needed for them.
  assert.equal(kd.savedMetrics(['cable tray']).get('cable tray').volume, 900);
  assert.ok(kd.competitorKeywordsCheckedAt());

  const opp = gapOpportunity(gaps[0]);
  assert.equal(opp.source, 'competitor-gap');
  assert.match(opp.reason, /Rival \(#2\), Other \(#5\) are on Google's first page for "cable tray" and you don't show up at all \(about 900 searches a month, difficulty 15 of 100\)/);

  // A rerun replaces a competitor's list rather than adding to it.
  byTarget['other.example'] = [];
  await kd.refreshCompetitorKeywords(fake);
  assert.deepEqual(kd.keywordGaps(10).map((g) => g.keyword), ['cable tray']);
  assert.deepEqual(kd.keywordGaps(10)[0].competitors.map((c) => c.name), ['Rival']);
  void other;
  void rival;
});

test('an account problem stops the competitor run with a plain reason', async () => {
  const broke = async () => new Response(JSON.stringify({ status_code: 40200, status_message: 'Payment Required' }), { status: 402 });
  const r = await kd.refreshCompetitorKeywords(broke);
  assert.equal(r.checked, 0);
  assert.match(r.failed, /^Rival: .*out of money/);
  await assert.rejects(kd.keywordMetrics(['brand new search'], broke), /out of money/);
});
