require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-int-'));
delete process.env.PLUME_SITE;
const { withSite } = require('../src/site');
const ints = require('../src/integrations');
const { sanity, toBlocks } = require('../src/publish/sanity');
const { hubspot } = require('../src/publish/hubspot');
const { github } = require('../src/publish/github');

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, body ? JSON.parse(body) : null, res));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
const draft = { id: 7, kind: 'blog_post', title: 'Hello', body: '# Hello\n\nFirst para.\n\n## Part\n\nSecond.', meta: { slug: 'hello', metaDescription: 'desc' } };

test('settings are per site, secrets are never shown, and they override .env', () => {
  withSite('a.example', () => {
    ints.saveIntegration('hubspot', { token: 'pat-secret-1234', blog: '99' });
    const d = ints.describeIntegrations().find((i) => i.id === 'hubspot');
    assert.equal(d.connected, true);
    assert.equal(JSON.stringify(d).includes('pat-secret'), false);
    assert.equal(d.fields.find((f) => f.key === 'token').hint, '1234');
    assert.equal(ints.siteEnv({ HUBSPOT_BLOG_ID: 'env' }).HUBSPOT_BLOG_ID, '99');
    // blank secret keeps the saved one
    ints.saveIntegration('hubspot', { token: '', blog: '100' });
    assert.equal(ints.siteEnv({}).HUBSPOT_TOKEN, 'pat-secret-1234');
  });
  withSite('b.example', () => {
    assert.equal(ints.describeIntegrations().find((i) => i.id === 'hubspot').connected, false);
    assert.equal(ints.siteEnv({}).HUBSPOT_TOKEN, undefined);
  });
  withSite('a.example', () => {
    ints.removeIntegration('hubspot');
    assert.equal(ints.siteEnv({}).HUBSPOT_TOKEN, undefined);
  });
});

