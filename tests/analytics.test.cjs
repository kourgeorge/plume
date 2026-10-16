require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
const g = require('../src/analytics/google');
const pull = require('../src/analytics/pull');
const results = require('../src/analytics/results');
const q = require('../src/queue');
const { setSetting } = require('../src/db');
const { agentSystem } = require('../src/context/profile');

const env = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec' };
const calls = [];
let tokenCount = 0;

// One fake server plays every Google endpoint.
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (code, obj) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
    if (req.url === '/token') {
      tokenCount++;
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') return json(200, { access_token: 'a1', refresh_token: 'r1', expires_in: -100 });
      return json(200, { access_token: `a${tokenCount}`, expires_in: 3600 });
    }
    if (req.url === '/gsc/sites') return json(200, { siteEntry: [{ siteUrl: 'sc-domain:acme.com', permissionLevel: 'siteOwner' }, { siteUrl: 'https://x.com/', permissionLevel: 'siteUnverifiedUser' }] });
    if (req.url.startsWith('/gsc/sites/sc-domain%3Aacme.com/searchAnalytics/query'))
      return json(200, { rows: [
        { keys: ['widget pricing', 'https://acme.com/pricing'], clicks: 30, impressions: 600, ctr: 0.05, position: 4 },
        { keys: ['best widgets', 'https://acme.com/blog/best-widgets/'], clicks: 2, impressions: 400, ctr: 0.005, position: 14 },
        { keys: ['best widgets 2026', 'https://www.acme.com/blog/best-widgets'], clicks: 1, impressions: 100, ctr: 0.01, position: 18 },
      ] });
    if (req.url.startsWith('/admin/accountSummaries')) return json(200, { accountSummaries: [{ propertySummaries: [{ property: 'properties/123', displayName: 'Acme' }] }] });
    if (req.url === '/data/properties/123:runReport')
      return json(200, { rows: [
        { dimensionValues: [{ value: '/pricing' }], metricValues: [{ value: '900' }, { value: '700' }, { value: '0.61' }, { value: '45' }] },
        { dimensionValues: [{ value: '/blog/best-widgets' }], metricValues: [{ value: '120' }, { value: '100' }, { value: '0.4' }, { value: '80' }] },
      ] });
    json(404, { error: { message: `no route ${req.url}` } });
  });
});

test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => {
  const b = `http://127.0.0.1:${server.address().port}`;
  Object.assign(g.GOOGLE, { auth: `${b}/auth`, token: `${b}/token`, gsc: `${b}/gsc`, gaAdmin: `${b}/admin`, gaData: `${b}/data` });
  r();
})));
test.after(() => server.close());

test('sign-in URL is read-only, offline, PKCE; callback must match state', async () => {
  const url = new URL(g.authUrl('http://127.0.0.1:4410/api/google/callback', env));
  assert.equal(url.searchParams.get('scope'), g.SCOPES.join(' '));
  assert.ok(g.SCOPES.every((s) => s.endsWith('.readonly')));
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await assert.rejects(g.finishAuth('code', 'wrong-state', env), /expired or did not start here/);
  assert.equal(g.googleConnected(), false);
});

