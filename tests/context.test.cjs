require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const x = require('../src/context/extra');
const watch = require('../src/watch');
const { agentSystem } = require('../src/context/profile');
const { buildLlmsTxt } = require('../src/research/llmstxt');
const { getDb, setSetting } = require('../src/db');
const today = require('../src/today');

test('competitors: addresses are cleaned, duplicates refused, watching needs a website', () => {
  assert.equal(x.siteOrigin('Rival.com/pricing?a=1'), 'https://rival.com');
  assert.equal(x.siteOrigin('not a site'), null);
  const a = x.addCompetitor({ name: 'Rival', url: 'rival.com/pricing', notes: 'cheaper' });
  assert.equal(a.url, 'https://rival.com');
  assert.equal(x.addCompetitor({ name: 'Rival again', url: 'https://www.rival.com' }), null, 'same site under www should be a duplicate');
  const b = x.addCompetitor({ name: 'Offline Shop' });
  assert.equal(x.addCompetitor({ name: 'offline shop' }), null);
  assert.throws(() => x.addCompetitor({ name: 'Bad', url: 'not a site' }), /not a web address/);
  assert.throws(() => x.updateCompetitor(b.id, { watch: true }), /add their website first/);
  assert.equal(x.updateCompetitor(a.id, { watch: true }).watch, true);
  x.removeCompetitor(b.id);
  assert.deepEqual(x.listCompetitors().map((c) => c.name), ['Rival']);
});

test('people and profiles: handles and LinkedIn addresses are normalised', () => {
  assert.equal(x.xHandle('https://x.com/JaneDoe/'), 'JaneDoe');
  assert.equal(x.xHandle('@jane_doe'), 'jane_doe');
  assert.throws(() => x.xHandle('not a handle at all'), /not an X handle/);
  assert.equal(x.linkedinUrl('linkedin.com/in/jane-doe/'), 'https://www.linkedin.com/in/jane-doe');
  assert.throws(() => x.linkedinUrl('facebook.com/jane'), /not a LinkedIn address/);
  const p = x.savePerson({ name: 'Jane Doe', role: 'Founder', bio: 'Ex-teacher, writes plainly.', xHandle: '@jane', linkedinUrl: 'linkedin.com/in/jane' });
  assert.equal(x.savePerson({ id: p.id, name: 'Jane D.', xHandle: '' }).name, 'Jane D.');
  x.setBrandProfiles({ x: 'x.com/acme', linkedin: 'https://linkedin.com/company/acme' });
  assert.deepEqual(x.brandProfiles(), { x: 'acme', linkedin: 'https://www.linkedin.com/company/acme', facebook: '' }, 'sites saved before Facebook still read');
  x.setBrandProfiles({ facebook: 'm.facebook.com/acmedesks/' });
  assert.equal(x.brandProfiles().facebook, 'https://www.facebook.com/acmedesks');
  assert.equal(x.facebookUrl('https://www.facebook.com/profile.php?id=100012345'), 'https://www.facebook.com/profile.php?id=100012345');
  assert.throws(() => x.setBrandProfiles({ facebook: 'linkedin.com/company/acme' }), /not a Facebook address/);
  assert.match(require('../src/context/extra').extraContext(), /Facebook https:\/\/www\.facebook\.com\/acmedesks/);
  x.savePerson({ name: 'Jane Doe', role: 'Founder', bio: 'Ex-teacher, writes plainly.' });
});

test('every agent gets the extra context, after the cached documents', () => {
  x.setUserNotes('We never discount. Launching Hebrew audio lessons in November.');
  const blocks = agentSystem('role', fs.mkdtempSync(path.join(os.tmpdir(), 'p-')), null);
  const extra = blocks.find((b) => b.text.startsWith('<more-context>'));
  assert.ok(extra, 'missing <more-context> block');
  assert.ok(blocks[0].cache_control && !extra.cache_control);
  assert.match(extra.text, /Rival \(https:\/\/rival\.com\): cheaper/);
  assert.match(extra.text, /Jane Doe, Founder\. Ex-teacher, writes plainly\./);
  assert.match(extra.text, /X @acme/);
  assert.match(extra.text, /never discount[\s\S]*November/);
});

