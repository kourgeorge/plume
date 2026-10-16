require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
const { wordpress } = require('../src/publish/wordpress');
const { webflow } = require('../src/publish/webflow');

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
const draft = { id: 1, kind: 'blog_post', title: 'Hello', body: '', meta: { slug: 'hello', metaDescription: 'desc' } };

test('wordpress posts a draft with basic auth', async (t) => {
  let seen;
  const s = await server((req, body, res) => {
    seen = { url: req.url, auth: req.headers.authorization, body };
    res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 42, link: 'https://site/hello' }));
  });
  t.after(() => s.close());
  const env = { WP_URL: `http://127.0.0.1:${s.address().port}/`, WP_USER: 'me', WP_APP_PASSWORD: 'ab cd' };
  const r = await wordpress.publish(draft, '<p>x</p>', env);
  assert.deepEqual(r, { url: 'https://site/hello', externalId: '42', dryRun: false });
  assert.equal(seen.url, '/wp-json/wp/v2/posts');
  assert.equal(seen.auth, 'Basic ' + Buffer.from('me:abcd').toString('base64'));
  assert.equal(seen.body.status, 'draft');
  assert.equal(seen.body.slug, 'hello');
});

test('wordpress landing pages go to /pages; errors carry the message', async (t) => {
  const s = await server((req, body, res) => res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'bad password' })));
  t.after(() => s.close());
  const env = { WP_URL: `http://127.0.0.1:${s.address().port}`, WP_USER: 'me', WP_APP_PASSWORD: 'x' };
  await assert.rejects(wordpress.publish({ ...draft, kind: 'landing_page' }, '', env), /401: bad password/);
});

test('webflow creates a draft CMS item with configured fields', async (t) => {
  let seen;
  const s = await server((req, body, res) => {
    seen = { url: req.url, auth: req.headers.authorization, body };
    res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'item1' }));
  });
  t.after(() => s.close());
  const env = { WEBFLOW_API_URL: `http://127.0.0.1:${s.address().port}`, WEBFLOW_TOKEN: 'tok', WEBFLOW_COLLECTION_ID: 'c1', WEBFLOW_BODY_FIELD: 'content', WEBFLOW_SUMMARY_FIELD: 'summary', WEBFLOW_SITE_URL: 'https://acme.com' };
  const r = await webflow.publish(draft, '<p>x</p>', env);
  assert.equal(seen.url, '/v2/collections/c1/items');
  assert.equal(seen.auth, 'Bearer tok');
  assert.equal(seen.body.isDraft, true);
  assert.deepEqual(seen.body.fieldData, { name: 'Hello', slug: 'hello', content: '<p>x</p>', summary: 'desc' });
  assert.deepEqual(r, { url: 'https://acme.com/blog/hello', externalId: 'item1', dryRun: false });
});

test('configured() needs every key', () => {
  assert.equal(wordpress.configured({ WP_URL: 'x', WP_USER: 'y' }), false);
  assert.equal(webflow.configured({ WEBFLOW_TOKEN: 't', WEBFLOW_COLLECTION_ID: 'c' }), true);
});
