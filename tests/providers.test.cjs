require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A fake OpenAI-style provider (the format OpenAI, Groq, Gemini, Ollama and the rest speak).
const requests = [];
let reply = () => ({ text: 'hello' });
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    const r = reply(body);
    if (r.status) return res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: r.error } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunks = [];
    if (r.text) for (const part of r.text.match(/.{1,4}/gs)) chunks.push({ model: body.model, choices: [{ index: 0, delta: { content: part } }] });
    (r.calls ?? []).forEach((c, i) => {
      chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `call_${i}`, function: { name: c.name, arguments: '' } }] } }] });
      chunks.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: JSON.stringify(c.input) } }] } }] });
    });
    chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: r.calls ? 'tool_calls' : 'stop' }] });
    chunks.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } });
    res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
});

let client, settings, base;
test.before(
  () =>
    new Promise((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-providers-'));
        process.env.PLUME_SITE = 'test.example';
        for (const k of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY']) delete process.env[k];
        base = `http://127.0.0.1:${server.address().port}/v1`;
        settings = require('../src/llm/settings');
        client = require('../src/llm/client');
        resolve();
      }),
    ),
);
test.after(() => server.close());

test('each provider brings its own address and model names; switching never carries a key over', () => {
  const c = settings.saveLlmConfig({ provider: 'groq', apiKey: 'gsk-groq-1234' });
  assert.equal(settings.endpointOf(c), 'https://api.groq.com/openai/v1');
  assert.match(c.models.draft, /gpt-oss/);
  assert.equal(settings.openAiFormat(c), true);
  assert.equal(settings.viaProxy(c), true, 'Anthropic-only extras stay off');
  assert.throws(() => settings.saveLlmConfig({ provider: 'openai' }), /enter the API key/, "Groq's key must not be sent to OpenAI");
  assert.throws(() => settings.saveLlmConfig({ provider: 'nope', apiKey: 'k' }), /not a provider/);
  assert.throws(() => settings.saveLlmConfig({ provider: 'custom' }), /enter the address/);
  // A local model needs no key and costs nothing.
  const local = settings.saveLlmConfig({ provider: 'ollama' });
  assert.equal(settings.llmProblem(local), null);
  assert.equal(settings.describeLlm(local).endpoint, 'http://localhost:11434/v1');
  settings.clearLlmConfig();
});

test('.env: LLM_PROVIDER with the provider\'s own key variable', () => {
  process.env.LLM_PROVIDER = 'openai';
  process.env.OPENAI_API_KEY = 'sk-openai-env';
  settings.reloadLlmConfig();
  const c = settings.getLlmConfig();
  assert.deepEqual([c.provider, c.apiKey, c.source], ['openai', 'sk-openai-env', 'environment']);
  delete process.env.LLM_PROVIDER;
  delete process.env.OPENAI_API_KEY;
  settings.reloadLlmConfig();
  assert.equal(settings.getLlmConfig().provider, 'anthropic', 'no LLM_PROVIDER: the old behaviour');
});

test('an OpenAI-style provider: the request is translated, the answer comes back in the usual shape', async () => {
  settings.saveLlmConfig({ provider: 'custom', baseUrl: base, apiKey: 'sk-custom-9', models: { draft: 'my-model' } });
  requests.length = 0;
  reply = () => ({ text: 'a plain answer' });
  const r = await client.ask({ purpose: 'test', model: 'my-model', system: [{ type: 'text', text: 'be brief' }], prompt: 'hi', maxTokens: 500, effort: 'high' });
  assert.equal(r.text, 'a plain answer');
  const q = requests[0];
  assert.equal(q.url, '/v1/chat/completions');
  assert.equal(q.auth, 'Bearer sk-custom-9');
  assert.deepEqual(q.body.messages, [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]);
  assert.equal(q.body.max_tokens, 500);
  for (const k of ['output_config', 'cache_control', 'fallbacks']) assert.ok(!(k in q.body), `${k} is Anthropic-only`);
  const row = require('../src/db').getGlobalDb().prepare('SELECT * FROM llm_calls ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens], [60, 20, 40]);
});

test('structured answers: JSON schema first, plain JSON mode for providers without it, and fenced JSON is read', async () => {
  requests.length = 0;
  reply = (b) => (b.response_format?.type === 'json_schema' ? { status: 400, error: "response_format 'json_schema' is not supported" } : { text: '```json\n{"yes": true}\n```' });
  const r = await client.askJson({ purpose: 'test', model: 'my-model', system: 's', prompt: 'p', schema: { type: 'object', properties: { yes: { type: 'boolean' } } } });
  assert.equal(r.yes, true);
  assert.deepEqual(requests.map((q) => q.body.response_format.type), ['json_schema', 'json_object']);
  assert.match(requests[1].body.messages[0].content, /JSON schema/, 'the shape is spelled out for providers that only promise "some JSON"');
});

test('tools: calls are sent and read back, results go in as tool messages', async () => {
  requests.length = 0;
  let round = 0;
  reply = () => (round++ === 0 ? { calls: [{ name: 'lookup', input: { q: 'x' } }] } : { text: 'done' });
  const tool = { name: 'lookup', description: 'look up', input_schema: { type: 'object', properties: { q: { type: 'string' } } } };
  const server_tool = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };
  const msg = await client.converse({ purpose: 'chat:1', model: 'my-model', system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'go' }], tools: [tool, server_tool] });
  assert.equal(msg.stop_reason, 'tool_use');
  const call = msg.content.find((b) => b.type === 'tool_use');
  assert.deepEqual([call.name, call.input], ['lookup', { q: 'x' }]);
  assert.deepEqual(requests[0].body.tools.map((t) => t.function.name), ['lookup'], "Anthropic's own server tools are left out");
  const next = await client.converse({
    purpose: 'chat:1',
    model: 'my-model',
    system: [{ type: 'text', text: 's' }],
    messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: msg.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'found it' }] }],
    tools: [tool],
  });
  assert.equal(next.content[0].text, 'done');
  const sent = requests[1].body.messages;
  assert.equal(sent[2].tool_calls[0].function.name, 'lookup');
  assert.deepEqual(sent[3], { role: 'tool', tool_call_id: call.id, content: 'found it' });
});

test('connection test and plain errors work for OpenAI-style providers', async () => {
  reply = (b) => (b.model === 'gone' ? { status: 404, error: 'The model `gone` does not exist' } : b.response_format ? { text: '{"yes":true}' } : { text: 'ok' });
  const good = await client.testConnection({ ...settings.getLlmConfig(), models: { research: 'my-model', draft: 'my-model', score: 'gone' } });
  assert.deepEqual(good.checks.map((c) => [c.role, c.ok]), [['research', true], ['draft', true], ['score', false]]);
  assert.match(good.checks[2].message, /unknown to the provider/);
  // A port nothing listens on, like Ollama when it isn't started.
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const down = await client.testConnection({ ...settings.getLlmConfig(), baseUrl: `http://127.0.0.1:${port}/v1` });
  assert.match(down.checks[0].message, /nothing is answering/);
  settings.clearLlmConfig();
});
