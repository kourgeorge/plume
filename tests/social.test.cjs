require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// One fake server plays X (/x), LinkedIn (/li), Facebook (/fb), Reddit sign-in and public pages (/ra), Reddit API (/ro) and the AI gateway (/llm).
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
  for (const k of Object.keys(process.env)) if (/^(X_|LINKEDIN_|FACEBOOK_|REDDIT_)/.test(k)) delete process.env[k];
  text = require('../src/social/text');
  pub = require('../src/social/publishers');
  Object.assign(pub.SOCIAL_API, { x: `${base}/x`, linkedin: `${base}/li`, facebook: `${base}/fb`, rupload: `${base}/ru`, redditAuth: `${base}/ra`, reddit: `${base}/ro` });
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
const FB_ENV = { FACEBOOK_PAGE_ID: '1234567890', FACEBOOK_PAGE_TOKEN: 'fb-token' };
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

test('Facebook: posts plain text to the page feed; expired tokens and bad page IDs come back in plain words', async () => {
  routes['POST /fb/v23.0/1234567890/feed'] = () => [200, { id: '1234567890_555' }];
  const r = await pub.facebookPublisher.publish(draft({ kind: 'facebook_post', body: 'Open **today** [menu](https://acme.example/menu)' }), '', FB_ENV);
  assert.equal(r.url, 'https://www.facebook.com/1234567890_555');
  assert.equal(r.externalId, '1234567890_555');
  const sent = seen.filter((s) => s.path === '/fb/v23.0/1234567890/feed').at(-1);
  assert.equal(new URLSearchParams(sent.body).get('message'), 'Open today menu https://acme.example/menu');
  assert.equal(sent.headers.authorization, 'Bearer fb-token');
  routes['POST /fb/v23.0/1234567890/feed'] = () => [400, { error: { code: 190, message: 'Session has expired' } }];
  await assert.rejects(pub.facebookPublisher.publish(draft({ kind: 'facebook_post', body: 'x' }), '', FB_ENV), /may have expired[\s\S]*Page token/);
  routes['POST /fb/v23.0/1234567890/feed'] = () => [403, { error: { code: 200, message: 'Permissions error' } }];
  await assert.rejects(pub.facebookPublisher.publish(draft({ kind: 'facebook_post', body: 'x' }), '', FB_ENV), /pages_manage_posts/);
  const before = seen.length;
  await assert.rejects(pub.facebookPublisher.publish(draft({ kind: 'facebook_post', body: 'x' }), '', { ...FB_ENV, FACEBOOK_PAGE_ID: 'acme' }), /not a Facebook Page ID/);
  assert.equal(seen.length, before, 'nothing should be sent with a bad page ID');
  routes['GET /fb/v23.0/1234567890'] = () => [200, { name: 'Acme Desks', id: '1234567890' }];
  assert.deepEqual(await pub.testSocial('facebook', FB_ENV), { ok: true, message: 'Will post to the page "Acme Desks". Posting permission is only checked on the first post.' });
  assert.match(seen.at(-1).query, /fields=name/);
});

