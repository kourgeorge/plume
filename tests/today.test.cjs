require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { setSetting, getDb } = require('../src/db');
const q = require('../src/queue');
const today = require('../src/today');
const { auditPages } = require('../src/agents/seoAudit');
const { parseReport } = require('../src/analytics/pagespeed');
const { agentSystem } = require('../src/context/profile');
const { closeStaleJobs, startJob, getJob } = require('../src/jobs');

const NOW = new Date('2026-10-16T09:00:00Z');
const page = (o) => ({ url: 'https://a.com/', status: 200, title: 'A good title for the page', meta_description: 'x'.repeat(130), canonical: 'https://a.com/', h1: 'H', headings: '[]', images_missing_alt: 0, has_schema: 1, word_count: 600, ...o });
const slowMobile = parseReport({ lighthouseResult: { categories: { performance: { score: 0.4 }, accessibility: { score: 1 }, 'best-practices': { score: 1 }, seo: { score: 1 } }, audits: {
  'largest-contentful-paint': { numericValue: 9000 }, 'first-contentful-paint': { numericValue: 1000 }, 'total-blocking-time': { numericValue: 50 }, 'cumulative-layout-shift': { numericValue: 0 },
  'uses-optimized-images': { title: 'Efficiently encode images', score: 0.3, description: 'Compress them.', details: { type: 'opportunity', overallSavingsMs: 5000 } } } } }, 'mobile');

test('feed: critical fix, then serious speed problem, then data-backed draft, then other drafts', () => {
  setSetting('lastAudit', auditPages([page({ url: 'https://a.com/x', title: '' }), page({ url: 'https://a.com/y', meta_description: '' })]));
  setSetting('pagespeed', { mobile: slowMobile, desktop: null });
  const plain = q.createDraft({ agent: 'writer', kind: 'article', title: 'Plain', body: '# Plain\n\nSome **bold** words [link](https://x.y).', meta: {} });
  const data = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'From data', body: 'x', meta: { source: 'search-console' } });
  const feed = today.todayFeed(NOW);
  assert.deepEqual(feed.map((i) => i.kind), ['fix', 'speed', 'draft', 'fix', 'draft']);
  assert.equal(feed[2].draft.id, data.id);
  assert.equal(feed[4].draft.preview, 'Some bold words link.');
  assert.equal(feed[4].draft.id, plain.id);
  assert.ok(!('body' in feed[2].draft), 'cards should not carry the whole body');
});

test('skip hides an item for today only', () => {
  const key = today.todayFeed(NOW).find((i) => i.kind === 'draft').key;
  today.skipItem(key, NOW);
  assert.ok(!today.todayFeed(NOW).some((i) => i.key === key));
  assert.ok(today.todayFeed(new Date('2026-10-17T09:00:00Z')).some((i) => i.key === key), 'should come back tomorrow');
});

test('sending speed to the SEO agent turns it into a pinned fix (and it is not shown twice)', () => {
  const fix = today.sendSpeedToSeo('mobile');
  assert.equal(fix.severity, 'critical');
  assert.match(fix.title, /Main content loads \(LCP\): 9\.0s on mobile/);
  assert.match(fix.steps[0], /Efficiently encode images \(could save about 5\.0s\)/);
  const feed = today.todayFeed(NOW);
  assert.ok(feed.some((i) => i.kind === 'fix' && i.fix.id === fix.id));
  assert.ok(!feed.some((i) => i.kind === 'speed' && i.strategy === 'mobile'), 'speed card should give way to the fix');
  today.fixDone(fix.id);
  assert.ok(!today.todayFeed(NOW).some((i) => i.kind === 'fix' && i.fix.id === fix.id));
  assert.ok(!today.todayFeed(NOW).some((i) => i.kind === 'speed' && i.strategy === 'mobile'), 'handled speed report came back after its fix was done');
  // A fresh report that is still slow brings it back.
  setSetting('pagespeed', { mobile: { ...slowMobile, at: '2026-10-17T06:00:00.000Z' }, desktop: null });
  assert.ok(today.todayFeed(NOW).some((i) => i.kind === 'speed' && i.strategy === 'mobile'));
  assert.equal(today.sendSpeedToSeo('desktop'), null, 'no desktop report, nothing to send');
});

test('"not useful" rejects, counts as done, and the agent sees it next time', () => {
  const d = q.createDraft({ agent: 'writer', kind: 'article', title: 'Ten reasons to love widgets', body: 'x', meta: {} });
  today.notUseful(d.id, 'too generic, our buyers are experts');
  assert.equal(q.getDraft(d.id).status, 'rejected');
  assert.ok(today.todayProgress().doneToday >= 1);
  const role = agentSystem('You write.', fs.mkdtempSync(path.join(os.tmpdir(), 'p-')), null, 'writer').at(-1).text;
  assert.match(role, /turned down[\s\S]*"Ten reasons to love widgets": too generic, our buyers are experts/);
  const other = agentSystem('You write.', fs.mkdtempSync(path.join(os.tmpdir(), 'p-')), null, 'seo').at(-1).text;
  assert.doesNotMatch(other, /Ten reasons/, "one agent's rejections shouldn't reach another");
});

test('jobs left running by a restart are closed on startup', () => {
  const id = startJob('agent:seo', 'writing');
  assert.equal(closeStaleJobs() >= 1, true);
  assert.equal(getJob(id).status, 'failed');
  assert.match(getJob(id).error, /restarted/);
});

test('per-agent instructions reach only that agent, are trimmed, capped, and clearable', () => {
  const ins = require('../src/agents/instructions');
  assert.equal(ins.setAgentInstructions('writer', '  Always end with a question.\r\n  '), 'Always end with a question.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p-'));
  assert.match(agentSystem('role', dir, null, 'writer').at(-1).text, /Standing instructions[\s\S]*Always end with a question\./);
  assert.doesNotMatch(agentSystem('role', dir, null, 'seo').at(-1).text, /Always end with a question/);
  assert.throws(() => ins.setAgentInstructions('writer', 'x'.repeat(ins.MAX_INSTRUCTIONS + 1)), /keep instructions under/);
  ins.setAgentInstructions('writer', '');
  assert.equal(ins.agentInstructions('writer'), '');
  assert.doesNotMatch(agentSystem('role', dir, null, 'writer').at(-1).text, /Standing instructions/);
});
