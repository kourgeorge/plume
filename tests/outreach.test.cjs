require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-outreach-'));
process.env.PLUME_SITE = 'test.example';
const store = require('../src/outreach/store');
const email = require('../src/outreach/email');
const creators = require('../src/outreach/creators');
const links = require('../src/outreach/links');
const video = require('../src/video/agent');
const q = require('../src/queue');
const runner = require('../src/publish/runner');
const publish = require('../src/publish');
require('../src/db').getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://www.acme.example', 'Acme', 'now')`).run();

const SMTP = { SMTP_HOST: 'smtp.test', SMTP_USER: 'me', SMTP_PASSWORD: 'pw', SMTP_FROM: 'Dana <dana@acme.example>' };
const sent = [];
email.setTransportForTests({ sendMail: async (m) => (sent.push(m), { messageId: `<m${sent.length}@test>` }), verify: async () => true });

test('contacts: addresses cleaned, duplicates refused, bad email refused, steps checked', () => {
  const c = store.addContact({ kind: 'creator', name: 'Road Ready', url: 'https://www.YouTube.com/@RoadReady/?utm_source=x', email: 'Hi@RoadReady.example', emailVerified: true });
  assert.equal(c.url, 'https://youtube.com/@RoadReady');
  assert.equal(c.email, 'hi@roadready.example');
  // The same channel written three ways is one creator.
  assert.equal(store.addContact({ kind: 'creator', name: 'dup', url: 'youtube.com/@RoadReady' }), null);
  assert.equal(store.addContact({ kind: 'creator', name: 'dup', url: 'http://www.youtube.com/@RoadReady/' }), null);
  assert.equal(store.listContacts('creator').length, 1);
  assert.throws(() => store.addContact({ kind: 'creator', name: 'x', url: 'https://a.example', email: 'not-an-email' }), /not an email address/);
  assert.throws(() => store.updateContact(c.id, { status: 'linked' }), /not a step for this contact/);
  assert.equal(store.updateContact(c.id, { status: 'agreed', rate: '$200 per video' }).rate, '$200 per video');
});

test('emails on a page: mailto and written addresses, junk skipped, "[at]" understood', () => {
  const html = `<a href="mailto:Collab@Creator.example?subject=hi">mail</a><p>Business: hello [at] creator.example</p><img src="logo@2x.png"><p>noreply@creator.example</p>`;
  assert.deepEqual(creators.emailsOnPage(html), ['collab@creator.example', 'hello@creator.example']);
});

