require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-red-test-'));
process.env.PLUME_SITE = 'test.example';

const { headerIssues, transportIssues, versionIssues, readGenerator } = require('../src/red/checks');
const { parsePackageLock, dependencyIssues, secretIssues } = require('../src/red/repoScan');
const { probeFiles } = require('../src/red/fileProbe');
const { runActiveTests } = require('../src/red/active');
const { bumpInManifest } = require('../src/red/depFix');

// ---------------------------------------------------------------- header checks

test('headerIssues flags every missing security header', () => {
  const head = { ok: true, url: 'https://acme.test/', status: 200, headers: {} };
  const issues = headerIssues('https://acme.test/', head);
  const checks = issues.map((i) => i.check).sort();
  assert.deepEqual(checks, [
    'missing-csp',
    'missing-hsts',
    'missing-referrer-policy',
    'missing-x-content-type',
    'missing-x-frame-options',
  ]);
  assert.ok(issues.every((i) => i.area === 'security'));
  assert.ok(issues.find((i) => i.check === 'missing-hsts').snippet.startsWith('Strict-Transport-Security:'));
});

test('headerIssues reports nothing when all headers are present', () => {
  const head = {
    ok: true,
    url: 'https://acme.test/',
    status: 200,
    headers: {
      'strict-transport-security': 'max-age=31536000',
      'content-security-policy': "default-src 'self'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'referrer-policy': 'no-referrer',
    },
  };
  assert.deepEqual(headerIssues('https://acme.test/', head), []);
});

test('headerIssues says nothing about a page it could not read', () => {
  assert.deepEqual(headerIssues('https://acme.test/', { ok: false, url: 'https://acme.test/', status: 0, headers: {} }), []);
});

// ---------------------------------------------------------------- transport

test('transportIssues flags a plain-http site as critical', () => {
  const issues = transportIssues('http://acme.test');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].check, 'no-https');
  assert.equal(issues[0].severity, 'critical');
});

test('the missing http->https redirect is left to the site check, so it is not reported twice', () => {
  assert.ok(!transportIssues('https://acme.test').some((i) => i.check === 'no-https-redirect'));
});

test('transportIssues flags mixed content on a secure page', () => {
  const html = '<img src="http://cdn.example.com/logo.png">';
  const issues = transportIssues('https://acme.test', html);
  assert.ok(issues.find((i) => i.check === 'mixed-content'));
});

// ---------------------------------------------------------------- versions

test('readGenerator pulls builder and version from the meta tag', () => {
  assert.deepEqual(readGenerator('<meta name="generator" content="WordPress 6.3.1">'), { builder: 'WordPress', version: '6.3.1' });
});

test('versionIssues flags an out-of-date WordPress and spares a current one', () => {
  assert.equal(versionIssues('https://acme.test', '<meta name="generator" content="WordPress 6.3">').length, 1);
  assert.equal(versionIssues('https://acme.test', '<meta name="generator" content="WordPress 6.9">').length, 0);
});

// ---------------------------------------------------------------- dependencies

test('parsePackageLock reads v3 packages and v1 dependencies', () => {
  const v3 = JSON.stringify({ packages: { '': {}, 'node_modules/lodash': { version: '4.17.19' } } });
  assert.equal(parsePackageLock(v3).lodash, '4.17.19');
  const v1 = JSON.stringify({ dependencies: { axios: { version: '0.21.0' } } });
  assert.equal(parsePackageLock(v1).axios, '0.21.0');
});

test('dependencyIssues flags a vulnerable version and clears a fixed one', () => {
  assert.equal(dependencyIssues('me/repo', { lodash: '4.17.19' }).length, 1);
  assert.equal(dependencyIssues('me/repo', { lodash: '4.17.21' }).length, 0);
});

// ---------------------------------------------------------------- secrets

test('secretIssues flags a committed AWS key as critical', () => {
  const issues = secretIssues('me/repo', 'config.js', 'const k = "AKIAIOSFODNN7EXAMPLE";');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'critical');
});

test('secretIssues softens a match in an example file to low', () => {
  const issues = secretIssues('me/repo', '.env.example', 'AWS_KEY=AKIAIOSFODNN7EXAMPLE');
  assert.equal(issues[0].severity, 'low');
});

