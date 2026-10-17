require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { getDb, setSetting } = require('../src/db');
const actions = require('../src/actions');
const today = require('../src/today');
const q = require('../src/queue');
const { auditPages } = require('../src/agents/seoAudit');
const { agentSystem } = require('../src/context/profile');

const page = (o) => ({ url: 'https://a.com/', status: 200, title: 'A good title for the page', meta_description: 'x'.repeat(130), canonical: 'https://a.com/', h1: 'H', headings: '[]', images_missing_alt: 0, has_schema: 1, word_count: 600, ...o });
const day = (base, n) => new Date(new Date(`${base}T00:00:00Z`).getTime() + n * 86400e3).toISOString().slice(0, 10);
const reset = () => getDb().exec('DELETE FROM actions; DELETE FROM audit_history; DELETE FROM gsc_daily; DELETE FROM ga_daily; DELETE FROM drafts; DELETE FROM draft_events; DELETE FROM settings;');
const audit = (at, pages) => ({ ...auditPages(pages), at });

test('marking a fix done records it with its page; the next check tells whether it is gone', () => {
  reset();
  const broken = audit('2026-09-01T06:00:00Z', [page({ url: 'https://a.com/pricing', title: '' })]);
  setSetting('lastAudit', broken);
  actions.saveAuditHistory(broken);
  const issue = broken.issues.find((i) => i.url === 'https://a.com/pricing');
  today.fixDone(issue.id);
  const [a] = actions.listActions();
  assert.equal(a.kind, 'fix-done');
  assert.equal(a.url, 'https://a.com/pricing');
  assert.equal(actions.actionResults()[0].problem, 'not checked yet');

  actions.saveAuditHistory({ ...broken, at: new Date(Date.now() + 86400e3).toISOString() });
  assert.equal(actions.actionResults()[0].problem, 'still there');
  actions.saveAuditHistory(audit(new Date(Date.now() + 86400e3).toISOString(), [page({ url: 'https://a.com/pricing' })]));
  assert.equal(actions.actionResults()[0].problem, 'gone');
});

test('a robots.txt fix is measured on the whole site', () => {
  reset();
  actions.recordFixDone({ id: 'ai-crawlers-blocked:https://a.com/robots.txt', check: 'ai-crawlers-blocked', severity: 'critical', area: 'ai-search', url: 'https://a.com/robots.txt', title: 'robots', why: '', steps: [] });
  assert.equal(actions.listActions()[0].url, null);
});

test('before and after: same-length windows, only that page, and "too early" under two weeks', () => {
  reset();
  const ins = getDb().prepare('INSERT INTO gsc_daily (date, query, page, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = -28; i <= 28; i++) {
    if (i === 0) continue;
    ins.run(day('2026-09-01', i), 'q', 'https://a.com/pricing', i < 0 ? 1 : 2, 10, i < 0 ? 14 : 10);
    ins.run(day('2026-09-01', i), 'q', 'https://a.com/other', 100, 100, 3);
  }
  actions.recordAction({ kind: 'fix-done', ref: 'x', url: 'https://www.a.com/pricing/', title: 'Missing title' }, new Date('2026-09-01T10:00:00Z'));
  const [r] = actions.actionResults();
  assert.equal(r.daysAfter, 28);
  assert.equal(r.tooEarly, false);
  assert.deepEqual([r.before.clicks, r.after.clicks], [28, 56]);
  assert.deepEqual([r.before.position, r.after.position], [14, 10]);

  actions.recordAction({ kind: 'fix-done', ref: 'y', url: 'https://a.com/pricing', title: 'Late fix' }, new Date('2026-09-20T10:00:00Z'));
  const late = actions.actionResults().find((x) => x.ref === 'y');
  assert.equal(late.daysAfter, 9);
  assert.equal(late.tooEarly, true);
  assert.equal(late.before.clicks, 18, 'before is as long as the after: 9 days at 2 clicks');
});

test('one site check history row per day', () => {
  reset();
  actions.saveAuditHistory(audit('2026-09-01T05:00:00Z', [page({ title: '' })]));
  actions.saveAuditHistory(audit('2026-09-01T09:00:00Z', [page({})]));
  actions.saveAuditHistory(audit('2026-09-02T05:00:00Z', [page({})]));
  const h = actions.auditHistory();
  assert.equal(h.length, 2);
  assert.equal(h[0].day, '2026-09-01');
  assert.equal(h[0].at, '2026-09-01T09:00:00Z');
});

test('saving a document several times a day is one edit', () => {
  reset();
  actions.recordAction({ kind: 'doc-edited', ref: 'voice', title: 'Brand voice' }, new Date('2026-09-01T09:00:00Z'));
  actions.recordAction({ kind: 'doc-edited', ref: 'voice', title: 'Brand voice' }, new Date('2026-09-01T11:00:00Z'));
  actions.recordAction({ kind: 'doc-edited', ref: 'voice', title: 'Brand voice' }, new Date('2026-09-02T11:00:00Z'));
  assert.equal(actions.listActions().length, 2);
});

test('pages published before actions existed are added once from the draft history', () => {
  reset();
  const d = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'Old post', body: 'x', meta: {} });
  q.moveDraft(d.id, 'approved', { target: 'wordpress' });
  q.moveDraft(d.id, 'published', { publishedUrl: 'https://a.com/old-post', dryRun: false });
  const dry = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'Dry', body: 'x', meta: {} });
  q.moveDraft(dry.id, 'approved', { target: 'wordpress' });
  q.moveDraft(dry.id, 'published', { publishedUrl: 'file:///x.html', dryRun: true });
  assert.deepEqual(actions.listActions().map((a) => a.title), ['Old post']);
  assert.equal(actions.listActions().length, 1, 'not added twice');
});

test('agents are told what was done, and nothing when nothing was', () => {
  reset();
  const text = () => agentSystem('role').map((b) => b.text).join('\n');
  assert.ok(!text().includes('<what-we-did>'));
  actions.recordAction({ kind: 'fix-done', ref: 'x', url: 'https://a.com/pricing', title: 'Missing meta description' });
  assert.match(text(), /<what-we-did>[\s\S]*Fixed "Missing meta description" on \/pricing/);
});
