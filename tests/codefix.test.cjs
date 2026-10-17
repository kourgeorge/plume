require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// One fake server: GitHub under /gh, the AI gateway under /llm.
const plans = [];
const calls = [];
let repoFiles = {};
const sse = (text) =>
  [
    ['message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', {}],
  ]
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join('');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const json = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (u.pathname.startsWith('/llm/')) {
      calls.push({ method: req.method, path: 'llm', body: JSON.parse(body) });
      return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(JSON.stringify(plans.shift())));
    }
    calls.push({ method: req.method, path: u.pathname, body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
    const p = u.pathname.replace('/gh/repos/acme/site', '');
    if (req.method === 'GET' && p === '') return json(200, { default_branch: 'main', full_name: 'acme/site' });
    if (req.method === 'GET' && p === '/git/ref/heads/main') return json(200, { object: { sha: 'base-sha' } });
    if (req.method === 'GET' && p === '/git/trees/base-sha') return json(200, { tree: Object.keys(repoFiles).map((f) => ({ path: f, type: 'blob', size: repoFiles[f].length })) });
    if (req.method === 'GET' && p.startsWith('/contents/')) {
      const f = decodeURIComponent(p.slice('/contents/'.length));
      return repoFiles[f] === undefined ? json(404, { message: 'Not Found' }) : json(200, { sha: `sha-${f}`, content: Buffer.from(repoFiles[f]).toString('base64') });
    }
    if (req.method === 'POST' && p === '/git/refs') return json(201, {});
    if (req.method === 'PUT' && p.startsWith('/contents/')) return json(201, {});
    if (req.method === 'POST' && p === '/pulls') return json(201, { html_url: 'https://github.com/acme/site/pull/7', number: 7 });
    json(404, { message: `no route ${req.method} ${p}` });
  });
});

let cf;
const ENV = () => ({ GITHUB_TOKEN: 'ghp_test', GITHUB_REPO: 'acme/site', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}/gh` });
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-codefix-'));
  process.env.PLUME_SITE = 'test.example';
  process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}/llm`;
  process.env.LLM_API_KEY = 'k';
  cf = require('../src/geo/codefix');
  resolve();
})));
test.after(() => server.close());

const issue = (o) => ({ id: 'missing-meta-description:https://acme.example/pricing', check: 'missing-meta-description', severity: 'high', area: 'on-page', url: 'https://acme.example/pricing', title: 'Missing meta description', why: 'Google shows a random sentence.', steps: ['Add a meta description.'], ...o });

const TREE = (paths) => paths.map((p) => ({ path: p, size: 500 }));

test('picks the page file for a page fix, the layout first for a site-wide fix, robots.txt for crawler fixes', () => {
  const tree = TREE(['src/pages/pricing.astro', 'src/pages/index.astro', 'src/layouts/Base.astro', 'node_modules/x/pricing.js', 'public/robots.txt', 'README.md']);
  assert.deepEqual(cf.candidateFiles({ check: 'missing-title', url: 'https://acme.example/pricing' }, tree), ['src/pages/pricing.astro', 'src/layouts/Base.astro']);
  assert.deepEqual(cf.candidateFiles({ check: 'missing-identity-schema', url: 'https://acme.example/' }, tree), ['src/layouts/Base.astro', 'src/pages/index.astro']);
  assert.deepEqual(cf.candidateFiles({ check: 'ai-crawlers-blocked', url: 'https://acme.example/' }, tree), ['public/robots.txt']);
  assert.ok(!cf.candidateFiles({ check: 'missing-title', url: 'https://acme.example/pricing' }, tree).some((f) => f.includes('node_modules')));
});

test('edits apply only when the text to find appears exactly once', () => {
  const files = { 'a.html': '<head>\n<title>A</title>\n</head>\n<p>x</p><p>x</p>' };
  const ok = cf.applyEdits(files, [{ path: 'a.html', find: '</head>', replace: '<meta name="description" content="d">\n</head>' }]);
  assert.equal(ok.ok, true);
  assert.match(ok.files['a.html'], /<meta name="description" content="d">\n<\/head>/);
  assert.match(cf.applyEdits(files, [{ path: 'a.html', find: '<p>x</p>', replace: 'y' }]).problem, /appears 2 times/);
  assert.match(cf.applyEdits(files, [{ path: 'b.html', find: 'x', replace: 'y' }]).problem, /not one of the files you were shown/);
  // "$&" in the new text must be kept literally, not treated as a pattern.
  assert.match(cf.applyEdits(files, [{ path: 'a.html', find: '<title>A</title>', replace: '<title>Price $& more</title>' }]).files['a.html'], /Price \$& more/);
});

