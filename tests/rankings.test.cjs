require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
delete process.env.DATAFORSEO_LOGIN;
const { getDb, getGlobalDb } = require('../src/db');
const r = require('../src/seo/rankings');
const serp = require('../src/seo/serp');
const today = require('../src/today');

getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://www.acme.example', 'Acme', 'now')`).run();

// Search Console history: one row per day. Positions per day are given; impressions decide the weekly weights.
const ins = getDb().prepare('INSERT OR REPLACE INTO gsc_daily (date, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?)');
const day = (d) => new Date(Date.UTC(2026, 8, d)).toISOString().slice(0, 10); // September 2026
function seed(query, weeks) {
  // weeks: [[position, impressionsPerDay, clicksPerDay], ...] starting Monday 2026-09-07, 7 days each
  weeks.forEach(([pos, imp, clk], w) => {
    for (let i = 0; i < 7; i++) ins.run(day(7 + w * 7 + i), query, 'https://acme.example/widgets', clk, imp, pos);
  });
}
seed('modular desk', [[14, 20, 0], [13, 20, 1], [12, 20, 1], [6, 20, 3]]); // big rise in the last week
seed('cable tray', [[5, 30, 2], [5, 30, 2], [6, 30, 2], [10, 30, 1]]); // big drop
seed('rare thing', [[30, 1, 0], [20, 1, 0], [25, 1, 0], [8, 1, 0]]); // moves a lot, but on too few impressions
// A partial week after the last full one: only Monday 2026-10-05.
ins.run('2026-10-05', 'modular desk', 'https://acme.example/widgets', 0, 5, 40);

test('weekOf finds the Monday', () => {
  assert.equal(r.weekOf('2026-09-07'), '2026-09-07'); // a Monday
  assert.equal(r.weekOf('2026-09-13'), '2026-09-07'); // Sunday
  assert.equal(r.weekOf('2026-09-14T10:00:00Z'), '2026-09-14');
});