// A fake competitor site whose content we can change between checks.
let site;
const fake = async (u) => {
  const url = new URL(String(u));
  const body = site[url.pathname];
  const type = url.pathname.endsWith('.xml') ? 'application/xml' : 'text/html';
  const r = new Response(body ?? 'missing', { status: body ? 200 : 404, headers: { 'content-type': type } });
  Object.defineProperty(r, 'url', { value: String(u) });
  return r;
};
const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
const sitemap = (paths) => `<?xml version="1.0"?><urlset>${paths.map((p) => `<url><loc>https://rival.com${p}</loc></url>`).join('')}</urlset>`;
const home = (h1, desc) => `<html><head><title>Rival</title><meta name="description" content="${desc}"></head><body><h1>${h1}</h1><p>${words}</p></body></html>`;
const pricing = (price) => `<html><body><h1>Plans</h1><p>${words} Pro plan ${price}/mo</p></body></html>`;

test('competitor watch: first look is silent, then new pages, headline and price changes are reported', async () => {
  const rival = x.listCompetitors().find((c) => c.name === 'Rival');
  site = { '/sitemap.xml': sitemap(['/', '/pricing', '/blog/a']), '/': home('Fast widgets', 'Widgets, fast.'), '/pricing': pricing('$29') };
  assert.deepEqual(await watch.checkCompetitor(rival, { fetchFn: fake, browserFn: null, now: new Date('2026-10-12T06:00:00Z') }), []);
  site = { '/sitemap.xml': sitemap(['/', '/pricing', '/blog/a', '/blog/b', '/compare/us']), '/': home('The fastest widgets', 'Widgets, fast.'), '/pricing': pricing('$39') };
  const ch = await watch.checkCompetitor(rival, { fetchFn: fake, browserFn: null, now: new Date('2026-10-19T06:00:00Z') });
  const kinds = ch.map((c) => c.kind);
  assert.deepEqual(kinds, ['new-pages', 'headline', 'prices']);
  assert.deepEqual(ch[0].items, ['/blog/b', '/compare/us']);
  assert.match(ch[1].text, /from "Fast widgets" to "The fastest widgets"/);
  assert.match(ch[2].text, /\$29\/mo gone; now \$39\/mo/);

  const feed = today.todayFeed(new Date('2026-10-19T09:00:00Z'));
  const card = feed.find((i) => i.kind === 'watch');
  assert.ok(card, 'change should appear in Today');
  assert.equal(card.change.name, 'Rival');
  today.changeSeen(card.change.id);
  assert.ok(!today.todayFeed(new Date('2026-10-19T09:00:00Z')).some((i) => i.kind === 'watch'));
});

test('competitor watch: every scan is recorded as baseline, changed or unchanged, and findings carry their source', async () => {
  const rival = x.listCompetitors().find((c) => c.name === 'Rival');
  const scans = watch.listScans(rival.id).filter((s) => s.scope === 'site');
  assert.deepEqual(scans.map((s) => s.outcome), ['changed', 'baseline']);
  const prices = scans[0].findings.find((f) => f.kind === 'prices');
  assert.equal(prices.url, 'https://rival.com/pricing');
  assert.equal(scans[0].findings.find((f) => f.kind === 'headline').url, 'https://rival.com/');
  await watch.checkCompetitor(rival, { fetchFn: fake, browserFn: null, now: new Date('2026-10-26T06:00:00Z') });
  assert.equal(watch.listScans(rival.id)[0].outcome, 'unchanged');
});

test('findSocials keeps company LinkedIn pages and X accounts, not share links or personal profiles', () => {
  assert.deepEqual(
    watch.findSocials([
      'https://www.linkedin.com/in/someone',
      'https://twitter.com/intent/tweet?text=hi',
      'https://linkedin.com/company/rival-inc/about',
      'https://twitter.com/rivalhq',
      'https://x.com/other',
    ]),
    { linkedin: 'https://www.linkedin.com/company/rival-inc', x: 'https://x.com/rivalhq' },
  );
});

