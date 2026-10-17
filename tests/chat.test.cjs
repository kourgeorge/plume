require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A fake model gateway that plays back a script of replies and records every request it gets.
const script = [];
const requests = [];
const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join('');
function reply(blocks, stop) {
  const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 0 } };
  const ev = [['message_start', { message }]];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push(['content_block_start', { index, content_block: { type: 'text', text: '' } }]);
      ev.push(['content_block_delta', { index, delta: { type: 'text_delta', text: b.text } }]);
    } else {
      ev.push(['content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } }]);
      ev.push(['content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }]);
    }
    ev.push(['content_block_stop', { index }]);
  });
  ev.push(['message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } }], ['message_stop', {}]);
  return sse(ev);
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests.push(JSON.parse(body));
    const next = script.shift();
    if (!next) return res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'script ran out' } }));
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(reply(next.blocks, next.stop));
  });
});

let chat, profile, q, extra;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-chat-'));
  process.env.PLUME_SITE = 'test.example';
  process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LLM_API_KEY = 'test-key';
  process.env.PLUME_SEARCH = 'off';
  chat = require('../src/chat');
  profile = require('../src/context/profile');
  q = require('../src/queue');
  extra = require('../src/context/extra');
  profile.writeDoc('voice', '# Brand voice\n\nFormal and careful.\n');
  resolve();
})));
test.after(() => server.close());

const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });

test('a document change is proposed, shown as a difference, and applied only by the owner', async () => {
  script.push(
    { blocks: [tool('tu_1', 'read_document', { doc: 'voice' })], stop: 'tool_use' },
    { blocks: [text('Here is a warmer version.'), tool('tu_2', 'propose_document_change', { doc: 'voice', new_text: '# Brand voice\n\nWarm and direct.\n', summary: 'Warmer tone' })], stop: 'tool_use' },
    { blocks: [text('Apply it if you like it.')], stop: 'end_turn' },
  );
  const t = chat.createThread('Make our voice warmer');
  await chat.sendMessage(t.id, 'Make our voice warmer');
  assert.equal(chat.getThread(t.id).error, null);
  assert.equal(profile.readDoc('voice'), '# Brand voice\n\nFormal and careful.\n', 'the assistant must not change a document by itself');

  // The second request carried the document text back to the model as a tool result.
  const toolResult = requests[1].messages.at(-1).content[0];
  assert.equal(toolResult.type, 'tool_result');
  assert.match(toolResult.content, /Formal and careful/);

  const shown = chat.showThread(t.id);
  assert.equal(shown.items.length, 2, 'one owner message, one combined answer');
  const answer = shown.items[1];
  assert.match(answer.html, /warmer version[\s\S]*Apply it/);
  assert.deepEqual(answer.steps, ['Read a document', 'Proposed a change']);
  const change = answer.actions[0];
  assert.equal(change.status, 'pending');
  assert.deepEqual(change.stats, { added: 1, removed: 1 });
  assert.deepEqual(change.diff.filter((l) => l.t !== 'same').map((l) => `${l.t}:${l.line}`), ['del:Formal and careful.', 'add:Warm and direct.']);

  chat.applyAction(change.id);
  assert.equal(profile.readDoc('voice'), '# Brand voice\n\nWarm and direct.\n');
  assert.throws(() => chat.applyAction(change.id), /already applied/);
});

test('history is append-only: every request starts with the previous request exactly', () => {
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1].messages;
    assert.deepEqual(requests[i].messages.slice(0, prev.length), prev, `request ${i} rewrote earlier history`);
    assert.deepEqual(requests[i].system, requests[0].system, 'system prompt must stay frozen for the thread');
  }
});

