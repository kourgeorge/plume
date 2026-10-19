require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Fake gateway.
// - Plain questions (not streamed) are answered by `answerFor(model, question)`.
// - Analysis calls (streamed, structured) get the result whose key appears in the answer being analysed,
//   so it doesn't matter in which order the parallel calls arrive.
let answerFor = () => undefined;
const analysisByAnswer = [];
const seen = [];
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
const blank = { mentioned: false, position: null, sentiment: null, competitors: [], others: [] };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const b = JSON.parse(body || '{}');
    seen.push(b);
    const userText = typeof b.messages?.[0]?.content === 'string' ? b.messages[0].content : '';
    if (b.stream) {
      const hit = analysisByAnswer.find(([key]) => userText.includes(key));
      return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(JSON.stringify(hit ? hit[1] : blank)));
    }
    const answer = answerFor(b.model, userText);
    if (answer === undefined) return res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `model ${b.model} not found` } }));
    if (answer === 500) return res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream exploded' } }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: b.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 40 } }),
    );
  });
});

let v, today;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-geo-'));
  process.env.PLUME_SITE = 'test.example';
  process.env.LLM_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.LLM_API_KEY = 'k';
  process.env.PLUME_SEARCH = 'off';
  process.env.PLUME_MODEL_DRAFT = 'claude-sonnet-5-5';
  v = require('../src/geo/visibility');
  today = require('../src/today');
  require('../src/db').getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://www.test4u.example', 'Test4U', 'now')`).run();
  require('../src/context/extra').addCompetitor({ name: 'Easyteo', url: 'easyteo.example' });
  resolve();
})));
test.after(() => server.close());

const Q1 = 'What is the best way to pass the driving theory test?';
const Q2 = 'Which online theory course is worth paying for?';

test('brand names come from the domain plus any the owner adds; Latin names match whole words only', () => {
  // The site's saved name counts too, so prose that writes "Test4U" is caught without any setup.
  assert.deepEqual(v.brandNames(), ['Test4U', 'test4u.example', 'test4u']);
  v.setBrandNames(['Test4U', 'טסט פור יו']);
  assert.ok(v.brandNames().includes('טסט פור יו'));
  assert.equal(v.textMentions('Try Test4U for practice', v.brandNames()), true);
  assert.equal(v.textMentions('Try test4universe instead', v.brandNames()), false);
  assert.equal(v.textMentions('אפשר לנסות את טסט פור יו', v.brandNames()), true);
});

test('questions: validated, deduplicated ignoring case, capped', () => {
  assert.throws(() => v.addQuestion('hi'), /at least a few words/);
  assert.ok(v.addQuestion(Q1));
  assert.equal(v.addQuestion(Q1.toUpperCase()), null);
  v.addQuestion(Q2);
  assert.equal(v.listQuestions().length, 2);
  assert.equal(v.estimateCost().checks, 2, 'before looking for GPT and Gemini, only Claude (the writing model) counts');
});