test('pages are read from the address as found, not the cleaned one used to spot duplicates', async () => {
  // This site only answers on http://www. — the cleaned https address would not load.
  const fetchFn = async (u) =>
    String(u).startsWith('http://www.plain.example/')
      ? new Response('<html><body><p>Write to me: me@plain.example</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      : new Response('no', { status: 404, headers: { 'content-type': 'text/html' } });
  assert.deepEqual(await creators.findEmail(['http://www.plain.example/about-me'], fetchFn), { email: 'me@plain.example', source: 'http://www.plain.example/about-me' });
  assert.equal(store.absUrl('plain.example/x'), 'https://plain.example/x');
});

test('link pages: qualify only when they name us without linking, or link competitors and not us', () => {
  const comps = [{ name: 'Rival', host: 'rival.example' }];
  const names = ['acme.example', 'acme'];
  const check = (body, url = 'https://blog.example/best') => links.checkLinkPage(`<html><head><title>Best tools</title></head><body>${body}</body></html>`, url, 'www.acme.example', comps, names);
  assert.equal(check('<p>We love Acme for this.</p>').opportunity, 'unlinked-mention');
  // "acme-widgets.com" is written "Acme Widgets" in prose.
  require('../src/db').getGlobalDb().prepare(`UPDATE sites SET url = 'https://acme-widgets.example', name = 'test.example' WHERE slug = 'test.example'`).run();
  assert.ok(require('../src/geo/visibility').brandNames().includes('acme widgets'));
  assert.equal(links.checkLinkPage('<p>Try Acme Widgets.</p>', 'https://b.example/x', 'acme-widgets.example', comps, require('../src/geo/visibility').brandNames()).opportunity, 'unlinked-mention');
  require('../src/db').getGlobalDb().prepare(`UPDATE sites SET url = 'https://www.acme.example', name = 'Acme' WHERE slug = 'test.example'`).run();
  assert.equal(check('<a href="https://rival.example/">Rival</a>').opportunity, 'lists-competitors');
  assert.deepEqual(check('<a href="https://rival.example/">Rival</a>').competitorsLinked, ['Rival']);
  assert.match(check('<p>Acme</p><a href="https://acme.example/">site</a>').reason, /already links to you/);
  assert.match(check('<p>Nothing relevant</p>').reason, /neither names you/);
  assert.match(check('<p>Acme</p>', 'https://rival.example/blog').reason, /competitor's site/);
  assert.match(check('<p>Acme</p>', 'https://acme.example/blog').reason, /your own site/);
});

const emailDraft = (to, o = {}) => q.createDraft({ agent: 'influencer', kind: 'outreach_email', title: `To ${to}`, body: 'Hi, would you review our course?', meta: { to, subject: 'Course review?', ...o } });
const approveSend = async (d, env = SMTP) => (q.moveDraft(d.id, 'approved', { target: 'email' }), runner.publishOne(d.id, env));

test('email: sent with an opt-out line, recorded on the contact', async () => {
  const c = store.listContacts('creator').find((x) => x.name === 'Road Ready');
  const d = await approveSend(emailDraft(c.email, { contactId: c.id }));
  assert.equal(d.status, 'published');
  assert.equal(sent.at(-1).to, 'hi@roadready.example');
  assert.match(sent.at(-1).text, /review our course\?\n\nIf you would rather not hear from me again/);
  assert.ok(store.getContact(c.id).lastEmailedAt);
});

test('email: never twice in 30 days, never to someone who declined, never to an unchecked address', async () => {
  const c = store.listContacts('creator').find((x) => x.name === 'Road Ready');
  const again = await approveSend(emailDraft(c.email, { contactId: c.id }));
  assert.equal(again.status, 'failed');
  assert.match(again.error, /already emailed .* in the last 30 days/);
  const no = store.addContact({ kind: 'link', name: 'Blog', url: 'https://blog.example/a', email: 'ed@blog.example', emailVerified: true });
  store.updateContact(no.id, { status: 'declined' });
  assert.match((await approveSend(emailDraft('ed@blog.example', { contactId: no.id }))).error, /said no before/);
  const guessed = store.addContact({ kind: 'creator', name: 'G', url: 'https://g.example', email: 'g@g.example', emailVerified: false });
  assert.match((await approveSend(emailDraft('g@g.example', { contactId: guessed.id }))).error, /didn't see g@g\.example on their own page/);
  assert.match((await approveSend(emailDraft('nobody'))).error, /no valid address/);
});

test('email: the daily limit holds extra approved emails until another day', async () => {
  const before = email.emailsSentToday();
  const env = { ...SMTP, SMTP_DAILY_LIMIT: String(before + 1) };
  const a = emailDraft('one@a.example');
  const b = emailDraft('two@b.example');
  for (const d of [a, b]) q.moveDraft(d.id, 'approved', { target: 'email' });
  await runner.publishDue(env);
  assert.deepEqual([q.getDraft(a.id).status, q.getDraft(b.id).status], ['published', 'approved']);
  await runner.publishDue(env, new Date(Date.now() + 86400e3));
  assert.equal(q.getDraft(b.id).status, 'published');
  assert.equal(email.emailDailyLimit({ SMTP_DAILY_LIMIT: '9999' }), 10, 'silly limits fall back to 10');
});

test('outreach messages and scripts go only where they belong', () => {
  assert.deepEqual(publish.targetsFor('outreach_email'), ['email', 'export']);
  assert.throws(() => publish.checkTarget('outreach_email', 'wordpress'), /can't take an outreach message/);
  assert.throws(() => publish.checkTarget('video_script', 'x'), /can't take a video script/);
  assert.ok(!publish.targetsFor('blog_post').includes('email'), 'articles must never be emailed out');
});

test('video scripts: Markdown round-trips, edits are honoured, colours come from the design guide', () => {
  const s = { hook: 'Failed twice?', scenes: [{ seconds: 3, shot: 'Close-up of a worried learner', onScreen: 'Failed the theory test twice?', voiceover: 'Sound familiar?' }, { seconds: 4, shot: 'Phone with app', onScreen: 'Practise with real exam questions', voiceover: 'Try this.' }], caption: 'Pass first time.', hashtags: ['theorytest', '#learner'] };
  const md = video.scriptToMarkdown('Pass first time', s);
  assert.match(md, /about 7 seconds[\s\S]*#theorytest #learner/);
  const back = video.scenesFromMarkdown(md.replace('Practise with real exam questions', 'Edited line'));
  assert.deepEqual(back.map((x) => [x.seconds, x.onScreen]), [[3, 'Failed the theory test twice?'], [4, 'Edited line']]);
  assert.deepEqual(video.brandColours('Primary #0B3D2E (dark green), accent #F2B705, text #FFFFFF'), { bg: '#0b3d2e', fg: '#ffffff', accent: '#f2b705' });
  assert.deepEqual(video.brandColours(''), { bg: '#1f2a26', fg: '#ffffff', accent: '#8fd1bd' });
  assert.match(video.slideHtml('<b>x</b> & y', { w: 100, h: 100 }, video.brandColours(''), 'acme', 1, 2), /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
});
