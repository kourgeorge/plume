require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { readPage } = require('../src/llm/search');
const { priceFor, supportsEffort } = require('../src/config');
const settings = require('../src/llm/settings');
const { parseHeaders, viaProxy, describeLlm, getLlmConfig, saveLlmConfig, clearLlmConfig, reloadLlmConfig, llmProblem } = settings;

const KEY_FILE = path.join(process.env.DATA_DIR, 'tokens', 'llm.json');
const withEnv = (vars, fn) => {
  const keep = {};
  for (const k of Object.keys(vars)) (keep[k] = process.env[k]), vars[k] === undefined ? delete process.env[k] : (process.env[k] = vars[k]);
  reloadLlmConfig();
  try {
    return fn();
  } finally {
    for (const k of Object.keys(keep)) keep[k] === undefined ? delete process.env[k] : (process.env[k] = keep[k]);
    reloadLlmConfig();
  }
};
const NO_ENV = { LLM_BASE_URL: undefined, LLM_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined };

test('no connection: AI is off with a plain reason, nothing crashes', () => {
  clearLlmConfig();
  withEnv(NO_ENV, () => {
    assert.equal(getLlmConfig().source, 'none');
    assert.match(llmProblem(), /no AI connection yet/);
    assert.equal(describeLlm().keyHint, null);
  });
});

test('.env gateway settings are used when nothing is saved', () => {
  clearLlmConfig();
  withEnv({ ...NO_ENV, LLM_BASE_URL: 'https://litellm.corp/', LLM_API_KEY: 'sk-env-1234' }, () => {
    const c = getLlmConfig();
    assert.equal(c.source, 'environment');
    assert.equal(c.baseUrl, 'https://litellm.corp');
    assert.equal(viaProxy(c), true);
    assert.equal(llmProblem(), null);
  });
  withEnv({ ...NO_ENV, ANTHROPIC_API_KEY: 'sk-ant-direct' }, () => assert.equal(viaProxy(getLlmConfig()), false));
});

test("another tool's gateway in the shell (ANTHROPIC_BASE_URL / AUTH_TOKEN) is never picked up", () => {
  clearLlmConfig();
  withEnv({ ...NO_ENV, ANTHROPIC_BASE_URL: 'https://someone-elses-gateway.example', ANTHROPIC_AUTH_TOKEN: 'their-token' }, () => {
    const c = getLlmConfig();
    assert.equal(c.baseUrl, '');
    assert.equal(c.apiKey, '');
    assert.match(llmProblem(), /no AI connection yet/);
  });
  // A gateway address with a direct Anthropic key would send the wrong key to the gateway.
  withEnv({ ...NO_ENV, LLM_BASE_URL: 'https://litellm.corp', ANTHROPIC_API_KEY: 'sk-ant-direct' }, () => assert.equal(getLlmConfig().apiKey, ''));
});

test('saving from the screen: stored privately, key never shown, empty key keeps the saved one', () => {
  withEnv({ ...NO_ENV, LLM_API_KEY: 'sk-env-should-lose' }, () => {
    saveLlmConfig({ baseUrl: 'https://gw.example/', apiKey: 'sk-secret-9f3a', headers: 'x-team: growth', models: { draft: 'aws/claude-sonnet-5-5' } });
    assert.equal(fs.statSync(KEY_FILE).mode & 0o777, 0o600, 'key file must be readable by this user only');
    const c = getLlmConfig();
    assert.equal(c.source, 'saved', 'saved settings win over .env');
    assert.equal(c.apiKey, 'sk-secret-9f3a');
    assert.equal(c.models.draft, 'aws/claude-sonnet-5-5');
    assert.equal(c.models.research, 'claude-opus-5-5', 'unset models keep the default');
    const shown = describeLlm();
    assert.deepEqual({ endpoint: shown.endpoint, keyHint: shown.keyHint, headerNames: shown.headerNames }, { endpoint: 'https://gw.example', keyHint: '…9f3a', headerNames: ['x-team'] });
    assert.ok(!JSON.stringify(shown).includes('sk-secret'), 'the key must never be shown');
    // Change only the model, leaving the key box empty: the key stays.
    saveLlmConfig({ apiKey: '', models: { score: 'claude-sonnet-5-5' } });
    assert.equal(getLlmConfig().apiKey, 'sk-secret-9f3a');
    assert.equal(getLlmConfig().models.score, 'claude-sonnet-5-5');
    assert.equal(getLlmConfig().baseUrl, 'https://gw.example');
  });
});

