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

test('link pages: only the page owner\'s own address is used, never another business listed on it', async () => {
  const page = '<html><body><h1>Top 10 bakeries</h1><a href="mailto:hello@rival-bakery.example">Rival</a><p>Write to us: editor@bestof.example</p></body></html>';
  const fetchFn = async () => new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
  assert.deepEqual(await creators.findEmail(['https://www.bestof.example/bakeries'], fetchFn, { ownDomainOnly: true }), { email: 'editor@bestof.example', source: 'https://www.bestof.example/bakeries' });
  const onlyOthers = async () => new Response('<html><body><a href="mailto:hello@rival-bakery.example">Rival</a></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
  assert.equal(await creators.findEmail(['https://bestof.example/bakeries'], onlyOthers, { ownDomainOnly: true }), null);
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
  assert.throws(() => publish.checkTarget('video_script', 'x'), /can't take a Reel/);
  assert.deepEqual(publish.targetsFor('video_script'), ['facebook_reel', 'instagram', 'export']);
  assert.throws(() => publish.checkTarget('blog_post', 'instagram'), /Instagram — Reel can't take an article/);
  assert.ok(!publish.targetsFor('blog_post').includes('facebook_reel'));
  assert.ok(!publish.targetsFor('blog_post').includes('email'), 'articles must never be emailed out');
});

test('video scripts: Markdown round-trips, edits are honoured, colours come from the design guide', () => {
  const s = { hook: 'Failed twice?', scenes: [{ seconds: 3, shot: 'Close-up of a worried learner', onScreen: 'Failed the theory test twice?', voiceover: 'Sound familiar?' }, { seconds: 4, shot: 'Phone with app', onScreen: 'Practise with real exam questions', voiceover: 'Try this.' }], caption: 'Pass first time.', hashtags: ['theorytest', '#learner'] };
  const md = video.scriptToMarkdown('Pass first time', s);
  assert.match(md, /about 7 seconds[\s\S]*#theorytest #learner/);
  assert.equal(video.captionFromMarkdown(md), 'Pass first time.\n\n#theorytest #learner');
  assert.equal(video.captionFromMarkdown('## Caption\nHi\n\n## Notes\nnot this'), 'Hi');
  assert.equal(video.captionFromMarkdown('no caption here'), '');
  const back = video.scenesFromMarkdown(md.replace('Practise with real exam questions', 'Edited line'));
  assert.deepEqual(back.map((x) => [x.seconds, x.onScreen]), [[3, 'Failed the theory test twice?'], [4, 'Edited line']]);
  assert.deepEqual(video.brandColours('Primary #0B3D2E (dark green), accent #F2B705, text #FFFFFF'), { bg: '#0b3d2e', fg: '#ffffff', accent: '#f2b705' });
  assert.deepEqual(video.brandColours(''), { bg: '#1f2a26', fg: '#ffffff', accent: '#8fd1bd' });
  assert.match(video.slideHtml('<b>x</b> & y', { w: 100, h: 100 }, video.brandColours(''), 'acme', 1, 2), /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
});

test('filmed video: uploaded, served back, kept when the preview is redone, removed', async () => {
  const { buildServer } = require('../src/server');
  const app = buildServer(4498);
  const H = { host: '127.0.0.1:4498', 'x-plume-site': 'test.example' };
  const d = q.createDraft({ agent: 'video', kind: 'video_script', title: 'Reel', body: '# Reel\n\n## Scene 1 — 3s\n- **On screen:** Hi\n', meta: {} });
  let r = await app.inject({ method: 'POST', url: `/api/video/${d.id}/footage`, headers: { ...H, 'content-type': 'video/mp4' }, payload: Buffer.from('mp4-bytes') });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().footage.bytes, 9);
  assert.equal((await app.inject({ url: `/api/video/${d.id}`, headers: H })).json().footage.file, 'footage.mp4');
  r = await app.inject({ url: `/api/video/${d.id}/footage.mp4`, headers: H });
  assert.equal(r.body, 'mp4-bytes');
  // Redoing the preview clears old preview files only (it may fail here without Chrome; the clearing comes first).
  fs.writeFileSync(path.join(video.videoDir(d.id), 'vertical.mp4'), 'old');
  await video.renderPreview(d.id, ['vertical']).catch(() => {});
  assert.ok(fs.existsSync(video.footagePath(d.id)), 'the uploaded video must survive a new preview');
  r = await app.inject({ method: 'POST', url: `/api/video/${d.id}/footage`, headers: { ...H, 'content-type': 'video/mp4' }, payload: Buffer.alloc(0) });
  assert.equal(r.statusCode, 400);
  assert.ok(fs.existsSync(video.footagePath(d.id)), 'an empty upload must not replace a good one');
  r = await app.inject({ method: 'DELETE', url: `/api/video/${d.id}/footage`, headers: H });
  assert.equal(r.json().footage, null);
  assert.ok(!fs.existsSync(video.footagePath(d.id)));
  await app.close();
});

test('verification: real external links count; missing, blocked, own-site and lookalike pages do not', async () => {
  const c = store.addContact({ kind: 'link', name: 'Resource', url: 'https://resource.example/list', opportunity: 'unlinked-mention' });
  store.saveLinkEvidence(c.id, 'Acme helps drivers.');
  const html = link => `<html><body><p>${'Useful resources for drivers learning safely. '.repeat(12)}</p>${link}</body></html>`;
  const fetchPage = body => async () => new Response(body, { headers: { 'content-type': 'text/html' } });
  await links.verifyLink(c, fetchPage(html('<a href="https://www.acme.example/guide">Acme</a>')));
  assert.equal(store.getContact(c.id).status, 'linked');
  assert.equal(store.linkEvidence(c.id).verification, 'verified');
  assert.equal(store.linkEvidence(c.id).verified_url, 'https://www.acme.example/guide');
  assert.equal(store.linkEvidence(c.id).evidence, 'Acme helps drivers.');
  await links.verifyLink(c, fetchPage(html('<a href="https://acme.example.evil.test">Acme</a>')));
  assert.equal(store.linkEvidence(c.id).verification, 'missing');
  await links.verifyLink(c, async () => new Response('Access denied', { status: 403 }));
  assert.equal(store.linkEvidence(c.id).verification, 'error');
  assert.equal(store.linkEvidence(c.id).verified_url, '');
  const own = store.updateContact(c.id, { deliverableUrl: 'https://acme.example/about' });
  await links.verifyLink(own, fetchPage(html('<a href="https://acme.example">Home</a>')));
  assert.equal(store.linkEvidence(c.id).verification, 'missing');
});

test('link workspace API returns evidence, resumes drafts and separates manual outcomes from checks', async () => {
  const { buildServer } = require('../src/server');
  const app = buildServer(4498);
  const headers = { host: '127.0.0.1:4498', 'x-plume-site': 'test.example' };
  const c = store.addContact({ kind: 'link', name: 'New mention', url: 'https://mention.example/a' });
  store.saveLinkEvidence(c.id, 'Source text');
  const d = q.createDraft({ agent: 'links', kind: 'outreach_message', title: 'Request', body: 'Please add a link.', meta: { contactId: c.id } });
  store.updateContact(c.id, { status: 'linked' });
  const r = await app.inject({ url: '/api/outreach?kind=link', headers });
  assert.equal(r.statusCode, 200, r.body);
  const row = r.json().contacts.find(x => x.id === c.id);
  assert.equal(row.draft, d.id);
  assert.equal(row.evidence.evidence, 'Source text');
  assert.equal(row.evidence.verification, null, 'manually setting linked must not create a verification');
  const bad = await app.inject({ method: 'POST', url: '/api/outreach/999999/verify', headers });
  assert.equal(bad.statusCode, 404);
  await app.close();
});

test('discovery saves evidence and an inspectable result, including failures', async () => {
  const llm = require('../src/llm/client');
  const original = llm.askJson;
  try {
    llm.askJson = async () => ({ pages: [{ url: 'https://fresh.example/article', why: 'Relevant resource' }, { url: 'https://other.example/article', why: 'Candidate' }] });
    const result = await links.discoverLinkPages(() => {}, async url => new Response(`<html><title>Resources</title><body>${'Helpful information for drivers learning the rules. '.repeat(10)}${String(url).includes('fresh') ? 'Acme' : 'Other business'}</body></html>`, { headers: { 'content-type': 'text/html' } }));
    assert.equal(result.checked, 2);
    assert.equal(result.added.length, 1);
    assert.match(store.linkEvidence(result.added[0].id).evidence, /Acme/);
    assert.equal(store.latestLinkDiscovery().result.rejected.length, 1);
    assert.ok(store.latestLinkDiscovery().finished_at);
    llm.askJson = async () => { throw new Error('Search unavailable'); };
    await assert.rejects(links.discoverLinkPages(), /Search unavailable/);
    assert.equal(store.latestLinkDiscovery().error, 'Search unavailable');
  } finally { llm.askJson = original; }
});

test('manual send retires drafts and cannot race an already approved email', async () => {
  const app = require('../src/server').buildServer(4498);
  const headers = { host: '127.0.0.1:4498', 'x-plume-site': 'test.example' };
  const c = store.addContact({ kind: 'link', name: 'Manual request', url: 'https://manual.example/page' });
  const d = q.createDraft({ agent: 'links', kind: 'outreach_message', title: 'Request', body: 'Please add our link', meta: { contactId: c.id } });
  const r = await app.inject({ method: 'POST', url: `/api/outreach/${c.id}/sent`, headers });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(store.getContact(c.id).status, 'contacted');
  assert.ok(store.getContact(c.id).lastEmailedAt);
  assert.equal(q.getDraft(d.id).status, 'rejected');
  const queued = q.createDraft({ agent: 'links', kind: 'outreach_email', title: 'Request', body: 'Please add our link', meta: { contactId: c.id } });
  q.moveDraft(queued.id, 'approved', { target: 'email' });
  assert.equal((await app.inject({ method: 'POST', url: `/api/outreach/${c.id}/sent`, headers })).statusCode, 409);
  assert.equal(q.getDraft(queued.id).status, 'approved');
  await app.close();
});

test('email: Approve & send also respects the daily limit, and a draft is never sent twice at once', async () => {
  const env = { ...SMTP, SMTP_DAILY_LIMIT: String(email.emailsSentToday()) };
  const held = await approveSend(emailDraft('held@c.example'), env);
  assert.equal(held.status, 'approved', 'over the limit: stays approved for a later day');
  const d = emailDraft('once@d.example');
  q.moveDraft(d.id, 'approved', { target: 'email' });
  const before = sent.length;
  const free = { ...SMTP, SMTP_DAILY_LIMIT: '100' };
  const [first, second] = await Promise.allSettled([runner.publishOne(d.id, free), runner.publishDue(free)]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(q.getDraft(d.id).status, 'published');
  assert.equal(sent.filter((m, i) => i >= before && m.to === 'once@d.example').length, 1, 'sent exactly once');
  assert.equal(second.status, 'fulfilled', 'the timer skips a draft that is already being sent');
});