test('Facebook takes Facebook and general social posts only; the agent writes for it only once a page is connected', () => {
  assert.deepEqual(publish.targetsFor('facebook_post'), ['facebook', 'export']);
  assert.ok(publish.targetsFor('social_post').includes('facebook'));
  assert.ok(!publish.targetsFor('blog_post').includes('facebook'));
  assert.throws(() => publish.checkTarget('x_post', 'facebook'), /Facebook Page can't take a social post/);
  assert.deepEqual(agents.socialChannels({}), ['x', 'linkedin']);
  assert.deepEqual(agents.socialChannels(FB_ENV), ['facebook']);
  assert.deepEqual(agents.socialChannels({ ...FB_ENV, ...LI_ENV }), ['linkedin', 'facebook']);
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

test('social agent: Facebook ideas become Facebook posts written as the brand', async () => {
  for (const k of Object.keys(FB_ENV)) process.env[k] = FB_ENV[k];
  require('../src/context/extra').savePerson({ name: 'Dana Levi', role: 'Founder' });
  try {
    llmScript.push({ ideas: [{ channel: 'facebook', format: 'post', angle: 'Weekend opening hours', reason: 'holiday', author: 'Dana Levi' }] });
    const [opp] = await agents.socialAgent.findOpportunities({ limit: 1 });
    assert.equal(opp.kind, 'facebook_post');
    assert.equal(opp.author, 'brand', 'a Page posts as itself');
    const ideas = JSON.parse(seen.filter((s) => s.path === '/llm/v1/messages').at(-1).body);
    assert.match(ideas.messages[0].content, /social posts for Facebook,/);
    llmScript.push({ title: 'Hours', posts: ['We are open this Saturday, 9 to 2.'] });
    const d = await agents.socialAgent.draft(opp);
    assert.equal(d.kind, 'facebook_post');
    assert.equal(d.meta.channel, 'facebook');
    const prompt = JSON.parse(seen.filter((s) => s.path === '/llm/v1/messages').at(-1).body).messages[0].content;
    assert.match(prompt, /One Facebook Page post/);
  } finally {
    for (const k of Object.keys(FB_ENV)) delete process.env[k];
  }
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

// ---- Reels: the owner's filmed video goes to Facebook and Instagram

function reelDraft(caption = 'Pass first time.\n\n#theorytest') {
  const d = q.createDraft({ agent: 'video', kind: 'video_script', title: 'Reel', body: `# Reel\n\n## Scene 1 — 3s\n- **On screen:** Hi\n\n## Caption\n${caption}\n`, meta: {} });
  return d;
}
const video = () => require('../src/video/agent');
function addFootage(d, bytes = 'fake-mp4-bytes') {
  fs.mkdirSync(video().videoDir(d.id), { recursive: true });
  fs.writeFileSync(video().footagePath(d.id), bytes);
}

test('Reels need the uploaded video, never the preview', async () => {
  const d = reelDraft();
  const before = seen.length;
  await assert.rejects(pub.facebookReelPublisher.publish(d, '', FB_ENV), /Upload your filmed video/);
  await assert.rejects(pub.instagramReelPublisher.publish(d, '', FB_ENV), /Upload your filmed video/);
  await assert.rejects(pub.facebookReelPublisher.publish(draft({ kind: 'facebook_post' }), '', FB_ENV), /only a video script/);
  assert.equal(seen.length, before, 'nothing should be sent without a video');
});

test('Facebook Reel: start, upload the bytes, finish with the caption', async () => {
  const d = reelDraft('Pass **first** time.\n\n#theorytest');
  addFootage(d);
  routes['POST /fb/v23.0/1234567890/video_reels'] = (body) => (new URLSearchParams(body).get('upload_phase') === 'start' ? [200, { video_id: '777', upload_url: 'x' }] : [200, { success: true }]);
  routes['POST /ru/video-upload/v23.0/777'] = () => [200, { success: true }];
  const from = seen.length;
  const r = await pub.facebookReelPublisher.publish(d, '', FB_ENV);
  assert.deepEqual(r, { url: 'https://www.facebook.com/reel/777', externalId: '777', dryRun: false });
  const calls = seen.slice(from);
  assert.deepEqual(calls.map((c) => c.path), ['/fb/v23.0/1234567890/video_reels', '/ru/video-upload/v23.0/777', '/fb/v23.0/1234567890/video_reels']);
  assert.equal(calls[1].body, 'fake-mp4-bytes');
  assert.equal(calls[1].headers.authorization, 'OAuth fb-token');
  assert.equal(calls[1].headers.file_size, String('fake-mp4-bytes'.length));
  const fin = new URLSearchParams(calls[2].body);
  assert.equal(fin.get('upload_phase'), 'finish');
  assert.equal(fin.get('video_state'), 'PUBLISHED');
  assert.equal(fin.get('description'), 'Pass first time.\n\n#theorytest');
  routes['POST /ru/video-upload/v23.0/777'] = () => [400, { debug_info: { message: 'bad file' } }];
  await assert.rejects(pub.facebookReelPublisher.publish(d, '', FB_ENV), /did not accept the video upload[\s\S]*bad file/);
});

test('Instagram Reel: finds the account, uploads, waits until processed, publishes and links it', async () => {
  pub.resetInstagramForTests();
  Object.assign(pub.INSTAGRAM_WAIT, { everyMs: 5, maxMs: 2000 });
  const d = reelDraft();
  addFootage(d);
  routes['GET /fb/v23.0/1234567890'] = (_b, req) => (req.url.includes('instagram_business_account') ? [200, { instagram_business_account: { id: '17841400000' } }] : [200, { name: 'Acme Desks' }]);
  routes['POST /fb/v23.0/17841400000/media'] = () => [200, { id: '9001' }];
  routes['POST /ru/ig-api-upload/v23.0/9001'] = () => [200, { success: true }];
  const states = ['IN_PROGRESS', 'FINISHED'];
  routes['GET /fb/v23.0/9001'] = () => [200, { status_code: states.shift() ?? 'FINISHED' }];
  routes['POST /fb/v23.0/17841400000/media_publish'] = () => [200, { id: '1800' }];
  routes['GET /fb/v23.0/1800'] = () => [200, { permalink: 'https://www.instagram.com/reel/abc/' }];
  const from = seen.length;
  const r = await pub.instagramReelPublisher.publish(d, '', FB_ENV);
  assert.deepEqual(r, { url: 'https://www.instagram.com/reel/abc/', externalId: '1800', dryRun: false });
  const calls = seen.slice(from);
  const box = new URLSearchParams(calls.find((c) => c.path.endsWith('/media')).body);
  assert.deepEqual([box.get('media_type'), box.get('upload_type'), box.get('caption')], ['REELS', 'resumable', 'Pass first time.\n\n#theorytest']);
  assert.equal(calls.filter((c) => c.path === '/fb/v23.0/9001').length, 2, 'checked until it was ready');
  assert.equal(new URLSearchParams(calls.find((c) => c.path.endsWith('/media_publish')).body).get('creation_id'), '9001');

  // The account is remembered; a typed ID skips the lookup.
  const n = seen.length;
  routes['GET /fb/v23.0/17841400000'] = () => [200, { username: 'acmedesks' }];
  assert.match((await pub.testSocial('instagram', FB_ENV)).message, /@acmedesks/);
  assert.ok(!seen.slice(n).some((c) => c.query.includes('instagram_business_account')));
  assert.equal(await pub.instagramAccount({ ...FB_ENV, INSTAGRAM_ACCOUNT_ID: '17841499999' }), '17841499999');
  await assert.rejects(pub.instagramAccount({ ...FB_ENV, INSTAGRAM_ACCOUNT_ID: '@acme' }), /not an Instagram account ID/);

  routes['GET /fb/v23.0/9001'] = () => [200, { status_code: 'ERROR', status: 'Unsupported format' }];
  await assert.rejects(pub.instagramReelPublisher.publish(d, '', FB_ENV), /could not use this video \(Unsupported format\)/);

  pub.resetInstagramForTests();
  routes['GET /fb/v23.0/1234567890'] = () => [200, { id: '1234567890' }];
  await assert.rejects(pub.instagramReelPublisher.publish(d, '', FB_ENV), /No Instagram account is linked/);
});

test('Instagram captions: 2,200 characters and 30 hashtags at most, checked before uploading', async () => {
  assert.deepEqual(pub.instagramCaptionProblems('fine #a #b'), []);
  assert.match(pub.instagramCaptionProblems('x'.repeat(2201))[0], /2201 characters/);
  assert.match(pub.instagramCaptionProblems(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '))[0], /31 hashtags/);
  const d = reelDraft('x'.repeat(2300));
  addFootage(d);
  const before = seen.length;
  await assert.rejects(pub.instagramReelPublisher.publish(d, '', FB_ENV), /too long to publish/);
  assert.equal(seen.length, before);
});

// ---- photos on posts

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest-of-jpg')]);
function photoDraft(kind, body, files = [PNG, JPG]) {
  const images = require('../src/social/images');
  const d = q.createDraft({ agent: 'social', kind, title: 'p', body, meta: {} });
  fs.mkdirSync(images.imageDir(d.id), { recursive: true });
  for (const f of files) {
    const part = path.join(images.imageDir(d.id), `t-${Math.random()}.part`);
    fs.writeFileSync(part, f);
    images.addImage(d.id, part);
  }
  return d;
}

test('photos: checked by their content, numbered in order, at most 4 and 5 MB', () => {
  const images = require('../src/social/images');
  assert.equal(images.sniffImage(PNG), 'png');
  assert.equal(images.sniffImage(JPG), 'jpg');
  assert.equal(images.sniffImage(Buffer.from('GIF89a....')), 'gif');
  assert.equal(images.sniffImage(Buffer.from('<html>hi</html>')), null);
  const d = photoDraft('facebook_post', 'x');
  assert.deepEqual(images.listImages(d.id).map((i) => i.name), ['1.png', '2.jpg']);
  const add = (buf) => {
    const part = path.join(images.imageDir(d.id), `t-${Math.random()}.part`);
    fs.writeFileSync(part, buf);
    return () => images.addImage(d.id, part);
  };
  assert.throws(add(Buffer.from('not a photo')), /not a JPG, PNG or GIF/);
  assert.throws(add(Buffer.concat([JPG, Buffer.alloc(5 * 1024 * 1024)])), /up to 5 MB/);
  add(PNG)();
  add(PNG)();
  assert.throws(add(PNG), /at most 4 photos/);
  images.removeImage(d.id, '1.png');
  assert.deepEqual(images.listImages(d.id).map((i) => i.name), ['2.jpg', '3.png', '4.png']);
  assert.ok(!fs.readdirSync(images.imageDir(d.id)).some((f) => f.endsWith('.part')), 'refused uploads are cleaned up');
  assert.throws(() => images.removeImage(d.id, '../x'), /no such photo/);
});

test('Facebook: photos are uploaded unpublished, then attached to one post', async () => {
  const d = photoDraft('facebook_post', 'Look at this');
  let n = 0;
  routes['POST /fb/v23.0/1234567890/photos'] = () => [200, { id: `ph${++n}` }];
  routes['POST /fb/v23.0/1234567890/feed'] = () => [200, { id: '1234567890_777' }];
  const from = seen.length;
  const r = await pub.facebookPublisher.publish(d, '', FB_ENV);
  assert.equal(r.url, 'https://www.facebook.com/1234567890_777');
  const ups = seen.slice(from).filter((c) => c.path.endsWith('/photos'));
  assert.equal(ups.length, 2);
  assert.match(ups[0].headers['content-type'], /multipart\/form-data/);
  assert.match(ups[0].body, /name="published"\r\n\r\nfalse/);
  const feed = new URLSearchParams(seen.slice(from).find((c) => c.path.endsWith('/feed')).body);
  assert.equal(feed.get('message'), 'Look at this');
  assert.equal(feed.get('attached_media[0]'), '{"media_fbid":"ph1"}');
  assert.equal(feed.get('attached_media[1]'), '{"media_fbid":"ph2"}');
});

test('X: photos are uploaded and go on the first post of a thread only', async () => {
  const d = photoDraft('x_thread', 'One\n\n---\n\nTwo');
  let m = 0;
  routes['POST /x/2/media/upload'] = () => [200, { data: { id: `m${++m}` } }];
  let t = 0;
  routes['POST /x/2/tweets'] = () => [201, { data: { id: `t${++t}` } }];
  const from = seen.length;
  await pub.xPublisher.publish(d, '', X_ENV);
  const calls = seen.slice(from);
  const ups = calls.filter((c) => c.path === '/x/2/media/upload');
  assert.equal(ups.length, 2);
  assert.match(ups[0].headers.authorization, /^OAuth /);
  assert.match(ups[0].body, /name="media_category"\r\n\r\ntweet_image/);
  const tweets = calls.filter((c) => c.path === '/x/2/tweets').map((c) => JSON.parse(c.body));
  assert.deepEqual(tweets[0].media, { media_ids: ['m1', 'm2'] });
  assert.equal(tweets[1].media, undefined);
});

test('LinkedIn: one photo is a media post, several are a multi-photo post', async () => {
  routes['GET /li/v2/userinfo'] = () => [200, { sub: 'abc' }];
  let i = 0;
  routes['POST /li/rest/images'] = () => [200, { value: { uploadUrl: `${base}/li/up/${++i}`, image: `urn:li:image:${i}` } }];
  routes['PUT /li/up/1'] = routes['PUT /li/up/2'] = routes['PUT /li/up/3'] = () => [201, {}];
  routes['POST /li/rest/posts'] = () => [201, {}, { 'x-restli-id': 'urn:li:share:1' }];
  const from = seen.length;
  await pub.linkedinPublisher.publish(photoDraft('linkedin_post', 'Hi', [PNG]), '', LI_ENV);
  let post = JSON.parse(seen.slice(from).find((c) => c.path === '/li/rest/posts').body);
  assert.deepEqual(post.content, { media: { id: 'urn:li:image:1' } });
  const init = JSON.parse(seen.slice(from).find((c) => c.path === '/li/rest/images').body);
  assert.deepEqual(init, { initializeUploadRequest: { owner: 'urn:li:person:abc' } });
  assert.equal(seen.slice(from).find((c) => c.path === '/li/up/1').headers['content-type'], 'image/png');
  const from2 = seen.length;
  await pub.linkedinPublisher.publish(photoDraft('linkedin_post', 'Hi'), '', LI_ENV);
  post = JSON.parse(seen.slice(from2).find((c) => c.path === '/li/rest/posts').body);
  assert.deepEqual(post.content, { multiImage: { images: [{ id: 'urn:li:image:2' }, { id: 'urn:li:image:3' }] } });
});

test('photo upload route: added, served, refused for articles and approved posts, removed', async () => {
  const { buildServer } = require('../src/server');
  const app = buildServer(4497);
  const H = { host: '127.0.0.1:4497', 'x-plume-site': 'test.example' };
  const d = q.createDraft({ agent: 'social', kind: 'facebook_post', title: 'p', body: 'x', meta: {} });
  let r = await app.inject({ method: 'POST', url: `/api/drafts/${d.id}/images`, headers: { ...H, 'content-type': 'image/png' }, payload: PNG });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().images.map((i) => i.name), ['1.png']);
  r = await app.inject({ url: `/api/drafts/${d.id}/images/1.png`, headers: H });
  assert.equal(r.headers['content-type'], 'image/png');
  assert.ok(Buffer.from(r.rawPayload).equals(PNG));
  r = await app.inject({ method: 'POST', url: `/api/drafts/${d.id}/images`, headers: { ...H, 'content-type': 'image/png' }, payload: Buffer.from('<svg/>') });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /not a JPG, PNG or GIF/);
  const article = q.createDraft({ agent: 'writer', kind: 'blog_post', title: 'a', body: 'x', meta: {} });
  // An article takes one picture for its top, and never a video.
  r = await app.inject({ method: 'POST', url: `/api/drafts/${article.id}/images`, headers: { ...H, 'content-type': 'image/png' }, payload: PNG });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: 'POST', url: `/api/drafts/${article.id}/images`, headers: { ...H, 'content-type': 'image/png' }, payload: PNG });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /one picture/);
  r = await app.inject({ method: 'POST', url: `/api/drafts/${article.id}/video`, headers: { ...H, 'content-type': 'video/mp4' }, payload: PNG });
  assert.equal(r.statusCode, 404);
  r = await app.inject({ method: 'DELETE', url: `/api/drafts/${d.id}/images/1.png`, headers: H });
  assert.deepEqual(r.json().images, []);
  q.moveDraft(d.id, 'approved', { target: 'facebook' });
  r = await app.inject({ method: 'POST', url: `/api/drafts/${d.id}/images`, headers: { ...H, 'content-type': 'image/png' }, payload: PNG });
  assert.equal(r.statusCode, 409);
  await app.close();
});

// ---- a video on a post

// A tiny file that starts like a real MP4 ("ftyp" box, "isom" brand), 10 bytes of video data after it.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from('0123456789')]);
function videoPostDraft(kind, body, bytes = MP4) {
  const images = require('../src/social/images');
  const d = q.createDraft({ agent: 'social', kind, title: 'Video post', body, meta: {} });
  fs.mkdirSync(images.imageDir(d.id), { recursive: true });
  const part = path.join(images.imageDir(d.id), `t-${Math.random()}.part`);
  fs.writeFileSync(part, bytes);
  images.addVideo(d.id, part);
  return d;
}

test('post video: checked by content, one per post, never together with photos', () => {
  const images = require('../src/social/images');
  assert.equal(images.sniffVideo(MP4), 'mp4');
  assert.equal(images.sniffVideo(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(8)])), 'mov');
  assert.equal(images.sniffVideo(PNG), null);
  const d = videoPostDraft('facebook_post', 'x');
  assert.equal(images.postVideo(d.id).name, 'video.mp4');
  const part = (buf) => {
    const p = path.join(images.imageDir(d.id), `t-${Math.random()}.part`);
    fs.writeFileSync(p, buf);
    return p;
  };
  assert.throws(() => images.addImage(d.id, part(PNG)), /photos or one video, not both/);
  assert.throws(() => images.addVideo(d.id, part(PNG)), /not an MP4 or MOV/);
  images.addVideo(d.id, part(MP4));
  assert.equal(fs.readdirSync(images.imageDir(d.id)).filter((f) => f.startsWith('video.')).length, 1, 'a new video replaces the old one');
  images.removeVideo(d.id);
  assert.equal(images.postVideo(d.id), null);
  const withPhoto = photoDraft('facebook_post', 'x', [PNG]);
  assert.throws(() => images.addVideo(withPhoto.id, path.join(os.tmpdir(), 'nope')), /ENOENT|no such file/);
  const p2 = path.join(images.imageDir(withPhoto.id), 'v.part');
  fs.writeFileSync(p2, MP4);
  assert.throws(() => images.addVideo(withPhoto.id, p2), /Remove the photos first/);
});