test('finding the assistants: tries known model names, keeps the first that answers, sends nothing Claude-only', async () => {
  // On this gateway the faster GPT names don't exist; gpt-5.5 does.
  answerFor = (model) => (['claude-sonnet-5-5', 'azure/gpt-5.5', 'gemini-2.5-flash'].includes(model) ? 'ok' : undefined);
  const s = await v.detectEngines();
  assert.deepEqual([s.claude.model, s.gpt.model, s.gemini.model], ['claude-sonnet-5-5', 'azure/gpt-5.5', 'gemini-2.5-flash']);
  const probe = seen.find((r) => r.model === 'azure/gpt-5.5');
  assert.deepEqual(Object.keys(probe).sort(), ['max_tokens', 'messages', 'model']);
  assert.throws(() => v.pinEngine('gpt', 'not a model!'), /doesn't look like a model name/);
  assert.equal(v.estimateCost().checks, 6);
});

test('a check asks each assistant the bare question and records who it names', async () => {
  answerFor = (model, q) => {
    if (model === 'claude-sonnet-5-5') return q === Q1 ? 'Popular options are Easyteo and Test4U; Test4U has good videos.' : 'Easyteo is worth it.';
    if (model === 'azure/gpt-5.5') return 'I would suggest Easyteo or the official practice app.';
    if (model === 'gemini-2.5-flash') return 'Many learners use Easyteo.';
  };
  analysisByAnswer.length = 0;
  analysisByAnswer.push(
    // The analysis misses the mention here — the name is right there in the text, so it must still count.
    ['Popular options', { ...blank, mentioned: false, competitors: ['Easyteo'] }],
    ['official practice app', { ...blank, competitors: ['Easyteo'], others: ['the official practice app', 'Test4U app'] }],
    ['Many learners', { ...blank, competitors: ['Easyteo', 'NotOnTheList'] }],
    ['worth it', { ...blank, competitors: ['Easyteo'] }],
  );
  const before = seen.length;
  await v.runVisibilityCheck();
  const plain = seen.slice(before).filter((r) => !r.stream);
  assert.equal(plain.length, 6, 'two questions × three assistants');
  assert.ok(plain.every((r) => !r.system && r.messages.length === 1), 'assistants get the bare question, like a member of the public');

  const s = v.visibilitySummary();
  assert.deepEqual(s.overall, { answered: 6, mentioned: 1, score: 17, avgPosition: null });
  assert.deepEqual(s.perEngine.map((e) => [e.engine, e.mentioned, e.answered]), [['claude', 1, 2], ['gpt', 0, 2], ['gemini', 0, 2]]);
  const q1 = s.questions.find((q) => q.question === Q1);
  assert.equal(q1.cells.claude.mentioned, true);
  assert.equal(q1.cells.claude.sentiment, 'neutral', 'a mention the analysis missed gets a neutral reading');
  assert.equal(q1.cells.gpt.mentioned, false);
  assert.equal(q1.cells.gpt.sentiment, null);
  // Share of voice: our own name never counts as "someone else"; unknown competitor names are dropped.
  const voice = Object.fromEntries(s.shareOfVoice.map((x) => [x.name, x.answers]));
  assert.equal(voice.You, 1);
  assert.equal(voice.Easyteo, 6);
  assert.equal(voice['the official practice app'], 2);
  assert.equal(voice['Test4U app'], undefined);
  assert.equal(voice.NotOnTheList, undefined);
  assert.ok(s.cost > 0, 'the run records what it cost');
  assert.match(v.getAnswer(q1.cells.claude.answerId).answer, /Test4U has good videos/);
});

test('a question where nobody names us but they name others becomes a Dashboard card', () => {
  const gaps = v.openGaps();
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].question, Q2);
  assert.deepEqual(gaps[0].namedInstead.sort(), ['Easyteo', 'the official practice app']);
  const card = today.todayFeed().find((i) => i.kind === 'ai-gap');
  assert.equal(card.gap.question, Q2);
  today.aiGapSeen(card.gap.runId, card.gap.questionId);
  assert.ok(!today.todayFeed().some((i) => i.kind === 'ai-gap'));
});

test('an assistant that errors is recorded as failed, the others still count', async () => {
  const prev = answerFor;
  answerFor = (model, q) => (model === 'gemini-2.5-flash' ? 500 : prev(model, q));
  await v.runVisibilityCheck();
  const s = v.visibilitySummary();
  assert.equal(s.failed, 2);
  assert.equal(s.overall.answered, 4);
  assert.match(s.questions[0].cells.gemini.error, /upstream exploded/);
  assert.equal(s.trend.length, 2);
  answerFor = prev;
});

test('a check with nothing to ask says so', async () => {
  for (const q of v.listQuestions()) v.removeQuestion(q.id);
  await assert.rejects(v.runVisibilityCheck(), /add some questions/);
});
