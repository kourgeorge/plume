require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-geo-'));
process.env.PLUME_SITE = 'test.example';
const { aiAccess, canRead, parseRobotsGroups, unblockSnippet } = require('../src/research/aiCrawlers');
const { schemaTypes, pageDate, identitySchema, profileLinks, contactLinks } = require('../src/research/schema');
const { extractPage } = require('../src/research/crawl');
const { auditPages } = require('../src/agents/seoAudit');
const db = require('../src/db');

const by = (list, agent) => list.find((c) => c.agent === agent);
const page = (o) => ({ url: 'https://a.com/', status: 200, title: 'Acme widgets for small teams', meta_description: 'x'.repeat(130), canonical: 'https://a.com/', h1: 'Widgets', headings: '[]', images_missing_alt: 0, has_schema: 1, word_count: 600, schema_types: '["Organization"]', ...o });
const checks = (r) => r.issues.map((i) => i.check);

// ---------------------------------------------------------------- 1. AI crawlers

test('robots.txt: a crawler obeys only its own group, else "*"; longest rule wins; Allow wins a tie', () => {
  const g = parseRobotsGroups(`User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nAllow: /\nDisallow: /private\n`);
  assert.equal(canRead(g, 'GPTBot'), true, 'its own group overrides "*"');
  assert.equal(canRead(g, 'claudebot'), true, 'names are not case-sensitive');
  assert.equal(canRead(g, 'GPTBot', '/private/x'), false);
  assert.equal(canRead(g, 'PerplexityBot'), false, 'not named, so "*" applies');
  const tie = parseRobotsGroups('User-agent: *\nDisallow: /a\nAllow: /a\n');
  assert.equal(canRead(tie, 'x', '/a'), true);
  assert.equal(canRead(parseRobotsGroups('User-agent: *\nDisallow:\n'), 'GPTBot'), true, 'empty Disallow means allow all');
  assert.equal(canRead(parseRobotsGroups('User-agent: *\nDisallow: /*.pdf$\n'), 'x', '/'), true);
  assert.equal(canRead(parseRobotsGroups('User-agent: *\nDisallow: /*.pdf$\n'), 'x', '/a.pdf'), false);
});

test('no robots.txt, or a blank one, lets every AI crawler in', () => {
  assert.ok(aiAccess(null).every((c) => c.allowed));
  assert.ok(aiAccess('').every((c) => c.allowed));
});

test('blocking only training crawlers is fine; blocking search crawlers is a fix with lines to paste', () => {
  const fine = auditPages([page()], { robots: 'User-agent: CCBot\nDisallow: /\nUser-agent: Bytespider\nDisallow: /\n' });
  assert.ok(!checks(fine).includes('ai-crawlers-blocked'), 'training-only blocks are a free choice');

  const some = auditPages([page()], { robots: 'User-agent: PerplexityBot\nDisallow: /\n' });
  const f = some.issues.find((i) => i.check === 'ai-crawlers-blocked');
  assert.equal(f.severity, 'high');
  assert.match(f.title, /Perplexity/);
  assert.equal(f.snippet, undefined, 'its own group blocks it, so the user edits that group instead of pasting');
  assert.match(f.steps[0], /names PerplexityBot/);

  const all = auditPages([page()], { robots: 'User-agent: *\nDisallow: /\n' });
  const g = all.issues.find((i) => i.check === 'ai-crawlers-blocked');
  assert.equal(g.severity, 'critical');
  assert.match(g.snippet, /^User-agent: OAI-SearchBot\n[\s\S]*User-agent: ClaudeBot[\s\S]*\nAllow: \/$/);
  assert.doesNotMatch(g.snippet, /CCBot/, 'never asks to let training crawlers in');
  // Pasting the snippet really does let them in.
  const after = aiAccess(`User-agent: *\nDisallow: /\n\n${g.snippet}\n`);
  assert.ok(after.filter((c) => c.kind === 'search').every((c) => c.allowed));
  assert.ok(!by(after, 'CCBot').allowed);

  assert.ok(!checks(auditPages([page()], {})).includes('ai-crawlers-blocked'), 'robots.txt not read yet: no claim either way');
  assert.ok(checks(auditPages([page()], { robots: null, cloudflare: true })).includes('cloudflare-ai-block'));
});

// ---------------------------------------------------------------- 2. structured data

