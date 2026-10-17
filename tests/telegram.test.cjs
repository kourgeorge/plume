require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-telegram-'));
process.env.PLUME_SITE = 'test.example';
const t = require('../src/phone/telegram');
const q = require('../src/queue');
const integrations = require('../src/integrations');
require('../src/db').getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://acme.example', 'Acme', 'now')`).run();

// A fake Bot API: records every call, numbers messages.
const calls = [];
let nextId = 100;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const [, token, method] = req.url.match(/^\/bot([^/]+)\/(\w+)$/) || [];
    const b = body ? JSON.parse(body) : {};
    calls.push({ method, body: b });
    const ok = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
    if (token !== 'good-token') return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
    if (method === 'getMe') return ok({ username: 'acme_plume_bot' });
    if (method === 'sendMessage') return ok({ message_id: nextId++ });
    if (method === 'getUpdates') return ok([]);
    ok(true);
  });
});
const ENV = { TELEGRAM_BOT_TOKEN: 'good-token' };
const sentTexts = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text);
test.before(() => new Promise((r) => server.listen(0, '127.0.0.1', () => ((t.TELEGRAM_API.base = `http://127.0.0.1:${server.address().port}`), r()))));
test.after(() => server.close());

const msg = (chat, text, extra = {}) => ({ update_id: 1, message: { chat: { id: chat }, from: { first_name: 'Dana' }, text, ...extra } });
const tap = (chat, data, messageId = 1) => ({ update_id: 2, callback_query: { id: 'cb', data, message: { chat: { id: chat }, message_id: messageId } } });

test('the token test says plainly when Telegram refuses it', async () => {
  assert.match((await t.testTelegram({ TELEGRAM_BOT_TOKEN: 'wrong' })).message, /does not recognise this bot token/);
  assert.match((await t.testTelegram(ENV)).message, /@acme_plume_bot/);
  assert.match((await t.testTelegram({})).message, /No bot token saved/);
});

test('linking needs the one-time code; strangers are ignored', async () => {
  const code = t.telegramLink().code;
  assert.match(await t.handleUpdate(msg(555, '/start nope'), ENV), /isn't right/);
  assert.equal(t.telegramLink().chatId, null);
  assert.match(await t.handleUpdate(msg(555, '/start'), ENV), /send \/start followed by the link code/);
  assert.match(await t.handleUpdate(msg(42, `/start ${code}`), ENV), /Linked to Acme/);
  assert.equal(t.telegramLink().chatId, '42');
  assert.notEqual(t.telegramLink().code, code, 'a used code is replaced');
  // Someone else, even with the old code, gets nothing.
  assert.equal(await t.handleUpdate(msg(555, `/start ${code}`), ENV), "That link code isn't right. Copy it again from Plume's Settings.");
  assert.equal(await t.handleUpdate(msg(555, 'hello'), ENV), null);
  assert.equal(await t.handleUpdate(tap(555, 'a:1'), ENV), null);
});

test('only drafts made after linking are sent, each once, with buttons', async () => {
  // Made before linking: part of the backlog, not sent.
  const old = q.createDraft({ agent: 'social', kind: 'x_post', title: 'Old', body: 'old post', meta: {} });
  require('../src/db').getDb().prepare(`UPDATE drafts SET created_at = '2000-01-01' WHERE id = ?`).run(old.id);
  const d = q.createDraft({ agent: 'social', kind: 'x_post', title: 'Launch day', body: 'We launch <today> & tomorrow', meta: { reason: 'News' } });
  calls.length = 0;
  assert.equal(await t.sendNewDrafts(ENV), 1);
  assert.equal(await t.sendNewDrafts(ENV), 0, 'not sent twice');
  const sent = calls.find((c) => c.method === 'sendMessage').body;
  assert.equal(sent.chat_id, '42');
  assert.match(sent.text, /We launch &lt;today&gt; &amp; tomorrow/);
  assert.match(sent.text, /Approve saves it as files/);
  assert.deepEqual(sent.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`a:${d.id}`, `n:${d.id}`]);
});

test('a reply replaces the draft text; Approve publishes as the Today card would', async () => {
  const d = q.listDrafts({ status: 'draft' }).find((x) => x.title === 'Launch day');
  const row = require('../src/db').getDb().prepare('SELECT message_id FROM telegram_sent WHERE draft_id = ?').get(d.id);
  assert.equal(await t.handleUpdate(msg(42, 'Shorter: we launch today.', { reply_to_message: { message_id: row.message_id } }), ENV), `edited draft ${d.id}`);
  assert.equal(q.getDraft(d.id).body, 'Shorter: we launch today.');
  assert.match(await t.handleUpdate(tap(42, `a:${d.id}`), ENV), /Approved and saved as files/);
  assert.equal(q.getDraft(d.id).status, 'published');
  assert.equal(q.getDraft(d.id).target, 'export', 'X is not connected, so it is saved as files');
  assert.match(await t.handleUpdate(tap(42, `a:${d.id}`), ENV), /Already published/);
  assert.match(await t.handleUpdate(msg(42, 'too late', { reply_to_message: { message_id: row.message_id } }), ENV), /already published, so it can't be edited/);
});

test('Not useful turns a draft down and teaches the agent', async () => {
  const d = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'Meh post', body: '# Meh\n\ntext', meta: {} });
  assert.match(await t.handleUpdate(tap(42, `n:${d.id}`), ENV), /Marked not useful/);
  assert.equal(q.getDraft(d.id).status, 'rejected');
  assert.match(require('../src/feedback').feedbackNote('seo') ?? '', /Meh post/);
});

test('Approve goes to a connected place that fits the draft', () => {
  const d = q.createDraft({ agent: 'seo', kind: 'blog_post', title: 'Post', body: 'x', meta: {} });
  assert.equal(t.defaultTarget(d, { WP_URL: 'https://b.example', WP_USER: 'u', WP_APP_PASSWORD: 'p' }), 'wordpress');
  assert.equal(t.defaultTarget(q.createDraft({ agent: 'social', kind: 'x_post', title: 'x', body: 'x', meta: {} }), { WP_URL: 'https://b.example', WP_USER: 'u', WP_APP_PASSWORD: 'p' }), 'export', 'an X post never goes to WordPress');
});

test('weekly report: counts the week, sent once per week', async () => {
  const r = t.weeklyReport();
  assert.match(r, /Acme — the last 7 days/);
  assert.match(r, /approved/);
  assert.match(r, /waiting for you/);
  const monday = new Date(2026, 9, 19, 9);
  assert.equal(await t.sendWeeklyReport(ENV, monday), true);
  assert.equal(await t.sendWeeklyReport(ENV, monday), false);
});

test("another tool's TELEGRAM_BOT_TOKEN in the shell is never used", () => {
  assert.equal(integrations.siteEnv({ TELEGRAM_BOT_TOKEN: 'someone-elses-bot' }).TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(t.telegramToken(integrations.siteEnv({ TELEGRAM_BOT_TOKEN: 'someone-elses-bot', WP_URL: 'x' })), '');
});

test('the bot token is saved per website, under Phone approvals', () => {
  integrations.saveIntegration('telegram', { token: 'good-token' });
  assert.equal(integrations.siteEnv({ TELEGRAM_BOT_TOKEN: 'someone-elses-bot' }).TELEGRAM_BOT_TOKEN, 'good-token', 'the saved one wins');
  const card = integrations.describeIntegrations().find((i) => i.id === 'telegram');
  assert.equal(card.group, 'phone');
  assert.equal(card.fields[0].value, '', 'the token is never sent back to the page');
});