test('new files: only robots.txt, sitemap.xml or llms.txt, never code that runs', () => {
  const tree = TREE(['public/robots.txt']);
  assert.equal(cf.checkNewFiles([{ path: 'public/llms.txt', content: '# A' }], tree), null);
  assert.match(cf.checkNewFiles([{ path: '.github/workflows/x.yml', content: 'on: push' }], tree), /can only create robots.txt, sitemap.xml or llms.txt/);
  assert.match(cf.checkNewFiles([{ path: 'public/robots.txt', content: 'x' }], tree), /already exists/);
});

test('opens a pull request on a new branch with the change; a bad first attempt gets one correction', async () => {
  repoFiles = { 'src/pages/pricing.html': '<html><head>\n<title>Pricing</title>\n</head><body>Plans</body></html>', 'README.md': '# Site' };
  plans.push(
    { can_fix: true, reason: '', summary: 'Adds a description.', edits: [{ path: 'src/pages/pricing.html', find: '<head>', replace: '<head><meta>' }, { path: 'src/pages/pricing.html', find: 'nowhere', replace: 'x' }], new_files: [] },
    { can_fix: true, reason: '', summary: 'Adds a meta description to the pricing page.', edits: [{ path: 'src/pages/pricing.html', find: '<title>Pricing</title>', replace: '<title>Pricing</title>\n<meta name="description" content="Plans from $49.">' }], new_files: [] },
  );
  const r = await cf.openFixPullRequest(issue(), () => {}, ENV());
  assert.equal(r.prUrl, 'https://github.com/acme/site/pull/7');
  const llm = calls.filter((c) => c.path === 'llm');
  assert.match(llm[1].body.messages[0].content, /could not be applied: the "find" text for src\/pages\/pricing\.html appears 0 times/);
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/gh/repos/acme/site/contents/src/pages/pricing.html');
  assert.match(Buffer.from(put.body.content, 'base64').toString(), /<meta name="description" content="Plans from \$49.">/);
  assert.equal(put.body.sha, 'sha-src/pages/pricing.html', 'updates must name the file version they replace');
  assert.match(put.body.branch, /^plume\/fix-missing-meta-description-/);
  const pr = calls.find((c) => c.path.endsWith('/pulls'));
  assert.equal(pr.body.base, 'main');
  assert.match(pr.body.body, /Plume never merges/);
  assert.ok(!calls.some((c) => /merge/.test(c.path)), 'Plume must never merge');
  assert.equal(cf.lastFix(issue().id).status, 'opened');
});

test('a site-builder site, or content that is not in the repo, is reported instead of guessed', async () => {
  require('../src/research/techSignals').saveTechSignals([{ name: 'Wix', kind: 'builder', seenOn: 'https://acme.example/' }]);
  repoFiles = { 'README.md': '# notes' };
  const r = await cf.openFixPullRequest(issue({ url: 'https://acme.example/about', check: 'missing-title' }), () => {}, ENV());
  assert.equal(r.prUrl, null);
  assert.match(r.message, /built with Wix[\s\S]*Make the fix in Wix's editor/);
  repoFiles = { 'src/pages/pricing.html': '<html></html>' };
  plans.push({ can_fix: false, reason: 'the page text comes from the CMS, not this file', summary: '', edits: [], new_files: [] });
  const r2 = await cf.openFixPullRequest(issue(), () => {}, ENV());
  assert.match(r2.message, /Not fixed in code: the page text comes from the CMS/);
  assert.equal(cf.lastFix(issue().id).status, 'not-fixable');
});

test('without a GitHub connection it says how to connect', async () => {
  await assert.rejects(cf.openFixPullRequest(issue(), () => {}, {}), /connect GitHub for this website under Settings/);
});