test('Facebook: a video post is sent in pieces with the text as its description', async () => {
  const d = videoPostDraft('facebook_post', 'Watch **this**');
  const half = Math.ceil(MP4.length / 2);
  let transfers = 0;
  routes['POST /fb/v23.0/1234567890/videos'] = (body, req) => {
    if (/multipart/.test(req.headers['content-type'])) {
      transfers++;
      return transfers === 1 ? [200, { start_offset: String(half), end_offset: String(MP4.length) }] : [200, { start_offset: String(MP4.length), end_offset: String(MP4.length) }];
    }
    const f = new URLSearchParams(body);
    if (f.get('upload_phase') === 'start') return [200, { upload_session_id: 's1', video_id: 'v9', start_offset: '0', end_offset: String(half) }];
    return [200, { success: true }];
  };
  const from = seen.length;
  const r = await pub.facebookPublisher.publish(d, '', FB_ENV);
  assert.deepEqual(r, { url: 'https://www.facebook.com/1234567890/videos/v9', externalId: 'v9', dryRun: false });
  const calls = seen.slice(from).filter((c) => c.path.endsWith('/videos'));
  assert.equal(new URLSearchParams(calls[0].body).get('file_size'), String(MP4.length));
  assert.equal(transfers, 2);
  assert.match(calls[1].body, /name="start_offset"\r\n\r\n0\r\n/);
  assert.match(calls[2].body, new RegExp(`name="start_offset"\\r\\n\\r\\n${half}\\r\\n`));
  const fin = new URLSearchParams(calls.at(-1).body);
  assert.deepEqual([fin.get('upload_phase'), fin.get('upload_session_id'), fin.get('description')], ['finish', 's1', 'Watch this']);
  assert.ok(!seen.slice(from).some((c) => c.path.endsWith('/feed')), 'a video post is not a feed post');
});

