require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { getDb, getGlobalDb } = require('../src/db');
const budget = require('../src/llm/budget');
const sched = require('../src/scheduler');
const { recentLogs } = require('../src/log');
const ps = require('../src/analytics/pagespeed');

const spend = (usd, at = new Date().toISOString()) =>
  getGlobalDb().prepare(`INSERT INTO llm_calls (at, site, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, cost_usd, stop_reason) VALUES (?, 'other-site.example', 't', 'm', 0, 0, 0, 0, 0, ?, 'end_turn')`).run(at, usd);

test('budget: one limit for all sites, counts this month only, warns once at 80%, stops at the limit', () => {
  budget.setBudgetLimit(10);
  spend(100, '2020-01-05T00:00:00Z'); // an old month doesn't count
  spend(8.5);
  budget.checkBudget('first');
  budget.checkBudget('second');
  const warns = recentLogs({ source: 'budget' });
  assert.equal(warns.length, 1, 'should warn exactly once per month');
  spend(2);
  assert.throws(() => budget.checkBudget('third'), (e) => e instanceof budget.BudgetExceeded && /\$10\.50 of \$10\.00/.test(e.message));
  const s = budget.budgetStatus();
  assert.equal(s.remaining, 0);
  assert.match(s.resets, /-01T00:00:00/);
  budget.setBudgetLimit(0);
  budget.checkBudget('no limit'); // 0 = unlimited
  assert.throws(() => budget.setBudgetLimit(-1), /zero \(no limit\) or a positive/);
});

test('scheduler: AI tasks start off, free tasks start on; settings validate', () => {
  const ids = sched.taskDefs().map((t) => t.id);
  for (const id of ['publish', 'google', 'site-check', 'speed', 'agent:seo', 'agent:writer']) assert.ok(ids.includes(id), id);
  assert.equal(sched.taskSetting('agent:seo').enabled, false);
  assert.equal(sched.taskSetting('site-check').enabled, true);
  assert.throws(() => sched.updateTask('agent:seo', { cron: 'every day' }), /not a valid timetable/);
  assert.throws(() => sched.updateTask('agent:seo', { limit: 50 }), /1–10/);
  const s = sched.updateTask('agent:seo', { enabled: true, cron: '5 9 * * 1', limit: 2 });
  assert.deepEqual(s, { enabled: true, cron: '5 9 * * 1', limit: 2 });
  assert.equal(sched.taskSetting('agent:seo').cron, '5 9 * * 1');
  sched.stopScheduler();
});

test('runTask records the run, logs failures, and turns "out of budget" into a skip', async () => {
  const r = await sched.runTask('agent:seo'); // no profile yet -> fails with the reason
  assert.equal(r.status, 'failed');
  assert.match(r.message, /finish the business profile first/);
  const row = getDb().prepare(`SELECT status, message FROM task_runs WHERE task = 'agent:seo' ORDER BY id DESC`).get();
  assert.equal(row.status, 'failed');
  assert.ok(recentLogs({ source: 'agent:seo', level: 'error' }).length >= 1);
  const skip = await sched.runTask('site-check'); // no site yet
  assert.equal(skip.status, 'done');
  assert.match(skip.message, /no site yet/);
  sched.stopScheduler();
});

test('pagespeed report: scores, vitals with ratings, top fixes, plain-English headline', () => {
  const raw = {
    lighthouseResult: {
      finalDisplayedUrl: 'https://site.test/',
      categories: { performance: { score: 0.54 }, accessibility: { score: 1 }, 'best-practices': { score: 0.73 }, seo: { score: 0.91 } },
      audits: {
        'largest-contentful-paint': { numericValue: 19800 },
        'first-contentful-paint': { numericValue: 3400 },
        'total-blocking-time': { numericValue: 499 },
        'cumulative-layout-shift': { numericValue: 0.051 },
        'render-blocking-resources': { title: 'Eliminate render-blocking resources', score: 0.2, description: 'Resources block paint. [Learn more](https://x)', details: { type: 'opportunity', overallSavingsMs: 2400 } },
        'uses-optimized-images': { title: 'Efficiently encode images', score: 0.4, description: 'Smaller images load faster.', details: { type: 'opportunity', overallSavingsMs: 9100 } },
        'tiny-win': { title: 'Tiny', score: 0.5, details: { type: 'opportunity', overallSavingsMs: 40 } },
      },
    },
  };
  const r = ps.parseReport(raw, 'mobile');
  assert.deepEqual(r.scores, { performance: 54, accessibility: 100, bestPractices: 73, seo: 91 });
  const v = Object.fromEntries(r.vitals.map((x) => [x.id, x]));
  assert.equal(v.lcp.display, '19.8s');
  assert.equal(v.lcp.rating, 'poor');
  assert.equal(v.lcp.target, 'aim under 2.5s');
  assert.equal(v.fcp.rating, 'poor');
  assert.equal(v.tbt.display, '499ms');
  assert.equal(v.tbt.rating, 'needs-work');
  assert.equal(v.cls.target, 'passing');
  assert.deepEqual(r.opportunities.map((o) => o.id), ['uses-optimized-images', 'render-blocking-resources']);
  assert.doesNotMatch(r.opportunities[1].description, /\]\(/, 'markdown links should be stripped');
  assert.equal(r.headline, 'On phones, your pages take 19.8s to show their main content. Google counts anything over 4.0s as poor.');
  assert.throws(() => ps.parseReport({ error: { message: 'bad url' } }, 'mobile'), /bad url/);
});

test('pagespeed: everything passing gives no headline', () => {
  const vit = [{ id: 'lcp', value: 1200, rating: 'good' }, { id: 'cls', value: 0.01, rating: 'good' }];
  assert.equal(ps.headline(vit, 'desktop'), null);
});

test("a site's log shows its own lines, and only Plume's warnings, not its start-up chatter", () => {
  const { log, recentLogs } = require('../src/log');
  const { withSite } = require('../src/site');
  const { getGlobalDb } = require('../src/db');
  const insert = getGlobalDb().prepare('INSERT INTO logs (at, site, level, source, message) VALUES (?, ?, ?, ?, ?)');
  const at = new Date().toISOString();
  insert.run(at, null, 'info', 'server', 'Plume is running at http://127.0.0.1:1');
  insert.run(at, null, 'warn', 'server', 'AI is off: test');
  insert.run(at, 'other.example', 'info', 'research', 'other site line');
  withSite('test.example', () => log('info', 'research', 'this site line'));
  const lines = withSite('test.example', () => recentLogs({ limit: 1000 }).map((l) => l.message));
  assert.ok(lines.includes('this site line'));
  assert.ok(lines.includes('AI is off: test'));
  assert.ok(!lines.includes('Plume is running at http://127.0.0.1:1'));
  assert.ok(!lines.includes('other site line'));
});