// ---------------------------------------------------------------- file probe

test('probeFiles reports an exposed .env only when the body looks real', async () => {
  const fake = async (url) => {
    if (String(url).endsWith('/.env')) return new Response('DB_PASSWORD=secret\nAPI_KEY=xyz', { status: 200 });
    return new Response('not found', { status: 404 });
  };
  const issues = await probeFiles('https://acme.test', fake);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].check, 'exposed-env');
});

test('probeFiles ignores a soft 404 that returns a normal page', async () => {
  const fake = async () => new Response('<html><body>Page not found</body></html>', { status: 200 });
  assert.deepEqual(await probeFiles('https://acme.test', fake), []);
});

// ---------------------------------------------------------------- active tests

test('runActiveTests flags unescaped reflected input but not an escaped site', async () => {
  const reflecting = async (url) =>
    new Response(String(url).includes('%3C') || String(url).includes('<') ? '<div><plumeRedCheck1337></div>' : 'ok', { status: 200 });
  const issues = await runActiveTests('https://acme.test', reflecting);
  assert.ok(issues.find((i) => i.check === 'reflected-input'));

  const escaped = async () => new Response('<div>&lt;plumeRedCheck1337&gt;</div>', { status: 200 });
  const safe = await runActiveTests('https://acme.test', escaped);
  assert.ok(!safe.find((i) => i.check === 'reflected-input'));
});

test('runActiveTests flags an open redirect', async () => {
  const redirecting = async (url) => {
    const u = new URL(String(url));
    const next = u.searchParams.get('next');
    return new Response('', { status: next ? 302 : 200, headers: next ? { location: next } : {} });
  };
  const issues = await runActiveTests('https://acme.test', redirecting);
  assert.ok(issues.find((i) => i.check === 'open-redirect-next'));
});

test('runActiveTests detects SQLi from an error on the odd quote only, not exploitation', async () => {
  const fake = async (url) => {
    const q = new URL(String(url)).searchParams.get('q') || '';
    const odd = (q.match(/'/g) || []).length % 2 === 1;
    return new Response(odd ? 'You have an error in your SQL syntax near ...' : '<html>ok</html>', { status: 200 });
  };
  const issues = await runActiveTests('https://acme.test', fake);
  const sqli = issues.find((i) => i.check === 'sql-injection');
  assert.ok(sqli);
  assert.equal(sqli.severity, 'critical');
});

test('runActiveTests spares a site that errors on both quotes (not injectable)', async () => {
  const fake = async () => new Response('generic error page', { status: 200 });
  const issues = await runActiveTests('https://acme.test', fake);
  assert.ok(!issues.find((i) => i.check === 'sql-injection'));
});

test('runActiveTests flags open CORS with credentials, and an insecure session cookie', async () => {
  const fake = async (url, opts) => {
    const origin = opts && opts.headers && opts.headers.origin;
    const headers = { 'set-cookie': 'sessionid=abc; Path=/' };
    if (origin) {
      headers['access-control-allow-origin'] = origin;
      headers['access-control-allow-credentials'] = 'true';
    }
    return new Response('ok', { status: 200, headers });
  };
  const issues = await runActiveTests('https://acme.test', fake);
  assert.ok(issues.find((i) => i.check === 'cors-reflects-origin'));
  assert.ok(issues.find((i) => i.check.startsWith('cookie-flags-sessionid')));
});

// ---------------------------------------------------------------- dependency fix

test('bumpInManifest raises a listed dependency and leaves others alone', () => {
  const manifest = JSON.stringify({ dependencies: { lodash: '4.17.19', express: '4.18.0' } }, null, 2);
  const { text, changed } = bumpInManifest(manifest, 'lodash', '4.17.21');
  assert.ok(changed);
  assert.ok(text.includes('"lodash": "^4.17.21"'));
  assert.ok(text.includes('"express": "4.18.0"'));
});

test('bumpInManifest reports no change when the dependency is not listed directly', () => {
  const manifest = JSON.stringify({ dependencies: { express: '4.18.0' } });
  assert.equal(bumpInManifest(manifest, 'lodash', '4.17.21').changed, false);
});