test('X: a video is sent in pieces, X is asked until it is ready, then it goes on the first post', async () => {
  Object.assign(pub.VIDEO_WAIT, { everyMs: 5, maxMs: 2000, longestMs: 5 });
  const d = videoPostDraft('x_post', 'Clip');
  routes['POST /x/2/media/upload/initialize'] = () => [200, { data: { id: 'vid1' } }];
  routes['POST /x/2/media/upload/vid1/append'] = () => [200, {}];
  routes['POST /x/2/media/upload/vid1/finalize'] = () => [200, { data: { id: 'vid1', processing_info: { state: 'pending', check_after_secs: 1 } } }];
  const states = ['in_progress', 'succeeded'];
  routes['GET /x/2/media/upload'] = () => [200, { data: { id: 'vid1', processing_info: { state: states.shift() ?? 'succeeded' } } }];
  routes['POST /x/2/tweets'] = () => [201, { data: { id: 'tv' } }];
  const from = seen.length;
  await pub.xPublisher.publish(d, '', X_ENV);
  const calls = seen.slice(from);
  const init = JSON.parse(calls.find((c) => c.path.endsWith('/initialize')).body);
  assert.deepEqual(init, { media_type: 'video/mp4', total_bytes: MP4.length, media_category: 'tweet_video' });
  assert.match(calls.find((c) => c.path.endsWith('/append')).body, /name="segment_index"\r\n\r\n0/);
  assert.equal(calls.filter((c) => c.path === '/x/2/media/upload').length, 2, 'asked until it was ready');
  assert.deepEqual(JSON.parse(calls.find((c) => c.path === '/x/2/tweets').body).media, { media_ids: ['vid1'] });
  routes['GET /x/2/media/upload'] = () => [200, { data: { processing_info: { state: 'failed', error: { message: 'bad codec' } } } }];
  await assert.rejects(pub.xPublisher.publish(d, '', X_ENV), /could not use this video \(bad codec\)/);
});