test('news & social scan: links required, repeats dropped, first scan is a baseline that still shows news, suggestions kept once', async () => {
  const rival = x.listCompetitors().find((c) => c.name === 'Rival');
  let prompt = '';
  const answer = {
    findings: [
      { kind: 'news', text: 'Rival raised a $5M seed round (Oct 2026).', url: 'https://news.example/rival-seed' },
      { kind: 'linkedin', text: 'Posted about their new API.', url: 'not a link' },
      { kind: 'x', text: 'Launched dark mode.', url: 'https://x.com/rivalhq/status/1' },
    ],
    other_competitors: [
      { name: 'Rival', website: 'rival.com', reason: 'already listed', source_url: 'https://news.example/rival-seed' },
      { name: 'NewCo', website: 'newco.io', reason: 'Sells the same widgets to the same teams.', source_url: 'https://news.example/rival-seed' },
    ],
  };
  const ask = async (p) => ((prompt = p), answer);
  const first = await watch.scanNewsSocial(rival, { ask, now: new Date('2026-10-20T06:00:00Z') });
  assert.equal(first.outcome, 'baseline');
  assert.deepEqual(first.findings.map((f) => f.kind), ['news', 'x']);
  assert.equal(first.suggested, 1);
  assert.match(prompt, /from the last 30 days/);
  assert.ok(watch.openChanges().some((c) => c.changes.some((f) => f.url === 'https://news.example/rival-seed')), 'news shows in Today even on the first scan');

  const again = await watch.scanNewsSocial(rival, { ask, now: new Date('2026-10-27T06:00:00Z') });
  assert.equal(again.outcome, 'unchanged');
  assert.equal(again.findings.length, 0);
  assert.equal(again.suggested, 0);
  assert.match(prompt, /since 2026-10-20/);

  const [sg] = watch.openSuggestions();
  assert.equal(sg.name, 'NewCo');
  assert.equal(sg.url, 'https://newco.io');
  watch.settleSuggestion(sg.id, 'dismissed');
  assert.equal(watch.openSuggestions().length, 0);
  assert.equal(watch.suggestCompetitor({ name: 'newco', reason: 'again' }), false, 'a dismissed suggestion does not come back');
});

test('competitor watch: a site that stops answering is reported once it was readable before', async () => {
  const rival = x.listCompetitors().find((c) => c.name === 'Rival');
  site = {};
  const ch = await watch.checkCompetitor(rival, { fetchFn: fake, browserFn: null });
  assert.equal(ch[0].kind, 'unreachable');
  assert.match(ch[0].text, /error 404/);
});

test('compare ignores a sitemap that vanished and single removed pages', () => {
  const base = { pages: ['/', '/a', '/b', '/c', '/d', '/e'], headline: 'H', title: 'T', description: 'D', prices: [] };
  assert.deepEqual(watch.compare(base, { ...base, pages: [] }), []);
  assert.deepEqual(watch.compare(base, { ...base, pages: base.pages.slice(1) }), []);
  assert.equal(watch.compare(base, { ...base, pages: base.pages.slice(2) })[0].kind, 'removed-pages');
});

test('findPrices picks up common currencies including shekels', () => {
  assert.deepEqual(watch.findPrices('Basic $9/mo, Pro €19 / month, course 249 ₪, also 99 ש"ח'), ['$9/mo', '249 ₪', '99 ש"ח', '€19 / month'].sort());
});

test('llms.txt: site name, summary, pages grouped by section, descriptions', () => {
  const { getGlobalDb } = require('../src/db');
  getGlobalDb().prepare(`INSERT OR REPLACE INTO sites (slug, url, name, created_at) VALUES ('test.example', 'https://acme.example', 'Acme', 'now')`).run();
  const ins = getDb().prepare(`INSERT INTO pages (url, status, title, meta_description, canonical, h1, headings, images_missing_alt, has_schema, word_count, text, crawled_at) VALUES (?, ?, ?, ?, '', ?, '[]', 0, 0, 500, '', 'now')`);
  ins.run('https://acme.example/', 200, 'Acme Widgets | Home', 'Modular desk widgets.', 'Desk widgets');
  ins.run('https://acme.example/pricing', 200, 'Pricing', 'Plans from $9.', 'Pricing');
  for (const s of ['a', 'b', 'c']) ins.run(`https://acme.example/blog/${s}`, 200, `Post ${s}`, '', `Post ${s}`);
  ins.run('https://acme.example/gone', 404, 'Gone', '', '');
  const t = buildLlmsTxt('Acme makes modular desk widgets for remote teams.');
  assert.match(t, /^# Acme Widgets\n\n> Acme makes modular desk widgets for remote teams\.\n\n## Main pages\n/);
  assert.match(t, /- \[Pricing\]\(https:\/\/acme\.example\/pricing\): Plans from \$9\./);
  assert.match(t, /## Blog\n\n- \[Post a\]/);
  assert.doesNotMatch(t, /gone/i);
});
