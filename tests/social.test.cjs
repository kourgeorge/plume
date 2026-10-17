require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// One fake server plays X (/x), LinkedIn (/li), Reddit sign-in and public pages (/ra), Reddit API (/ro) and the AI gateway (/llm).
const seen = [];
const llmScript = [];
const routes = {};
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
    seen.push({ method: req.method, path: u.pathname, query: u.search, headers: req.headers, body });
    if (u.pathname === '/llm/v1/messages') {
      const next = llmScript.shift();
      return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(JSON.stringify(next)));
    }
    const h = routes[`${req.method} ${u.pathname}`];
    if (!h) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"no route"}');
    const [status, data, headers] = h(body, req);
    res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) }).end(JSON.stringify(data));
  });
});

let base, text, pub, publish, runner, q, agents;
test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-social-'));
  process.env.PLUME_SITE = 'test.example';
  process.env.LLM_BASE_URL = `${base}/llm`;
  process.env.LLM_API_KEY = 'k';
  process.env.PLUME_SEARCH = 'off';
  for (const k of Object.keys(process.env)) if (/^(X_|LINKEDIN_|REDDIT_)/.test(k)) delete process.env[k];
  text = require('../src/social/text');
  pub = require('../src/social/publishers');
  Object.assign(pub.SOCIAL_API, { x: `${base}/x`, linkedin: `${base}/li`, redditAuth: `${base}/ra`, reddit: `${base}/ro` });
  publish = require('../src/publish');
  runner = require('../src/publish/runner');
  q = require('../src/queue');
  agents = require('../src/social/agents');
  require('../src/db').getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://acme.example', 'Acme', 'now')`).run();
  resolve();
})));
test.after(() => server.close());

const X_ENV = { X_API_KEY: 'ck', X_API_SECRET: 'cs', X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'as' };
const LI_ENV = { LINKEDIN_TOKEN: 'li-token' };
const RD_ENV = { REDDIT_CLIENT_ID: 'rid', REDDIT_CLIENT_SECRET: 'rsec', REDDIT_USERNAME: 'acme_team', REDDIT_PASSWORD: 'pw' };
const draft = (o) => ({ id: 1, kind: 'x_post', title: 't', body: '', meta: {}, ...o });

test('X length: links count 23, emoji 2, Hebrew 1', () => {
  assert.equal(text.xLength('hello https://example.com/a/very/long/path/that/goes/on'), 6 + 23);
  assert.equal(text.xLength('שלום'), 4);
  assert.equal(text.xLength('ok 👍'), 3 + 2);
});

test('length problems: X post, thread too long, LinkedIn limit; text is never cut', () => {
  assert.deepEqual(text.lengthProblems('x', 'short'), []);
  const long = 'a'.repeat(281);
  assert.match(text.describeProblems('x', text.lengthProblems('x', long)), /post 1 is 281 characters; the limit is 280/);
  const thread = Array.from({ length: 7 }, (_, i) => `post ${i}`).join('\n---\n');
  assert.match(text.describeProblems('x', text.lengthProblems('x', thread)), /7 posts; keep it to 6/);
  assert.equal(text.lengthProblems('linkedin', 'x'.repeat(3001))[0].length, 3001);
  assert.deepEqual(text.splitThread(text.joinThread(['one', ' two '])), ['one', 'two']);
});

test('plain text and LinkedIn escaping keep the words', () => {
  assert.equal(text.plainText('# Big news\n\n**Bold** and *soft* [link](https://a.example)'), 'Big news\n\nBold and soft link https://a.example');
  assert.equal(text.linkedinEscape('Q&A (live) #today @team'), 'Q&A \\(live\\) \\#today \\@team');
});