test('LinkedIn: a video is uploaded in the parts LinkedIn asks for, finished, and posted once ready', async () => {
  routes['GET /li/v2/userinfo'] = () => [200, { sub: 'abc' }];
  const d = videoPostDraft('linkedin_post', 'Our clip');
  const cut = 9;
  routes['POST /li/rest/videos'] = (body, req) =>
    req.url.includes('initializeUpload')
      ? [200, { value: { video: 'urn:li:video:V1', uploadToken: 'tok', uploadInstructions: [{ uploadUrl: `${base}/li/vup/1`, firstByte: 0, lastByte: cut - 1 }, { uploadUrl: `${base}/li/vup/2`, firstByte: cut, lastByte: MP4.length - 1 }] } }]
      : [200, {}];
  routes['PUT /li/vup/1'] = () => [200, {}, { etag: 'e1' }];
  routes['PUT /li/vup/2'] = () => [200, {}, { etag: 'e2' }];
  const states = ['PROCESSING', 'AVAILABLE'];
  routes[`GET /li/rest/videos/${encodeURIComponent('urn:li:video:V1')}`] = () => [200, { status: states.shift() ?? 'AVAILABLE' }];
  routes['POST /li/rest/posts'] = () => [201, {}, { 'x-restli-id': 'urn:li:share:9' }];
  const from = seen.length;
  const r = await pub.linkedinPublisher.publish(d, '', LI_ENV);
  assert.equal(r.url, 'https://www.linkedin.com/feed/update/urn:li:share:9');
  const calls = seen.slice(from);
  assert.equal(calls.find((c) => c.path === '/li/vup/1').body, MP4.subarray(0, cut).toString());
  assert.equal(calls.find((c) => c.path === '/li/vup/2').body, MP4.subarray(cut).toString());
  const fin = JSON.parse(calls.find((c) => c.path === '/li/rest/videos' && c.query.includes('finalizeUpload')).body);
  assert.deepEqual(fin, { finalizeUploadRequest: { video: 'urn:li:video:V1', uploadToken: 'tok', uploadedPartIds: ['e1', 'e2'] } });
  assert.deepEqual(JSON.parse(calls.find((c) => c.path === '/li/rest/posts').body).content, { media: { id: 'urn:li:video:V1', title: 'Video post' } });
});

