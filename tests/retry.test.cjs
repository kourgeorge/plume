require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A fake model server stands in for the proxy. It must exist before the client is configured.
let mode = 'cut-then-ok';
let calls = 0;
const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
const fullStream = sse([
  ['message_start', { message }],
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'complete answer' } }],
  ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
  ['message_stop', {}],
]);
let lastAuth = null;
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    calls++;
    lastAuth = req.headers.authorization;
    if (mode === 'bad-request') return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (mode === 'silent-then-ok' && calls === 1) {
      // The gateway starts the reply, then goes quiet with the line still open.
      res.write(sse([['message_start', { message }], ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }]]));
      return;
    }
    if ((mode === 'cut-then-ok' && calls === 1) || mode === 'always-cut') {
      res.write(sse([['message_start', { message }], ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }]]));
      setTimeout(() => res.socket.destroy(), 20); // the gateway drops the line mid-reply
      return;
    }
    res.end(fullStream);
  });
});

let client;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-retry-'));
  process.env.DATA_DIR = dir;
  process.env.PLUME_SITE = 'test.example';
  // The fake gateway, configured the way a user would: base URL + key.
  process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LLM_API_KEY = 'test-token';
  client = require('../src/llm/client');
  client.setSleepForTests(async () => {});
  resolve();
})));
test.after(() => server.close());

const ask = () => client.ask({ purpose: 'test', model: 'claude-sonnet-5-5', system: 's', prompt: 'p', maxTokens: 100 });

test('a reply cut off mid-stream is retried and the full answer comes back', async () => {
  calls = 0;
  mode = 'cut-then-ok';
  const r = await ask();
  assert.equal(r.text, 'complete answer');
  assert.equal(calls, 2);
  assert.equal(lastAuth, 'Bearer test-token', 'a gateway gets the key as a Bearer token');
  const { recentLogs } = require('../src/log');
  assert.ok(recentLogs({ source: 'llm' }).some((l) => /cut off/.test(l.message)), 'the retry should be logged');
});

test('gives up after three tries with the real error', async () => {
  calls = 0;
  mode = 'always-cut';
  await assert.rejects(ask());
  assert.equal(calls, 3);
});

test('a bad request is not retried', async () => {
  calls = 0;
  mode = 'bad-request';
  await assert.rejects(ask(), /nope/);
  assert.equal(calls, 1);
});

test('a reply that goes silent with the line open is cut off and retried, not waited on forever', async () => {
  calls = 0;
  mode = 'silent-then-ok';
  client.setStreamIdleForTests(150);
  try {
    const r = await ask();
    assert.equal(r.text, 'complete answer');
    assert.equal(calls, 2);
  } finally {
    client.setStreamIdleForTests(180_000);
  }
});
