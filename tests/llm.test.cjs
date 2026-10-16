require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
const { loadLlmSettings, parseHeaders, viaProxy, describe } = require('../src/llm/settings');
const { readPage } = require('../src/llm/search');
const { priceFor, supportsEffort } = require('../src/config');

const settingsFile = (obj) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plume-s-')), 'settings.json');
  fs.writeFileSync(f, JSON.stringify(obj));
  return f;
};

test('settings file: only connection and model keys are taken, nothing leaks into process.env', () => {
  const f = settingsFile({ env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'sk-secret-9f3a', ANTHROPIC_DEFAULT_SONNET_MODEL: 'aws/claude-sonnet-5-5', SOMETHING_ELSE: 'x' }, permissions: {} });
  const s = loadLlmSettings({ CLAUDE_SETTINGS_FILE: f, ANTHROPIC_API_KEY: 'direct-key' });
  assert.equal(s.ANTHROPIC_BASE_URL, 'https://gw.example');
  assert.equal(s.ANTHROPIC_DEFAULT_SONNET_MODEL, 'aws/claude-sonnet-5-5');
  assert.equal(s.SOMETHING_ELSE, undefined);
  assert.equal(s.ANTHROPIC_API_KEY, undefined, 'shell API key must not be mixed into proxy settings');
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN === 'sk-secret-9f3a', false);
  assert.deepEqual(describe(s), { source: f, endpoint: 'https://gw.example', auth: 'bearer token' });
  assert.ok(!JSON.stringify(describe(s)).includes('sk-secret-9f3a'), 'describe() must never show the key');
});

test('settings file errors are clear', () => {
  assert.throws(() => loadLlmSettings({ CLAUDE_SETTINGS_FILE: '/nope/settings.json' }), /could not read CLAUDE_SETTINGS_FILE/);
  assert.throws(() => loadLlmSettings({ CLAUDE_SETTINGS_FILE: settingsFile({ env: { ANTHROPIC_BASE_URL: 'x' } }) }), /no ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY/);
});

test('without a settings file, the environment is used', () => {
  const s = loadLlmSettings({ ANTHROPIC_API_KEY: 'k' });
  assert.equal(s.source, 'environment');
  assert.equal(viaProxy(s), false);
  assert.equal(viaProxy({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }), false);
  assert.equal(viaProxy({ ANTHROPIC_BASE_URL: 'https://litellm.corp' }), true);
});

test('custom headers parse from "Name: value" lines', () => {
  assert.deepEqual(parseHeaders('x-a: 1\nx-b: two: parts\n\nbad'), { 'x-a': '1', 'x-b': 'two: parts' });
  assert.deepEqual(parseHeaders(undefined), {});
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
