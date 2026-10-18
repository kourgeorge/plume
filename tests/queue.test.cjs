require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const q = require('../src/queue');
const { publishOne, publishDue } = require('../src/publish/runner');
const { siteDir } = require('../src/site');

const mk = (keyword = 'widgets') => q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'T', body: '# T\n\nHello', meta: { slug: 't', keyword } });

test('state machine allows only sensible moves', () => {
  const d = mk();
  assert.throws(() => q.moveDraft(d.id, 'published'), /cannot move a draft/);
  q.moveDraft(d.id, 'rejected');
  q.moveDraft(d.id, 'draft');
  assert.equal(q.getDraft(d.id).status, 'draft');
  assert.deepEqual(q.draftEvents(d.id).map((e) => e.to_status), ['draft', 'rejected', 'draft']);
});

test('edits keep the original text for learning', () => {
  const d = mk();
  const e = q.editDraft(d.id, { body: 'Better', meta: { metaDescription: 'm' } });
  assert.equal(e.body, 'Better');
  assert.equal(e.originalBody, '# T\n\nHello');
  assert.equal(e.meta.slug, 't');
  assert.equal(e.meta.metaDescription, 'm');
});

test('approve with no keys = dry run, files saved, marked published', async () => {
  const d = mk();
  q.moveDraft(d.id, 'approved', { target: 'wordpress' });
  const p = await publishOne(d.id, {});
  assert.equal(p.status, 'published');
  assert.equal(p.dryRun, true);
  assert.equal(p.publishedUrl, null, 'saved files are downloaded from the draft page, not opened by address');
  const dir = path.join(siteDir(), 'exports');
  const html = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(`${d.id}-`) && f.endsWith('.html'))), 'utf8');
  assert.match(html, /<p>Hello<\/p>/);
  assert.equal((html.match(/<h1>T<\/h1>/g) || []).length, 1, 'title should not be repeated in the body');
  assert.throws(() => q.editDraft(d.id, { body: 'x' }), /already published/);
});

test('publisher error lands as failed with the reason, and can be retried', async () => {
  const d = mk();
  q.moveDraft(d.id, 'approved', { target: 'wordpress' });
  const p = await publishOne(d.id, { WP_URL: 'http://127.0.0.1:1', WP_USER: 'u', WP_APP_PASSWORD: 'p' });
  assert.equal(p.status, 'failed');
  assert.ok(p.error);
  assert.equal(q.moveDraft(d.id, 'approved').error, null);
});

test('scheduled drafts wait for their time', async () => {
  const d = mk();
  q.moveDraft(d.id, 'approved', { target: 'export', scheduledFor: new Date(Date.now() + 3600e3).toISOString() });
  assert.ok(!q.dueDrafts().some((x) => x.id === d.id));
  assert.ok(q.dueDrafts(new Date(Date.now() + 7200e3)).some((x) => x.id === d.id));
  await publishDue({});
  assert.equal(q.getDraft(d.id).status, 'approved');
});

test('usedKeywords ignores rejected drafts', () => {
  const a = mk('alpha');
  const b = mk('beta');
  q.moveDraft(b.id, 'rejected');
  const used = q.usedKeywords();
  assert.ok(used.has('alpha'));
  assert.ok(!used.has('beta'));
});