test('finishAuth saves tokens privately; expired token is refreshed', async () => {
  const url = new URL(g.authUrl('http://127.0.0.1:4410/api/google/callback', env));
  await g.finishAuth('the-code', url.searchParams.get('state'), env);
  const file = path.join(process.env.DATA_DIR, 'tokens', 'google.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const exchange = new URLSearchParams(calls.find((c) => c.url === '/token').body);
  assert.ok(exchange.get('code_verifier'), 'PKCE verifier missing');
  const before = tokenCount;
  const tok = await g.accessToken(env); // saved token was already expired
  assert.equal(tokenCount, before + 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refresh_token, 'r1', 'refresh token lost after refresh');
  assert.equal(await g.accessToken(env), tok, 'fresh token should be reused');
});

test('site discovery skips unverified sites and matches the domain property', async () => {
  const sites = await pull.listSearchConsoleSites();
  assert.deepEqual(sites, ['sc-domain:acme.com']);
  assert.equal(pull.matchSite(sites, 'https://www.acme.com'), 'sc-domain:acme.com');
  assert.equal(pull.matchSite(['https://www.acme.com/'], 'https://acme.com'), 'https://www.acme.com/');
  assert.equal(pull.matchSite(sites, 'https://other.com'), null);
  assert.deepEqual(await pull.listAnalyticsProperties(), [{ id: '123', name: 'Acme' }]);
});

test('pullAll stores both sources; a failure in one does not stop the other', async () => {
  setSetting('gscSite', 'sc-domain:acme.com');
  setSetting('ga4Property', '123');
  const s = await pull.pullAll(new Date('2026-10-16T12:00:00Z'));
  assert.equal(s.searchConsole.rows, 3);
  assert.equal(s.analytics.rows, 2);
  const gscCall = calls.find((c) => c.url.includes('searchAnalytics'));
  assert.deepEqual(JSON.parse(gscCall.body).dimensions, ['query', 'page']);
  assert.equal(JSON.parse(gscCall.body).endDate, '2026-10-14');

  setSetting('ga4Property', '999');
  const s2 = await pull.pullAll(new Date('2026-10-16T12:00:00Z'));
  assert.match(s2.analytics.error, /404/);
  assert.equal(s2.searchConsole.rows, 3);
  setSetting('ga4Property', '123');
  await pull.pullAll(new Date('2026-10-16T12:00:00Z'));
});

test('results merge by path across www, trailing slash and full URL', () => {
  const pages = results.topPages();
  const blog = pages.find((p) => p.page === '/blog/best-widgets');
  assert.equal(blog.clicks, 3);
  assert.equal(blog.impressions, 500);
  assert.equal(blog.views, 120);
  assert.equal(pages[0].page, '/pricing');
  const q1 = results.topQueries().find((r) => r.query === 'widget pricing');
  assert.equal(q1.position, 4);
});

test('published drafts get their numbers; dry runs are ignored', () => {
  const live = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'Best widgets', body: 'x', meta: { keyword: 'best widgets' } });
  q.moveDraft(live.id, 'approved', { target: 'wordpress' });
  q.moveDraft(live.id, 'published', { publishedUrl: 'https://acme.com/blog/best-widgets/' });
  const dry = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'Dry', body: 'x', meta: {} });
  q.moveDraft(dry.id, 'approved', { target: 'wordpress' });
  q.moveDraft(dry.id, 'published', { publishedUrl: 'file:///tmp/x.html', dryRun: true });
  const r = results.publishedResults();
  assert.equal(r.length, 1);
  assert.equal(r[0].clicks, 3);
  assert.equal(r[0].views, 120);
  assert.equal(r[0].topQuery, 'best widgets');
});

test('notes list winners and near-misses, and reach agents after the cached docs', () => {
  const notes = results.performanceNotes(new Date(Date.now() + 30 * 86400e3));
  assert.match(notes, /"widget pricing": 30 clicks/);
  assert.match(notes, /page 2–3[\s\S]*"best widgets": 400 impressions/);
  assert.match(notes, /"Best widgets" \(seo\): 3 clicks/);
  const blocks = agentSystem('role', fs.mkdtempSync(path.join(os.tmpdir(), 'p-')), notes);
  assert.equal(blocks.length, 3);
  assert.ok(blocks[0].cache_control && !blocks[1].cache_control, 'daily notes must not be inside the cached prefix');
  assert.match(blocks[1].text, /^<results>/);
});

test('SEO opportunities start from Search Console near-misses', async () => {
  const { seoAgent } = require('../src/agents/seo');
  const opps = await seoAgent.findOpportunities({ limit: 1 });
  // "best widgets" is already covered by the published draft; the next near-miss is next in line.
  assert.equal(opps[0].keyword, 'best widgets 2026');
  assert.equal(opps[0].source, 'search-console');
});