test('structured data: every kind is found, including nested and @graph; broken blocks are counted', () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":["Organization","EducationalOrganization"],"founder":{"@type":"Person"}}]}</script>
    <script type="application/ld+json">{"@type":"https://schema.org/FAQPage"}</script><script type="application/ld+json">{not json</script>`;
  const r = schemaTypes(html);
  assert.deepEqual(r.types.sort(), ['EducationalOrganization', 'FAQPage', 'Organization', 'Person', 'WebSite']);
  assert.equal(r.broken, 1);
});

test('page date: newest stated date wins; nonsense and future dates ignored', () => {
  assert.equal(pageDate('<meta property="article:published_time" content="2024-01-02"><time datetime="2025-03-04T10:00:00Z"></time>'), '2025-03-04T10:00:00.000Z');
  assert.equal(pageDate('<script type="application/ld+json">{"datePublished":"2023-05-01","dateModified":"2024-06-01"}</script>'), '2024-06-01T00:00:00.000Z');
  assert.equal(pageDate('<time datetime="soon"></time><time datetime="2999-01-01"></time>'), null);
  assert.equal(pageDate('<p>no dates</p>'), null);
});

test('profile links skip share buttons and posts; contact links are cleaned', () => {
  const html = `<a href="https://www.facebook.com/test4u.co.il/">fb</a><a href="https://facebook.com/sharer/sharer.php?u=x">share</a>
    <a href="https://www.youtube.com/@test4u">yt</a><a href="https://www.youtube.com/watch?v=abc">video</a><a href="https://instagram.com/">home</a>
    <a href="tel:+972-50-123-4567">call</a><a href="mailto:a@b.co.il?subject=hi">mail</a>`;
  assert.deepEqual(profileLinks(html, 'https://test4u.co.il').sort(), ['https://www.facebook.com/test4u.co.il', 'https://www.youtube.com/@test4u']);
  assert.deepEqual(contactLinks(html), { phone: '+972501234567', email: 'a@b.co.il' });
});

test('the identity block uses only known facts and never invents empty fields', () => {
  const b = identitySchema({ name: 'Test4U', url: 'https://test4u.co.il', local: true, phone: '+972501234567', sameAs: ['https://www.facebook.com/test4u.co.il'], founder: { name: 'Alfred Kour', role: 'Driving instructor', sameAs: [] }, language: 'he' });
  assert.equal(b['@type'], 'LocalBusiness');
  assert.equal(b.telephone, '+972501234567');
  assert.deepEqual(b.founder, { '@type': 'Person', name: 'Alfred Kour', jobTitle: 'Driving instructor' });
  for (const k of ['logo', 'email', 'description']) assert.ok(!(k in b), `${k} should be left out, not empty`);
  assert.equal(identitySchema({ name: 'X', url: 'https://x.com', sameAs: [] })['@type'], 'Organization');
});

test('home page without who-you-are structured data gets a ready block; retired kinds are a gentle note', () => {
  const business = { name: 'Test4U', url: 'https://a.com', sameAs: [], local: false };
  const none = auditPages([page({ has_schema: 0, schema_types: '[]' })], { business });
  const f = none.issues.find((i) => i.check === 'missing-identity-schema');
  assert.equal(f.area, 'ai-search');
  const json = JSON.parse(f.snippet.replace(/^<script[^>]*>\n|\n<\/script>$/g, ''));
  assert.equal(json.name, 'Test4U');
  assert.match(f.steps.join(' '), /found none/);

  const onlyFaq = auditPages([page({ schema_types: '["FAQPage","WebSite"]' })], { business });
  assert.ok(checks(onlyFaq).includes('missing-identity-schema'), 'has schema, but none says who the business is');
  assert.equal(onlyFaq.issues.find((i) => i.check === 'retired-schema-FAQPage').severity, 'low');

  assert.ok(!checks(auditPages([page()], { business })).includes('missing-identity-schema'));
  // A crawl from before kinds were recorded: "has some" counts, so no false alarm.
  assert.ok(!checks(auditPages([page({ schema_types: undefined })], { business })).includes('missing-identity-schema'));
});

test('old dated pages are flagged; undated pages and the home page are not', () => {
  const now = new Date('2026-10-17');
  const r = auditPages([
    page(),
    page({ url: 'https://a.com/old', title: 'An old guide to the theory test', page_date: '2022-01-01T00:00:00Z' }),
    page({ url: 'https://a.com/new', title: 'A fresh guide to the theory test', page_date: '2026-06-01T00:00:00Z' }),
    page({ url: 'https://a.com/contact', title: 'Contact the driving school', page_date: null }),
  ], { now });
  const stale = r.issues.filter((i) => i.check === 'stale-page');
  assert.deepEqual(stale.map((i) => i.url), ['https://a.com/old']);
  assert.equal(stale[0].severity, 'medium');
  assert.match(stale[0].title, /4 years/);
});

test('crawler records kinds and dates; a Hebrew page works the same', () => {
  const html = `<html lang="he"><head><title>תאוריה נהיגה</title><script type="application/ld+json">{"@type":"DrivingSchool","dateModified":"2025-02-01"}</script></head><body><h1>שלום</h1></body></html>`;
  const { page: p } = extractPage('https://test4u.co.il/', 200, html);
  assert.deepEqual(p.schemaTypes, ['DrivingSchool']);
  assert.equal(p.pageDate, '2025-02-01T00:00:00.000Z');
  assert.equal(p.lang, 'he');
});

test('an older site database gains the new page columns on open, keeping its rows', () => {
  const slug = 'old.example';
  const dir = path.join(process.env.DATA_DIR, 'sites', slug);
  fs.mkdirSync(dir, { recursive: true });
  const old = new Database(path.join(dir, 'site.db'));
  old.exec(`CREATE TABLE pages (url TEXT PRIMARY KEY, status INTEGER, title TEXT, meta_description TEXT, canonical TEXT, h1 TEXT, headings TEXT, images_missing_alt INTEGER, has_schema INTEGER, word_count INTEGER, text TEXT, crawled_at TEXT);
    INSERT INTO pages (url, status, title) VALUES ('https://old.example/', 200, 'Old');`);
  old.close();
  const d = db.getDb(slug);
  const cols = d.prepare('PRAGMA table_info(pages)').all().map((c) => c.name);
  assert.ok(cols.includes('schema_types') && cols.includes('page_date'));
  const row = d.prepare('SELECT * FROM pages').get();
  assert.equal(row.title, 'Old');
  assert.equal(row.schema_types, '[]');
  db.closeSiteDb(slug);
  assert.doesNotThrow(() => db.getDb(slug), 'opening twice must not try to add the columns again');
});

// ---------------------------------------------------------------- 3. writing rules

test('every article prompt carries the quotable-writing rules', () => {
  const { QUOTABLE_RULES } = require('../src/agents/seo');
  const src = fs.readFileSync(path.join(__dirname, '../src/agents/seo.ts'), 'utf8');
  assert.match(QUOTABLE_RULES, /Start with the answer/);
  assert.match(QUOTABLE_RULES, /Never invent a figure or a source/);
  assert.match(src.slice(src.indexOf('export async function writeArticle')), /\$\{QUOTABLE_RULES\}/, 'writeArticle must include the rules');
  assert.equal(unblockSnippet([{ agent: 'GPTBot' }]), 'User-agent: GPTBot\nAllow: /');
});

// ---------------------------------------------------------------- builders, languages, plain-text phones

test('on Google Sites the fix explains what is possible instead of handing over code', () => {
  const business = { name: 'Test4U', url: 'https://a.com', sameAs: [] };
  const gs = auditPages([page({ has_schema: 0, schema_types: '[]' })], { business, builder: 'Google Sites' }).issues.find((i) => i.check === 'missing-identity-schema');
  assert.equal(gs.snippet, undefined);
  assert.match(gs.title, /Google Sites cannot add it/);
  assert.match(gs.steps.join(' '), /Google Business Profile/);

  const wp = auditPages([page({ has_schema: 0, schema_types: '[]' })], { business, builder: 'WordPress' }).issues.find((i) => i.check === 'missing-identity-schema');
  assert.match(wp.steps[0], /WPCode/);
  assert.ok(wp.snippet);
  const unknown = auditPages([page({ has_schema: 0, schema_types: '[]' })], { business }).issues.find((i) => i.check === 'missing-identity-schema');
  assert.match(unknown.steps[0], /developer/);

  const blocked = auditPages([page()], { robots: 'User-agent: *\nDisallow: /\n', builder: 'Wix' }).issues.find((i) => i.check === 'ai-crawlers-blocked');
  assert.match(blocked.steps[1], /Robots\.txt editor/);
});

test('plain-text phone numbers are found; prices, years and ids are not', () => {
  assert.equal(contactLinks('<p>Call 050-7812482 today</p>').phone, '0507812482');
  assert.equal(contactLinks('<p>+972 50 781 2482</p>').phone, '+972507812482');
  assert.equal(contactLinks('<p>Price 1,250.00 in 2025, order 20251017</p>').phone, null);
  assert.equal(contactLinks('<a href="tel:+1-555-0100">x</a><p>050-7812482</p>').phone, '+15550100', 'a tap-to-call link wins');
});

test('the structured data gets a language only when the site plainly has one', () => {
  const run = (texts, saved) => {
    const pages = texts.map((t, i) => page({ url: `https://a.com/${i ? `p${i}` : ''}`, title: `Page number ${i} title here`, has_schema: 0, schema_types: '[]', text: t }));
    const { setSetting } = require('../src/db');
    setSetting('contentLanguage', saved);
    return pages;
  };
  // auditPages takes the language from SiteFacts.business, which runAudit fills; test the rule through runAudit's helper.
  const seo = require('../src/agents/seoAudit');
  assert.equal(typeof seo.auditPages, 'function');
  const { pageLanguageForTests } = seo;
  assert.equal(pageLanguageForTests(run(['קורס תיאוריה מלא בעברית ושאלות'], 'en'), 'en'), 'he', 'Hebrew text wins over a wrong "en"');
  assert.equal(pageLanguageForTests(run(['קורס תיאוריה מלא בעברית', 'دورة تعليم سياقة', 'Cours théorique complet'], 'en'), 'en'), undefined, 'mixed site: no language');
  assert.equal(pageLanguageForTests(run(['A full theory course in English'], 'en'), 'en'), 'en');
  assert.equal(pageLanguageForTests(run(['A full theory course in English'], 'he'), 'he'), undefined, 'Latin text but a Hebrew setting: unsure');
});