test('post video route: added, played back with byte ranges, refused next to photos, removed', async () => {
  const { buildServer } = require('../src/server');
  const app = buildServer(4496);
  const H = { host: '127.0.0.1:4496', 'x-plume-site': 'test.example' };
  const d = q.createDraft({ agent: 'social', kind: 'linkedin_post', title: 'p', body: 'x', meta: {} });
  let r = await app.inject({ method: 'POST', url: `/api/drafts/${d.id}/video`, headers: { ...H, 'content-type': 'video/mp4' }, payload: MP4 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().video.name, 'video.mp4');
  r = await app.inject({ url: `/api/drafts/${d.id}/video`, headers: { ...H, range: 'bytes=0-3' } });
  assert.equal(r.statusCode, 206);
  assert.equal(r.headers['content-type'], 'video/mp4');
  assert.ok(Buffer.from(r.rawPayload).equals(MP4.subarray(0, 4)));
  r = await app.inject({ method: 'POST', url: `/api/drafts/${d.id}/images`, headers: { ...H, 'content-type': 'image/png' }, payload: PNG });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /not both/);
  r = await app.inject({ method: 'DELETE', url: `/api/drafts/${d.id}/video`, headers: H });
  assert.equal(r.json().video, null);
  r = await app.inject({ url: `/api/drafts/${d.id}/images`, headers: H });
  const { canMake, ...rest } = r.json();
  assert.deepEqual(rest, { images: [], video: null, credits: [], note: null });
  assert.equal(typeof canMake, 'boolean');
  await app.close();
});