test('saving checks required fields and formats', () => {
  withSite('c.example', () => {
    assert.throws(() => ints.saveIntegration('wordpress', { url: 'https://x.com' }), /still needed/);
    assert.throws(() => ints.saveIntegration('wordpress', { url: 'x.com', user: 'u', password: 'p' }), /https:\/\//);
    assert.throws(() => ints.saveIntegration('github', { repo: 'nope', token: 't' }), /owner\/name/);
    assert.throws(() => ints.saveIntegration('nope', {}), /unknown/);
  });
});

test('sanity creates a draft document with portable text', async (t) => {
  let seen;
  const s = await server((req, body, res) => ((seen = { url: req.url, auth: req.headers.authorization, body }), json(res, 200, { results: [{ id: 'drafts.x' }] })));
  t.after(() => s.close());
  const env = { SANITY_API_URL: `http://127.0.0.1:${s.address().port}`, SANITY_PROJECT_ID: 'p', SANITY_DATASET: 'production', SANITY_TOKEN: 'tok' };
  const r = await sanity.publish(draft, '', env);
  assert.equal(seen.url, '/v2021-06-07/data/mutate/production');
  assert.equal(seen.auth, 'Bearer tok');
  const doc = seen.body.mutations[0].create;
  assert.match(doc._id, /^drafts\./);
  assert.equal(doc.slug.current, 'hello');
  assert.deepEqual(doc.body.map((b) => b.style), ['normal', 'h2', 'normal']);
  assert.equal(r.externalId, 'drafts.x');
  assert.equal(toBlocks('').length, 0);
});

test('hubspot creates a DRAFT post in the chosen blog', async (t) => {
  let seen;
  const s = await server((req, body, res) => ((seen = { url: req.url, body }), json(res, 201, { id: 5, url: 'https://blog/hello' })));
  t.after(() => s.close());
  const r = await hubspot.publish(draft, '<p>x</p>', { HUBSPOT_API_URL: `http://127.0.0.1:${s.address().port}`, HUBSPOT_TOKEN: 't', HUBSPOT_BLOG_ID: '99' });
  assert.equal(seen.url, '/cms/v3/blogs/posts');
  assert.equal(seen.body.state, 'DRAFT');
  assert.equal(seen.body.contentGroupId, '99');
  assert.deepEqual(r, { url: 'https://blog/hello', externalId: '5', dryRun: false });
});

test('github branches, commits the file and opens a pull request', async (t) => {
  const calls = [];
  const s = await server((req, body, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/repos/o/r') return json(res, 200, { default_branch: 'main' });
    if (req.url.endsWith('/git/ref/heads/main')) return json(res, 200, { object: { sha: 'abc' } });
    if (req.url.endsWith('/git/refs')) return json(res, 201, {});
    if (req.method === 'PUT') {
      assert.match(Buffer.from(body.content, 'base64').toString(), /^---\ntitle: "Hello"/);
      assert.equal(body.content && Buffer.from(body.content, 'base64').toString().includes('# Hello'), false);
      return json(res, 201, {});
    }
    return json(res, 201, { number: 3, html_url: 'https://github.com/o/r/pull/3' });
  });
  t.after(() => s.close());
  const r = await github.publish(draft, '', { GITHUB_API_URL: `http://127.0.0.1:${s.address().port}`, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' });
  assert.deepEqual(r, { url: 'https://github.com/o/r/pull/3', externalId: '3', dryRun: false });
  assert.match(calls.at(-2), /^PUT \/repos\/o\/r\/contents\/content\/blog\/hello\.md/);
});

test('test-connection reports a bad token plainly', async (t) => {
  const s = await server((req, body, res) => json(res, 401, { message: 'Bad credentials' }));
  t.after(() => s.close());
  const r = await ints.testIntegration('github', { GITHUB_API_URL: `http://127.0.0.1:${s.address().port}`, GITHUB_TOKEN: 'x', GITHUB_REPO: 'o/r' });
  assert.equal(r.ok, false);
  assert.match(r.message, /refused the access token/);
});

test('saving a GitHub address keeps just owner/name', () => {
  withSite('gh.example', () => {
    ints.saveIntegration('github', { repo: 'https://github.com/Acme/site.git', token: 't' });
    assert.equal(ints.siteEnv({}).GITHUB_REPO, 'Acme/site');
    assert.ok(ints.describeIntegrations().find((i) => i.id === 'github').link.url.includes('pull_requests=write'));
  });
});

test('publishing an article again replaces the file instead of failing', async (t) => {
  let put;
  const s = await server((req, body, res) => {
    if (req.method === 'GET' && req.url === '/repos/o/r') return json(res, 200, { default_branch: 'main' });
    if (req.url.endsWith('/git/ref/heads/main')) return json(res, 200, { object: { sha: 'abc' } });
    if (req.method === 'GET' && req.url.includes('/contents/')) return json(res, 200, { sha: 'old-sha' });
    if (req.method === 'PUT') return ((put = body), json(res, 200, {}));
    if (req.url.endsWith('/git/refs')) return json(res, 201, {});
    return json(res, 201, { number: 4, html_url: 'https://github.com/o/r/pull/4' });
  });
  t.after(() => s.close());
  await github.publish(draft, '', { GITHUB_API_URL: `http://127.0.0.1:${s.address().port}`, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' });
  assert.equal(put.sha, 'old-sha');
});

test('a failed pull request deletes the branch it made', async (t) => {
  const calls = [];
  const s = await server((req, body, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/repos/o/r') return json(res, 200, { default_branch: 'main' });
    if (req.url.endsWith('/git/ref/heads/main')) return json(res, 200, { object: { sha: 'abc' } });
    if (req.method === 'GET' && req.url.includes('/contents/')) return json(res, 404, { message: 'Not Found' });
    if (req.url.endsWith('/git/refs')) return json(res, 201, {});
    if (req.method === 'PUT') return json(res, 201, {});
    if (req.method === 'DELETE') return json(res, 204, {});
    return json(res, 403, { message: 'Resource not accessible by personal access token' });
  });
  t.after(() => s.close());
  await assert.rejects(github.publish(draft, '', { GITHUB_API_URL: `http://127.0.0.1:${s.address().port}`, GITHUB_TOKEN: 't', GITHUB_REPO: 'o/r' }), /can't open pull requests/);
  assert.match(calls.at(-1), /^DELETE \/repos\/o\/r\/git\/refs\/heads\/plume\/hello-/);
});

test('test-connection catches a read-only token and a missing base branch', async (t) => {
  let perms = { push: false };
  const s = await server((req, body, res) => {
    if (req.url === '/repos/o/r') return json(res, 200, { full_name: 'o/r', default_branch: 'main', permissions: perms });
    return json(res, 404, { message: 'Not Found' });
  });
  t.after(() => s.close());
  const env = { GITHUB_API_URL: `http://127.0.0.1:${s.address().port}`, GITHUB_TOKEN: 'x', GITHUB_REPO: 'o/r' };
  assert.match((await ints.testIntegration('github', env)).message, /can only read it/);
  perms = { push: true };
  const r = await ints.testIntegration('github', { ...env, GITHUB_BRANCH: 'live' });
  assert.equal(r.ok, false);
  assert.match(r.message, /no branch called "live"/);
});
