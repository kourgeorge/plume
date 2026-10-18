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
let livePages = {};   // what the live site serves, by path
let prState = { state: 'open', merged_at: null };
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
    if (u.pathname.startsWith('/live/')) {
      const page = livePages[u.pathname.slice('/live'.length)];
      return page === undefined ? res.writeHead(404, { 'content-type': 'text/html' }).end('<html><body>not found</body></html>') : res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    }
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
    if (req.method === 'GET' && p === '/pulls/7') return json(200, { number: 7, ...prState });
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

// The live site: https://acme.example/x is answered by the fake server's /live/x.
const LIVE = { fetchFn: (url, init) => fetch(`http://127.0.0.1:${server.address().port}/live${new URL(url).pathname}`, init) };
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
  const r = await cf.openFixPullRequest(issue(), () => {}, ENV(), LIVE);
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
  const r = await cf.openFixPullRequest(issue({ url: 'https://acme.example/about', check: 'missing-title' }), () => {}, ENV(), LIVE);
  assert.equal(r.prUrl, null);
  assert.match(r.message, /built with Wix[\s\S]*Make the fix in Wix's editor/);
  repoFiles = { 'src/pages/pricing.html': '<html></html>' };
  plans.push({ can_fix: false, reason: 'the page text comes from the CMS, not this file', summary: '', edits: [], new_files: [] });
  const r2 = await cf.openFixPullRequest(issue(), () => {}, ENV(), LIVE);
  assert.match(r2.message, /Not fixed in code: the page text comes from the CMS/);
  assert.equal(cf.lastFix(issue().id).status, 'not-fixable');
});

test('without a GitHub connection it says how to connect', async () => {
  await assert.rejects(cf.openFixPullRequest(issue(), () => {}, {}, LIVE), /connect GitHub for this website under Settings/);
});