test('bad input is refused with a reason, and nothing is saved', () => {
  const before = fs.readFileSync(KEY_FILE, 'utf8');
  assert.throws(() => saveLlmConfig({ baseUrl: 'litellm corp', apiKey: 'k' }), /not a web address/);
  assert.throws(() => saveLlmConfig({ baseUrl: 'ftp://x.example', apiKey: 'k' }), /must start with http/);
  assert.throws(() => saveLlmConfig({ apiKey: 'k', headers: 'no colon here' }), /is not a header/);
  assert.equal(fs.readFileSync(KEY_FILE, 'utf8'), before);
  clearLlmConfig();
  withEnv(NO_ENV, () => assert.throws(() => saveLlmConfig({ baseUrl: 'https://gw.example', apiKey: '' }), /enter the API key/));
});

test('custom headers parse from "Name: value" lines', () => {
  assert.deepEqual(parseHeaders('x-a: 1\nx-b: two: parts\n\nbad'), { 'x-a': '1', 'x-b': 'two: parts' });
  assert.deepEqual(parseHeaders(undefined), {});
  assert.equal(viaProxy({ baseUrl: 'https://api.anthropic.com' }), false);
  assert.equal(viaProxy({ baseUrl: '' }), false);
});

test('connection errors are explained in plain words', () => {
  const { explainCallError } = require('../src/llm/client');
  assert.match(explainCallError({ status: 401, message: 'Token verification failed: invalid jwt string' }), /key was refused/);
  assert.match(explainCallError({ status: 403, message: "team not allowed to access model. This team can only access models=['x']" }), /doesn't allow this model/);
  assert.match(explainCallError({ status: 404, message: 'model not found' }), /unknown to the provider/);
  assert.match(explainCallError({ status: 429, message: 'slow down' }), /rate-limiting/);
});

test('prices and effort support follow proxy spellings of model names', () => {
  assert.deepEqual(priceFor('aws/claude-sonnet-5-5'), [2, 10, 0.2]);
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), [1, 5, 0.1]);
  assert.equal(supportsEffort('claude-haiku-4-5-20251001'), false);
  assert.equal(supportsEffort('aws/claude-opus-5-5'), true);
});

test('searchMode: direct = server, proxy = local with a search key, else off', () => {
  const { searchMode } = require('../src/llm/client');
  assert.equal(searchMode({ PLUME_SEARCH: 'off' }), 'off');
  assert.equal(searchMode({ PLUME_SEARCH: 'local' }), 'local');
  assert.ok(['server', 'local', 'off'].includes(searchMode({})));
});

test('read_page refuses local and non-web addresses chosen by the model', async () => {
  for (const u of ['http://localhost:4410/api/state', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
    await assert.rejects(readPage(u), /not allowed|only http/, u);
  }
});

test('read_page re-checks redirects, so a public page cannot bounce it to this machine', async () => {
  const { fetchPublic, isPrivateAddress, assertPublicUrl } = require('../src/research/safeUrl');
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
  // A name that resolves to a local address is refused.
  await assert.rejects(assertPublicUrl('http://evil.example/', async () => [{ address: '127.0.0.1', family: 4 }]), /not allowed/);
  // A public page that redirects to localhost: the hop is refused before it is fetched.
  const asked = [];
  const fetchFn = async (u) => (asked.push(String(u)), String(u).includes('public.example') ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4410/api/telegram' } }) : new Response('secret'));
  await assert.rejects(fetchPublic('https://public.example/a', {}, { fetchFn, lookupFn: publicDns }), /not allowed/);
  assert.deepEqual(asked, ['https://public.example/a']);
  // Normal redirects between public pages still work.
  const ok = async (u) => (String(u).endsWith('/a') ? new Response(null, { status: 301, headers: { location: '/b' } }) : new Response('fine'));
  assert.equal(await (await fetchPublic('https://public.example/a', {}, { fetchFn: ok, lookupFn: publicDns })).text(), 'fine');
});
