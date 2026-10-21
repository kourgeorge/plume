require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { fetchPage, fetchHttp, looksLikeChallenge } = require('../src/research/fetchPage');
const { crawlSite, CrawlError } = require('../src/research/crawl');

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const real = (extra = '') => `<html lang="he"><head><title>Real</title></head><body><h1>Real</h1><p>${words(80)}</p>${extra}</body></html>`;
const spa = '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
const challenge = '<html><head><title>Just a moment...</title></head><body>Checking your browser <script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>';
const respond = (body, status = 200, headers = {}) => async (url) => {
  const r = new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
  Object.defineProperty(r, 'url', { value: String(url) });
  return r;
};

test('a normal page is read without a browser', async () => {
  let opened = 0;
  const r = await fetchPage('https://a.test/', { fetchFn: respond(real()), browserFn: async () => (opened++, {}) });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'http');
  assert.equal(opened, 0);
});

test('a JavaScript-only page is opened in the browser', async () => {
  const r = await fetchPage('https://a.test/', { fetchFn: respond(spa), browserFn: async (u) => ({ status: 200, html: real(), url: u }) });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'browser');
});

test("Cloudflare's background script on a normal page is not a challenge", () => {
  const html = real().replace('</body>', "<script>a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js'</script></body>");
  assert.equal(looksLikeChallenge(200, new Headers(), html), null);
  assert.equal(looksLikeChallenge(200, new Headers(), "<html><body><script src='/cdn-cgi/challenge-platform/x.js'></script></body></html>"), 'Cloudflare bot protection');
});

test('a firewall challenge is recognised and the browser is tried', async () => {
  assert.equal(looksLikeChallenge(403, new Headers({ 'cf-mitigated': 'challenge' }), ''), 'Cloudflare bot protection');
  const blocked = await fetchHttp('https://a.test/', respond(challenge, 403, { server: 'cloudflare' }));
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.reason, /Cloudflare/);
  const r = await fetchPage('https://a.test/', { fetchFn: respond(challenge, 403), browserFn: async (u) => ({ status: 200, html: challenge, url: u }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /even in a real browser/);
});

test('a 403 from a plain server reads as "refused automated visitors"', async () => {
  const r = await fetchHttp('https://a.test/', respond('Forbidden', 403));
  assert.equal(r.kind, 'blocked');
  assert.match(r.reason, /refused automated visitors \(error 403\)/);
});

test('dead addresses and missing pages are not retried in a browser', async () => {
  let opened = 0;
  const browserFn = async () => (opened++, { status: 200, html: real(), url: 'x' });
  const dns = await fetchPage('https://nope.test/', { fetchFn: async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }, browserFn });
  assert.match(dns.reason, /address does not exist/);
  const missing = await fetchPage('https://a.test/gone', { fetchFn: respond('nope', 404), browserFn });
  assert.equal(missing.kind, 'http-error');
  assert.equal(opened, 0);
});

test('a short real page is kept when no browser is available', async () => {
  const r = await fetchPage('https://a.test/', { fetchFn: respond('<html><body><p>Short but real page.</p></body></html>'), browserFn: null });
  assert.equal(r.ok, true);
});

test('crawl switches to the browser for the whole site once needed', async () => {
  const site = {
    'https://spa.test/': spa,
    'https://spa.test/about': spa,
  };
  const browserPages = {
    'https://spa.test/': real('<a href="/about">About</a>'),
    'https://spa.test/about': real(),
  };
  let httpAfterSwitch = 0;
  let switched = false;
  const fetchFn = async (u) => {
    u = String(u);
    if (u.endsWith('robots.txt') || u.endsWith('sitemap.xml')) return new Response('', { status: 404 });
    if (switched) httpAfterSwitch++;
    return respond(site[u] ?? 'missing', site[u] ? 200 : 404)(u);
  };
  const browserFn = async (u) => ((switched = true), { status: 200, html: browserPages[u], url: u });
  const pages = await crawlSite('https://spa.test/', { fetchFn, browserFn });
  assert.deepEqual(pages.map((p) => p.url), ['https://spa.test/', 'https://spa.test/about']);
  assert.equal(pages[0].lang, 'he');
  assert.equal(httpAfterSwitch, 0, 'kept trying plain reads after the browser was needed');
});

test('when nothing can be read, the error says why', async () => {
  const fetchFn = async (u) => (String(u).endsWith('.txt') || String(u).endsWith('.xml') ? new Response('', { status: 404 }) : respond(challenge, 403, { server: 'cloudflare' })(u));
  await assert.rejects(
    crawlSite('https://wall.test/', { fetchFn, browserFn: async (u) => ({ status: 403, html: challenge, url: u }) }),
    (err) => err instanceof CrawlError && /Could not read https:\/\/wall.test\/: blocked by Cloudflare/.test(err.message),
  );
});

test("pages are asked for in the site's own languages, English last, never \"*\"", async () => {
  const { acceptLanguage } = require('../src/research/fetchPage');
  const { setContentLanguages } = require('../src/context/language');
  assert.equal(acceptLanguage([]), 'en');
  assert.equal(acceptLanguage(['he', 'en']), 'he,en;q=0.9');
  assert.equal(acceptLanguage(['de', 'fr']), 'de,fr;q=0.9,en;q=0.8');
  setContentLanguages({ main: 'he', all: ['he', 'ar'] });
  let sent;
  await fetchHttp('https://a.test/', async (url, init) => ((sent = init.headers['accept-language']), respond(real())(url)));
  assert.equal(sent, 'he,ar;q=0.9,en;q=0.8');
  setContentLanguages({ main: 'en', all: ['en'] });
});