test('finds the page by its text, even when the file name does not match the address', () => {
  const live = '<html lang="ar"><head><title>ملفات الارتباط وتخزين المتصفح — Dsim</title></head><body><h1>ملفات الارتباط وتخزين المتصفح</h1><p>نستخدم التخزين المحلي في المتصفح لحفظ تفضيلاتك فقط، ولا نشاركها مع أي جهة أخرى أبداً.</p></body></html>';
  const prints = cf.fingerprints(live);
  assert.equal(prints[0].label, 'the page title');
  const right = '<html lang="ar"><head>\n<title>ملفات الارتباط وتخزين المتصفح — Dsim</title>\n</head><body><h1>ملفات الارتباط وتخزين المتصفح</h1></body></html>';
  const wrong = '<html><head><title>Dsim — Home</title></head></html>';
  assert.ok(cf.matchScore(right, prints).score >= 3);
  assert.equal(cf.matchScore(wrong, prints).score, 0);
  // "&amp;" in the file and "&" on the page are the same text.
  assert.equal(cf.matchScore('<title>Terms &amp; privacy for everyone</title>', cf.fingerprints('<title>Terms & privacy for everyone</title>')).score, 2);
  // Files in folders named like the address are searched first.
  const order = cf.searchOrder('https://d-sim.net/legal/ar/storage.html', TREE(['index.html', 'blog/post.html', 'site/legal/ar/cookies-storage.html', 'site/legal/ar/terms.html']));
  assert.match(order[0], /^site\/legal\/ar\//);
});

test('prepares the change first: shows the file and the lines, opens nothing until told to', async () => {
  calls.length = 0;
  const html = '<html lang="ar"><head>\n<title>ملفات الارتباط وتخزين المتصفح — Dsim</title>\n</head><body><h1>ملفات الارتباط وتخزين المتصفح</h1></body></html>';
  repoFiles = { 'site/legal/ar/cookies-storage.html': html, 'site/legal/ar/terms.html': '<html><head><title>الشروط — Dsim</title></head></html>', 'site/base.html': '<head></head>' };
  livePages = { '/legal/ar/storage.html': html };
  const it = issue({ id: 'missing-meta-description:https://acme.example/legal/ar/storage.html', url: 'https://acme.example/legal/ar/storage.html' });
  require('../src/db').setSetting('pinnedIssues', [it]);
  plans.push({ can_fix: true, reason: '', summary: 'Adds an Arabic meta description.', edits: [{ path: 'site/legal/ar/cookies-storage.html', find: '<title>ملفات الارتباط وتخزين المتصفح — Dsim</title>', replace: '<title>ملفات الارتباط وتخزين المتصفح — Dsim</title>\n<meta name="description" content="وصف">' }], new_files: [] });
  const r = await cf.prepareFix(it, () => {}, ENV(), LIVE);
  assert.equal(r.proposal.source.path, 'site/legal/ar/cookies-storage.html');
  assert.equal(r.proposal.source.how, 'text');
  assert.match(r.proposal.source.evidence, /the page title/);
  assert.ok(r.proposal.files[0].diff.some((l) => l.t === 'add' && /meta name="description"/.test(l.line)));
  const prompt = calls.find((c) => c.path === 'llm').body.messages[0].content;
  assert.match(prompt, /The page is in "ar"/);
  assert.ok(!calls.some((c) => c.method !== 'GET' && c.path !== 'llm'), 'preparing must not change anything on GitHub');
  assert.equal(cf.lastFix(it.id).status, 'proposed');
  assert.ok(!('changes' in cf.lastFix(it.id).proposal), 'the page gets the preview, not the stored file contents');

  // The owner says yes: exactly that change goes out.
  const opened = await cf.openProposedFix(it.id, ENV());
  assert.equal(opened.prUrl, 'https://github.com/acme/site/pull/7');
  const put = calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/gh/repos/acme/site/contents/site/legal/ar/cookies-storage.html');
  assert.match(calls.find((c) => c.path.endsWith('/pulls')).body.body, /Why this file:.*cookies-storage\.html/);
  await assert.rejects(cf.openProposedFix(it.id, ENV()), /no prepared change/);

  // Next time the same page is looked up, the file found before is reused.
  plans.push({ can_fix: false, reason: 'nothing to do', summary: '', edits: [], new_files: [] });
  await cf.prepareFix(it, () => {}, ENV(), LIVE);
  assert.match(calls.filter((c) => c.path === 'llm').pop().body.messages[0].content, /found by matching the page text on an earlier fix/);
});

test('cancelling a prepared change drops it', async () => {
  repoFiles = { 'src/pages/pricing.html': '<html><head>\n<title>Pricing</title>\n</head></html>' };
  livePages = { '/pricing': repoFiles['src/pages/pricing.html'] };
  require('../src/db').setSetting('pinnedIssues', [issue()]);
  plans.push({ can_fix: true, reason: '', summary: 'x', edits: [{ path: 'src/pages/pricing.html', find: '<title>Pricing</title>', replace: '<title>Pricing</title><meta name="description" content="d">' }], new_files: [] });
  await cf.prepareFix(issue(), () => {}, ENV(), LIVE);
  cf.cancelProposedFix(issue().id);
  assert.equal(cf.lastFix(issue().id).status, 'cancelled');
  await assert.rejects(cf.openProposedFix(issue().id, ENV()), /no prepared change/);
});

test('after the merge: re-reads the live page and marks the fix done only once the problem is gone', async () => {
  const it = issue();
  require('../src/db').setSetting('pinnedIssues', [it]);
  repoFiles = { 'src/pages/pricing.html': '<html><head>\n<title>Pricing plans for teams</title>\n</head><body><h1>Pricing</h1></body></html>' };
  livePages = { '/pricing': repoFiles['src/pages/pricing.html'] };
  plans.push({ can_fix: true, reason: '', summary: 'Adds a description.', edits: [{ path: 'src/pages/pricing.html', find: '<title>Pricing plans for teams</title>', replace: '<title>Pricing plans for teams</title>\n<meta name="description" content="Plans from $49 a month for small teams.">' }], new_files: [] });
  await cf.openFixPullRequest(it, () => {}, ENV(), LIVE);

  prState = { state: 'open', merged_at: null };
  await cf.followUpFixes(ENV(), LIVE.fetchFn);
  assert.equal(cf.lastFix(it.id).status, 'opened', 'nothing happens while the pull request is open');

  // Merged, but the site hasn't rebuilt yet: keep waiting.
  prState = { state: 'closed', merged_at: new Date().toISOString() };
  await cf.followUpFixes(ENV(), LIVE.fetchFn);
  assert.equal(cf.lastFix(it.id).status, 'merged');
  assert.match(cf.lastFix(it.id).message, /Waiting for the live site/);

  // The live page now has the description: confirmed, and taken off today's fixes.
  livePages['/pricing'] = '<html><head><title>Pricing plans for teams</title><meta name="description" content="Plans from $49 a month for small teams."></head><body><h1>Pricing</h1></body></html>';
  const r = await cf.followUpFixes(ENV(), LIVE.fetchFn);
  assert.deepEqual(r.verified, [it.id]);
  assert.equal(cf.lastFix(it.id).status, 'verified');
  assert.ok(!require('../src/agents/seoAudit').pinnedIssues().some((i) => i.id === it.id));
  assert.equal((await cf.followUpFixes(ENV(), LIVE.fetchFn)).checked, 0, 'a confirmed fix is not checked again');
});

test('a pull request closed without merging is reported, not checked forever', async () => {
  const it = issue({ id: 'missing-h1:https://acme.example/pricing', check: 'missing-h1', title: 'No main heading (H1)' });
  require('../src/db').setSetting('pinnedIssues', [it]);
  repoFiles = { 'src/pages/pricing.html': '<html><head><title>Pricing</title></head><body><p>x</p></body></html>' };
  livePages = { '/pricing': repoFiles['src/pages/pricing.html'] };
  plans.push({ can_fix: true, reason: '', summary: 'Adds a heading.', edits: [{ path: 'src/pages/pricing.html', find: '<body>', replace: '<body><h1>Pricing</h1>' }], new_files: [] });
  await cf.openFixPullRequest(it, () => {}, ENV(), LIVE);
  prState = { state: 'closed', merged_at: null };
  const r = await cf.followUpFixes(ENV(), LIVE.fetchFn);
  assert.equal(r.closed, 1);
  assert.equal(cf.lastFix(it.id).status, 'closed');
});