test('the next message tells the model what the owner did, and a stale change cannot be applied', async () => {
  const t = chat.getThread(1);
  script.push(
    { blocks: [tool('tu_3', 'propose_document_change', { doc: 'voice', new_text: '# Brand voice\n\nWarm, direct, a little funny.\n', summary: 'Add humour' })], stop: 'tool_use' },
    { blocks: [text('Proposed.')], stop: 'end_turn' },
  );
  const before = requests.length;
  await chat.sendMessage(t.id, 'Now add a bit of humour');
  const userTurn = requests[before].messages.at(-1).content;
  assert.match(userTurn[0].text, /^<context-update>[\s\S]*applied change #1/);
  assert.equal(userTurn[1].text, 'Now add a bit of humour');
  // The owner hides the note from themselves: the page shows only what they typed.
  assert.equal(chat.showThread(t.id).items.at(-2).text, 'Now add a bit of humour');

  const pending = chat.showThread(t.id).items.at(-1).actions[0];
  profile.writeDoc('voice', '# Brand voice\n\nEdited by hand meanwhile.\n');
  assert.equal(chat.showThread(t.id).items.at(-1).actions[0].stale, true);
  assert.throws(() => chat.applyAction(pending.id), /has changed since this was proposed/);
  chat.discardAction(pending.id);
  assert.equal(profile.readDoc('voice'), '# Brand voice\n\nEdited by hand meanwhile.\n');
});

test('drafts written in chat land in Today; added competitors can be undone', async () => {
  script.push(
    {
      blocks: [
        tool('tu_4', 'create_draft', { kind: 'social_post', channel: 'linkedin', title: 'Why we built it', body: 'We built it because…', reason: 'Owner asked' }),
        tool('tu_5', 'add_competitor', { name: 'Rival', website: 'rival.example', notes: 'cheaper' }),
      ],
      stop: 'tool_use',
    },
    { blocks: [text('Done: one draft, one competitor.')], stop: 'end_turn' },
  );
  const t = chat.createThread('Write a LinkedIn post and add Rival');
  await chat.sendMessage(t.id, 'Write a LinkedIn post and add Rival');
  const drafts = q.listDrafts({ status: 'draft', agent: 'chat' });
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].meta.channel, 'linkedin');
  assert.ok(require('../src/today').todayFeed().some((i) => i.kind === 'draft' && i.draft.id === drafts[0].id));
  const actions = chat.showThread(t.id).items.at(-1).actions;
  assert.deepEqual(actions.map((a) => a.kind), ['draft', 'competitor']);
  assert.equal(actions[0].draft.status, 'draft');
  assert.equal(extra.listCompetitors().length, 1);
  chat.undoAction(actions[1].id);
  assert.equal(extra.listCompetitors().length, 0);
});

test('a tool call left unanswered by a crash is repaired before the next message', async () => {
  const t = chat.createThread('crash test');
  // Simulate a reply that asked for a tool, then Plume stopped before running it.
  const { getDb } = require('../src/db');
  getDb().prepare(`INSERT INTO chat_messages (thread_id, role, kind, content, at) VALUES (?, 'user', 'text', ?, 'now')`).run(t.id, JSON.stringify([text('hello')]));
  getDb().prepare(`INSERT INTO chat_messages (thread_id, role, kind, content, at) VALUES (?, 'assistant', 'assistant', ?, 'now')`).run(t.id, JSON.stringify([tool('tu_lost', 'get_today', {})]));
  script.push({ blocks: [text('Back again.')], stop: 'end_turn' });
  const before = requests.length;
  await chat.sendMessage(t.id, 'are you there?');
  assert.equal(chat.getThread(t.id).error, null);
  const sent = requests[before].messages;
  const repaired = sent[sent.length - 2].content[0];
  assert.equal(repaired.type, 'tool_result');
  assert.equal(repaired.tool_use_id, 'tu_lost');
  assert.equal(repaired.is_error, true);
});

test('bad tool input is answered as an error, not a crash; the model can recover', async () => {
  script.push(
    { blocks: [tool('tu_6', 'propose_document_change', { doc: 'nonsense', new_text: 'x', summary: 'y' }), tool('tu_7', 'run_agent', { agent: 'seo' })], stop: 'tool_use' },
    { blocks: [text('Sorry, I could not do that.')], stop: 'end_turn' },
  );
  const t = chat.createThread('break things');
  const before = requests.length;
  await chat.sendMessage(t.id, 'break things');
  const results = requests[before + 1].messages.at(-1).content;
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content, /unknown document/);
  assert.equal(results[1].is_error, true);
  assert.match(results[1].content, /finish the business profile first/, 'the agent cannot run without a complete profile');
  assert.equal(chat.getThread(t.id).error, null);
});

test('a second message while one is being answered is refused', async () => {
  script.push({ blocks: [text('slow')], stop: 'end_turn' });
  const t = chat.createThread('one');
  const first = chat.sendMessage(t.id, 'one');
  await assert.rejects(chat.sendMessage(t.id, 'two'), /still answering/);
  await first;
});

test('line diff collapses long unchanged runs and keeps context', () => {
  const { lineDiff } = require('../src/diff');
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 15', 'line fifteen');
  const d = lineDiff(before, after);
  assert.deepEqual(d.map((l) => l.t), ['gap', 'same', 'same', 'del', 'add', 'same', 'same', 'gap']);
  assert.equal(d[0].line, '13 unchanged lines');
  assert.deepEqual(lineDiff('a\nb', 'a\nb').map((l) => l.t), ['gap']);
  assert.deepEqual(lineDiff('', 'new').map((l) => `${l.t}:${l.line}`), ['del:', 'add:new']);
});
