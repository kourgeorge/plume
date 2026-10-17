require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-wix-'));
process.env.PLUME_SITE = 'test.example';
const wix = require('../src/publish/wix');
const publish = require('../src/publish');
const integrations = require('../src/integrations');
const q = require('../src/queue');
const runner = require('../src/publish/runner');
require('../src/db').getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://acme.example', 'Acme', 'now')`).run();

const calls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = body ? JSON.parse(body) : {};
    calls.push({ url: req.url, headers: req.headers, body: b });
    const json = (s, d) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(d));
    if (req.headers.authorization !== 'KEY') return json(403, { message: 'Forbidden' });
    if (req.url === '/members/v1/members/query') return json(200, { members: [{ id: 'mem-1', profile: { nickname: 'Dana' } }, { id: 'mem-2', loginEmail: 'ops@acme.example' }] });
    if (req.url === '/blog/v3/draft-posts') return json(200, { draftPost: { id: 'post-9', url: { base: 'https://acme.example', path: '/post/widgets' } } });
    json(404, { message: 'no route' });
  });
});
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => ((wix.WIX_API.base = `http://127.0.0.1:${server.address().port}`), r()))));
test.after(() => server.close());
const ENV = { WIX_API_KEY: 'KEY', WIX_SITE_ID: 'site-1', WIX_MEMBER_ID: 'mem-1' };

test('Markdown becomes a Wix rich-content document', () => {
  const doc = wix.toRicos('## Why\n\nWe make **modular** kits, *small* & [good](https://acme.example/kits).\n\n- one\n- two\n\n1. first\n\n> quoted\n\n```\ncode\n```\n\n---\n\n[bad](javascript:alert(1))');
  const types = doc.nodes.map((n) => n.type);
  assert.deepEqual(types, ['HEADING', 'PARAGRAPH', 'BULLETED_LIST', 'ORDERED_LIST', 'BLOCKQUOTE', 'CODE_BLOCK', 'DIVIDER', 'PARAGRAPH']);
  assert.equal(doc.nodes[0].headingData.level, 2);
  const p = doc.nodes[1].nodes;
  assert.equal(p.map((x) => x.textData.text).join(''), 'We make modular kits, small & good.');
  assert.deepEqual(p.find((x) => x.textData.text === 'modular').textData.decorations, [{ type: 'BOLD', fontWeightValue: 700 }]);
  assert.equal(p.find((x) => x.textData.text === 'good').textData.decorations[0].linkData.link.url, 'https://acme.example/kits');
  assert.deepEqual(doc.nodes[2].nodes.map((li) => li.nodes[0].nodes[0].textData.text), ['one', 'two']);
  assert.equal(doc.nodes[7].nodes[0].textData.decorations.length, 0, 'a javascript: link is kept as plain text');
  assert.ok(new Set(doc.nodes.map((n) => n.id)).size === doc.nodes.length, 'every block has its own id');
});

test('publishing creates a Wix draft with title, slug, description and author', async () => {
  const d = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'Best widgets', body: '# Best widgets\n\nIntro.', meta: { slug: 'best-widgets', metaDescription: 'The best desk widgets.' } });
  const r = await wix.wix.publish(d, '', ENV);
  const c = calls.at(-1);
  assert.equal(c.headers.authorization, 'KEY');
  assert.equal(c.headers['wix-site-id'], 'site-1');
  assert.equal(c.body.publish, false, 'drafts unless asked to publish live');
  assert.equal(c.body.draftPost.memberId, 'mem-1');
  assert.equal(c.body.draftPost.seoSlug, 'best-widgets');
  assert.equal(c.body.draftPost.excerpt, 'The best desk widgets.');
  assert.equal(c.body.draftPost.richContent.nodes[0].type, 'PARAGRAPH', 'the "# title" line is not repeated in the body');
  assert.deepEqual(r, { url: null, externalId: 'post-9', dryRun: false });
  const liveR = await wix.wix.publish(d, '', { ...ENV, WIX_LIVE: '1' });
  assert.equal(calls.at(-1).body.publish, true);
  assert.equal(liveR.url, 'https://acme.example/post/widgets');
});

test('Test lists the members to pick an author from, and checks a saved one', async () => {
  assert.match((await wix.testWix({ WIX_API_KEY: 'KEY', WIX_SITE_ID: 'site-1' })).message, /Dana — mem-1; ops@acme\.example — mem-2/);
  assert.match((await wix.testWix(ENV)).message, /Posts will be by Dana, saved as drafts/);
  assert.match((await wix.testWix({ ...ENV, WIX_MEMBER_ID: 'nobody' })).message, /isn't a member of this site/);
  assert.match((await wix.testWix({ ...ENV, WIX_API_KEY: 'wrong' })).message, /Wix refused the key \(403\)/);
});

test('Wix counts as connected only once the author is chosen; Test works before that', () => {
  integrations.saveIntegration('wix', { key: 'KEY', site: 'site-1' });
  let card = integrations.describeIntegrations().find((i) => i.id === 'wix');
  assert.deepEqual([card.connected, card.testable], [false, true]);
  assert.equal(publish.getPublisher('wix').configured(integrations.siteEnv({})), false);
  integrations.saveIntegration('wix', { member: 'mem-1' });
  card = integrations.describeIntegrations().find((i) => i.id === 'wix');
  assert.equal(card.connected, true);
  assert.equal(publish.getPublisher('wix').configured(integrations.siteEnv({})), true);
});

test('Wix takes articles, never social posts; a failure is kept with the reason', async () => {
  assert.ok(publish.targetsFor('blog_post').includes('wix'));
  assert.ok(!publish.targetsFor('x_post').includes('wix'));
  const d = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'T', body: 'x', meta: {} });
  q.moveDraft(d.id, 'approved', { target: 'wix' });
  const after = await runner.publishOne(d.id, { ...ENV, WIX_API_KEY: 'wrong' });
  assert.equal(after.status, 'failed');
  assert.match(after.error, /Wix refused the key/);
});