test('only complete weeks are used, so a partial week cannot distort the trend', () => {
  assert.deepEqual(r.completeWeeks(2), ['2026-09-21', '2026-09-28']);
  const h = r.keywordHistory('modular desk', 4);
  assert.deepEqual(h.map((p) => p.week), ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  assert.deepEqual(h.map((p) => p.position), [14, 13, 12, 6]);
  assert.equal(h[3].clicks, 21);
  assert.equal(h[3].topPage, 'https://acme.example/widgets');
});

test('weekly position is weighted by impressions across pages', () => {
  ins.run('2026-09-28', 'two pages', 'https://acme.example/a', 0, 90, 4);
  ins.run('2026-09-28', 'two pages', 'https://acme.example/b', 0, 10, 14);
  const [w] = r.keywordHistory('two pages', 1);
  assert.equal(w.position, 5);
  assert.equal(w.topPage, 'https://acme.example/a');
});

test('tracking: normalised, no duplicates, capped, removable', () => {
  assert.deepEqual(r.trackKeyword('  Modular   Desk ').keyword, 'modular desk');
  assert.equal(r.trackKeyword('modular desk'), null);
  r.trackKeyword('cable tray');
  r.trackKeyword('rare thing', 'suggested');
  assert.throws(() => r.normalizeKeyword('   '), /type a search term/);
  assert.deepEqual(r.listTracked().map((t) => t.keyword), ['modular desk', 'cable tray', 'rare thing']);
  r.trackKeyword('temporary');
  r.untrackKeyword('Temporary');
  assert.ok(!r.listTracked().some((t) => t.keyword === 'temporary'));
});

test('table shows current position and movement (positive = moved up)', () => {
  const rows = Object.fromEntries(r.rankingsTable(4).map((x) => [x.keyword, x]));
  assert.equal(rows['modular desk'].current.position, 6);
  assert.equal(rows['modular desk'].change, 6);
  assert.equal(rows['cable tray'].change, -4);
  assert.equal(rows['modular desk'].serp, null);
});

test('big moves become one alert each, ignore thin data, and show in Today with drops first', () => {
  assert.equal(r.detectMoves(), 2);
  assert.equal(r.detectMoves(), 0, 'running again must not repeat alerts');
  const alerts = r.openAlerts();
  assert.deepEqual(alerts.map((a) => [a.keyword, a.from, a.to]).sort(), [['cable tray', 6, 10], ['modular desk', 12, 6]]);
  const cards = today.todayFeed().filter((i) => i.kind === 'rank');
  assert.equal(cards[0].alert.keyword, 'cable tray', 'a drop should come before a rise');
  today.rankAlertSeen(cards[0].alert.id);
  assert.equal(today.todayFeed().filter((i) => i.kind === 'rank').length, 1);
});

test('suggestions skip searches already tracked', () => {
  ins.run('2026-09-29', 'desk organiser', 'https://acme.example/', 4, 60, 3); // brings clicks
  ins.run('2026-09-29', 'standing desk mat', 'https://acme.example/', 0, 80, 15); // close to page one
  const s = r.suggestKeywords(10);
  const words = s.map((x) => x.keyword);
  assert.ok(!words.includes('modular desk'), 'already tracked');
  assert.ok(!words.includes('two pages'), 'position 5 with no clicks is neither close nor bringing visitors');
  assert.match(s.find((x) => x.keyword === 'standing desk mat').why, /close to page one/);
  assert.match(s.find((x) => x.keyword === 'desk organiser').why, /brings visitors \(4 clicks/);
});

const SERP_RESPONSE = {
  status_code: 20000,
  tasks: [{
    status_code: 20000, cost: 0.002,
    result: [{ items: [
      { type: 'paid', rank_group: 1, url: 'https://ads.example/', domain: 'ads.example' },
      { type: 'organic', rank_group: 1, url: 'https://rival.example/desk', domain: 'rival.example', title: 'Rival desk' },
      { type: 'local_pack', rank_group: 2, url: 'https://maps.example/', domain: 'maps.example' },
      { type: 'organic', rank_group: 2, url: 'https://big.example/x', domain: 'www.big.example', title: 'Big' },
      { type: 'organic', rank_group: 3, url: 'https://acme.example/widgets', domain: 'acme.example', title: 'Us' },
    ] }],
  }],
};

test('result lists keep only organic results and find us with or without www', () => {
  const { results, cost } = serp.parseSerp(SERP_RESPONSE);
  assert.deepEqual(results.map((x) => x.domain), ['rival.example', 'www.big.example', 'acme.example']);
  assert.equal(cost, 0.002);
  assert.equal(serp.ourPosition(results, 'https://www.acme.example'), 3);
  assert.equal(serp.ourPosition(results, 'https://other.example'), null);
  assert.throws(() => serp.parseSerp({ tasks: [{ status_code: 40501, status_message: 'Invalid Field' }] }), /DataForSEO: Invalid Field/);
});

test('lookups need a login; saved login is private and the password is never shown', async () => {
  await assert.rejects(serp.checkSerp('modular desk'), /add a DataForSEO login/);
  serp.saveSerpCreds('me@acme.example', 'secret-pass');
  const file = path.join(process.env.DATA_DIR, 'tokens', 'dataforseo.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(serp.describeSerp()).includes('secret-pass'));
  serp.saveSerpCreds('me@acme.example', ''); // empty password keeps the saved one
  assert.equal(serp.serpCreds().password, 'secret-pass');
});

test('a lookup saves a snapshot and the table shows who is above us', async () => {
  let sent;
  const fake = async (url, init) => ((sent = { url, init }), new Response(JSON.stringify(SERP_RESPONSE), { status: 200 }));
  const out = await serp.checkSerp('modular desk', fake);
  assert.equal(out.ourPosition, 3);
  const body = JSON.parse(sent.init.body)[0];
  assert.equal(body.keyword, 'modular desk');
  assert.equal(body.location_name, 'United States', 'English site → United States by default');
  assert.equal(sent.init.headers.authorization, 'Basic ' + Buffer.from('me@acme.example:secret-pass').toString('base64'));
  const row = r.rankingsTable(4).find((x) => x.keyword === 'modular desk');
  assert.deepEqual(row.serp.above, ['rival.example', 'www.big.example']);
  serp.setSerpLocation('Israel');
  assert.equal(serp.serpLocation(), 'Israel');
  assert.throws(() => serp.setSerpLocation('<script>'), /write the country name/);
});

test('account problems stop the weekly run with a plain reason', async () => {
  const broke = async () => new Response(JSON.stringify({ status_code: 40200, status_message: 'Payment Required' }), { status: 402 });
  const res = await serp.checkAllSerps(broke);
  assert.equal(res.checked, 0);
  assert.match(res.failed, /out of money/);
  const refused = async () => new Response('{}', { status: 401 });
  await assert.rejects(serp.checkSerp('cable tray', refused), /refused the login/);
});