test('destinations must fit the draft: no articles on X, no tweets on WordPress', () => {
  assert.throws(() => publish.checkTarget('blog_post', 'x'), /X \(Twitter\) can't take an article/);
  assert.throws(() => publish.checkTarget('x_post', 'wordpress'), /can't take a social post. Pick one of: X \(Twitter\), Save as files/);
  assert.doesNotThrow(() => publish.checkTarget('social_post', 'linkedin'));
  assert.doesNotThrow(() => publish.checkTarget('reddit_reply', 'export'));
  assert.ok(!publish.targetsFor('article').includes('reddit'));
});

test('X: a thread is posted as a chain of replies, signed with OAuth 1.0a', async () => {
  let n = 0;
  routes['POST /x/2/tweets'] = () => [201, { data: { id: String(100 + ++n) } }];
  const r = await pub.xPublisher.publish(draft({ kind: 'x_thread', body: 'First **post**\n\n---\n\nSecond post' }), '', X_ENV);
  assert.equal(r.url, 'https://x.com/i/status/101');
  assert.equal(r.externalId, '101,102');
  const sent = seen.filter((s) => s.path === '/x/2/tweets').map((s) => JSON.parse(s.body));
  assert.deepEqual(sent, [{ text: 'First post' }, { text: 'Second post', reply: { in_reply_to_tweet_id: '101' } }]);
  assert.match(seen.find((s) => s.path === '/x/2/tweets').headers.authorization, /^OAuth oauth_consumer_key="ck", .*oauth_signature="/);
});

test('X: a failure halfway says how far it got; too long is refused before posting', async () => {
  let n = 0;
  routes['POST /x/2/tweets'] = () => (++n === 1 ? [201, { data: { id: '200' } }] : [403, { detail: 'not permitted' }]);
  await assert.rejects(pub.xPublisher.publish(draft({ kind: 'x_thread', body: 'a\n---\nb\n---\nc' }), '', X_ENV), /posted 1 of 3 \(first: https:\/\/x\.com\/i\/status\/200\), then: X refused: not permitted/);
  const before = seen.length;
  await assert.rejects(pub.xPublisher.publish(draft({ body: 'z'.repeat(300) }), '', X_ENV), /too long to publish: post 1 is 300 characters/);
  assert.equal(seen.length, before, 'nothing should be sent for a too-long post');
});

test('LinkedIn: posts as the token owner with a current API version and escaped text', async () => {
  routes['GET /li/v2/userinfo'] = () => [200, { sub: 'abc123' }];
  routes['POST /li/rest/posts'] = () => [201, {}, { 'x-restli-id': 'urn:li:share:999' }];
  const r = await pub.linkedinPublisher.publish(draft({ kind: 'linkedin_post', body: 'We shipped (finally) #launch' }), '', LI_ENV);
  assert.equal(r.url, 'https://www.linkedin.com/feed/update/urn:li:share:999');
  const sent = seen.filter((s) => s.path === '/li/rest/posts').at(-1);
  const body = JSON.parse(sent.body);
  assert.equal(body.author, 'urn:li:person:abc123');
  assert.equal(body.commentary, 'We shipped \\(finally\\) \\#launch');
  assert.match(sent.headers['linkedin-version'], /^\d{6}$/);
  assert.equal(pub.linkedinVersion({}, new Date('2026-01-15T00:00:00Z')), '202511');
  routes['GET /li/v2/userinfo'] = () => [401, {}];
  await assert.rejects(pub.linkedinPublisher.publish(draft({ kind: 'linkedin_post', body: 'x' }), '', LI_ENV), /may have expired/);
  await assert.rejects(pub.linkedinPublisher.publish(draft({ kind: 'linkedin_post', body: 'x' }), '', { ...LI_ENV, LINKEDIN_AUTHOR: 'acme corp' }), /is not a LinkedIn author/);
});

test('Reddit: replies with the thread id; Reddit errors come back in plain words', async () => {
  pub.resetRedditTokenForTests();
  routes['POST /ra/api/v1/access_token'] = () => [200, { access_token: 'rt', expires_in: 3600 }];
  routes['POST /ro/api/comment'] = () => [200, { json: { errors: [], data: { things: [{ data: { permalink: '/r/x/comments/abc/_/def/', name: 't1_def' } }] } } }];
  const r = await pub.redditPublisher.publish(draft({ kind: 'reddit_reply', body: 'Helpful answer', meta: { thingId: 't3_abc' } }), '', RD_ENV);
  assert.equal(r.url, 'https://www.reddit.com/r/x/comments/abc/_/def/');
  const sent = seen.filter((s) => s.path === '/ro/api/comment').at(-1);
  assert.equal(new URLSearchParams(sent.body).get('thing_id'), 't3_abc');
  assert.equal(sent.headers.authorization, 'Bearer rt');
  assert.match(sent.headers['user-agent'], /by \/u\/acme_team/);
  routes['POST /ro/api/comment'] = () => [200, { json: { errors: [['RATELIMIT', 'you are doing that too much. try again in 9 minutes.', 'ratelimit']] } }];
  await assert.rejects(pub.redditPublisher.publish(draft({ kind: 'reddit_reply', body: 'x', meta: { thingId: 't3_abc' } }), '', RD_ENV), /Reddit asks you to wait before posting again/);
  await assert.rejects(pub.redditPublisher.publish(draft({ kind: 'reddit_post', body: 'x', meta: {} }), '', RD_ENV), /which subreddit/);
});

test('Reddit daily limit: extra approved posts wait for another day instead of failing', async () => {
  pub.resetRedditTokenForTests();
  routes['POST /ro/api/comment'] = () => [200, { json: { errors: [], data: { things: [{ data: { permalink: '/r/x/c/1/', name: 't1_1' } }] } } }];
  const ids = [1, 2, 3].map((i) => q.createDraft({ agent: 'reddit', kind: 'reddit_reply', title: `r${i}`, body: 'answer', meta: { thingId: `t3_x${i}` } }).id);
  for (const id of ids) q.moveDraft(id, 'approved', { target: 'reddit' });
  const env = { ...RD_ENV, REDDIT_DAILY_LIMIT: '2' };
  await runner.publishDue(env);
  const statuses = ids.map((id) => q.getDraft(id).status);
  assert.deepEqual(statuses, ['published', 'published', 'approved']);
  await runner.publishDue(env);
  assert.equal(q.getDraft(ids[2]).status, 'approved', 'still waiting the same day');
  const tomorrow = new Date(Date.now() + 86400e3);
  await runner.publishDue(env, tomorrow);
  assert.equal(q.getDraft(ids[2]).status, 'published');
  assert.equal(runner.redditDailyLimit({}), 2);
  assert.equal(runner.redditDailyLimit({ REDDIT_DAILY_LIMIT: '500' }), 2, 'silly values fall back to the safe default');
});

test('Reddit threads: locked, archived, NSFW, old and already-answered ones are skipped', () => {
  const now = Date.UTC(2026, 9, 17) ;
  const t = (o) => ({ data: { name: 't3_a', title: 'Q', selftext: '', subreddit: 's', permalink: '/r/s/comments/a/q/', num_comments: 3, created_utc: now / 1000 - 3600, ...o } });
  const out = agents.usableThreads(
    [t({}), t({ name: 't3_b', locked: true }), t({ name: 't3_c', over_18: true }), t({ name: 't3_d', created_utc: now / 1000 - 40 * 86400 }), t({ name: 't3_e' }), t({ name: 't1_x' })],
    new Set(['t3_e']),
    now,
  );
  assert.deepEqual(out.map((x) => x.id), ['t3_a']);
  assert.equal(out[0].url, 'https://www.reddit.com/r/s/comments/a/q/');
});

test('social agent: a post that is too long is rewritten, never cut', async () => {
  llmScript.push({ title: 'Launch', posts: ['x'.repeat(320)] }, { title: 'Launch', posts: ['We launched modular desk kits today. Built for small desks.'] });
  const before = seen.filter((s) => s.path === '/llm/v1/messages').length;
  const d = await agents.socialAgent.draft({ title: 'Launch day', reason: 'big news', kind: 'x_post', channel: 'x', format: 'post', author: 'brand' });
  assert.equal(d.body, 'We launched modular desk kits today. Built for small desks.');
  assert.match(d.meta.lengthNote, /fits/);
  const second = JSON.parse(seen.filter((s) => s.path === '/llm/v1/messages')[before + 1].body);
  assert.match(second.messages[0].content, /too long: post 1 is 320 characters; the limit is 280[\s\S]*Do not just cut/);
});

test('reddit agent: a business mention without a disclosure gets one; "nothing to add" writes nothing', async () => {
  routes['GET /ra/comments/abc.json'] = () => [200, [{}, { data: { children: [{ data: { body: 'Have you tried flashcards?' } }] } }]];
  routes['GET /ra/r/learnhebrew/about/rules.json'] = () => [200, { rules: [{ short_name: 'No spam', description: 'Disclose affiliation.' }] }];
  const opp = { title: 'How do I pass the theory test?', reason: 'r/learnhebrew: asks for help', kind: 'reddit_reply', thread: { id: 't3_abc', title: 'How do I pass the theory test?', text: 'Failed twice', subreddit: 'learnhebrew', url: 'https://www.reddit.com/r/learnhebrew/comments/abc/', comments: 1, createdUtc: 0 } };
  llmScript.push({ skip: false, skip_reason: '', reply: 'Practise with timed mock exams. Our course has those too.', mentions_business: true, has_disclosure: false });
  const d = await agents.redditAgent.draft(opp);
  assert.match(d.body, /mock exams[\s\S]*\(Disclosure: I work on acme\.example\.\)$/);
  assert.equal(d.meta.thingId, 't3_abc');
  const prompt = JSON.parse(seen.filter((s) => s.path === '/llm/v1/messages').at(-1).body).messages[0].content;
  assert.match(prompt, /<subreddit-rules>[\s\S]*Disclose affiliation/);
  assert.match(prompt, /Have you tried flashcards/);
  llmScript.push({ skip: true, skip_reason: 'already well answered', reply: '', mentions_business: false, has_disclosure: false });
  assert.equal(await agents.redditAgent.draft(opp), null);
});

test('X signature matches the worked example in X’s documentation', () => {
  const h = pub.oauth1Header(
    'POST',
    'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
    { apiKey: 'xvz1evFS4wEEPTGEFPHBog', apiSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', accessToken: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', accessSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE' },
    { nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: '1318622958', form: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' } },
  );
  assert.equal(decodeURIComponent(h.match(/oauth_signature="([^"]+)"/)[1]), 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
});
