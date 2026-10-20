require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-test-'));
process.env.PLUME_SITE = 'test.example';
const { regionsFor } = require('../src/compliance/regions');
const { complianceIssues, matchTrackers, matchCmp, RECHECKABLE } = require('../src/compliance/checks');
const { keyPages } = require('../src/compliance/scan');
const { plannedDocs, summaryBody } = require('../src/compliance/agent');
const { targetsFor } = require('../src/publish');

const checks = (issues) => issues.map((i) => i.check).sort();
const noLinks = { privacy: null, cookies: null, accessibility: null, optOut: null, imprint: null };
const allLinks = { privacy: 'https://a.test/privacy', cookies: 'https://a.test/cookies', accessibility: 'https://a.test/accessibility', optOut: 'https://a.test/do-not-sell', imprint: 'https://a.test/impressum' };
const findings = (o) => ({
  origin: 'https://a.test', regions: ['eu'], language: 'en', cmp: null, bannerSeen: false, rejectButton: null,
  trackersAfterReject: null, trackersWithGpc: null, links: allLinks,
  pages: [{ url: 'https://a.test/', trackersBefore: [], axe: [], hasForm: false }], ...o,
});
const home = (o) => [{ url: 'https://a.test/', trackersBefore: [], axe: [], hasForm: false, ...o }];

// ---------------------------------------------------------------- regions

test('mostly Israeli visitors: Israeli rules', () => {
  const r = regionsFor({ countries: [{ code: 'IL', clicks: 900 }, { code: 'US', clicks: 10 }] });
  assert.deepEqual(r.regions, ['il']);
  assert.match(r.why[0], /99% .* Israel/);
});

test('German visitors count as EU; US brings California with it', () => {
  const r = regionsFor({ countries: [{ code: 'DE', clicks: 50 }, { code: 'AT', clicks: 20 }, { code: 'US', clicks: 30 }] });
  assert.deepEqual(r.regions.sort(), ['eu', 'us', 'us-ca']);
});

test('language and phone add regions when there are no visitor numbers', () => {
  assert.deepEqual(regionsFor({ language: 'he' }).regions, ['il']);
  assert.deepEqual(regionsFor({ language: 'en', phone: '+44 20 7946 0000' }).regions, ['uk']);
});

test('no data at all: the strict default (EU and California)', () => {
  const r = regionsFor({});
  assert.deepEqual(r.regions.sort(), ['eu', 'us', 'us-ca']);
  assert.match(r.why[0], /no visitor numbers/);
});

// ---------------------------------------------------------------- recognising trackers and banners

test('trackers are recognised by address; own files and youtube-nocookie are not trackers', () => {
  const names = matchTrackers([
    'https://www.google-analytics.com/g/collect?v=2',
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://www.youtube-nocookie.com/embed/x',
    'https://cdn.a.test/app.js',
    'not a url',
  ], 'https://a.test').map((t) => t.name);
  assert.deepEqual(names.sort(), ['Google Analytics', 'Meta Pixel']);
});

test('cookie banners are recognised by address or by HTML', () => {
  assert.equal(matchCmp(['https://consent.cookiebot.com/uc.js'], ''), 'Cookiebot');
  assert.equal(matchCmp([], '<div id="cmplz-cookiebanner-container">'), 'Complianz');
  assert.equal(matchCmp(['https://a.test/x.js'], '<p>hi</p>'), null);
});

// ---------------------------------------------------------------- privacy rules

test('EU: trackers with no banner is critical', () => {
  const issues = complianceIssues(findings({ pages: home({ trackersBefore: ['Google Analytics'] }) }));
  const i = issues.find((x) => x.check === 'privacy-no-consent');
  assert.equal(i.severity, 'critical');
  assert.equal(i.area, 'privacy');
  assert.match(i.why, /GDPR/);
  assert.ok(i.steps.some((s) => /not legal advice/.test(s)));
});

test('EU: banner present but trackers already loaded is high, not critical', () => {
  const issues = complianceIssues(findings({ bannerSeen: true, cmp: 'Cookiebot', rejectButton: true, trackersAfterReject: [], pages: home({ trackersBefore: ['Meta Pixel'] }) }));
  assert.deepEqual(checks(issues), ['privacy-trackers-before-consent']);
  assert.equal(issues[0].severity, 'high');
  assert.match(issues[0].steps[0], /Cookiebot/);
});

test('EU: a banner that blocks until consent and a working reject: no privacy problems', () => {
  const issues = complianceIssues(findings({ bannerSeen: true, cmp: 'CookieYes', rejectButton: true, trackersAfterReject: [] }));
  assert.deepEqual(issues, []);
});

test('EU: no reject button, and reject that does nothing, are both flagged', () => {
  assert.deepEqual(checks(complianceIssues(findings({ bannerSeen: true, rejectButton: false }))), ['privacy-no-reject']);
  const ignored = complianceIssues(findings({ bannerSeen: true, rejectButton: true, trackersAfterReject: ['Hotjar'] }));
  assert.equal(ignored.find((i) => i.check === 'privacy-reject-ignored').severity, 'critical');
});

test('Cookie-free analytics need no consent', () => {
  assert.deepEqual(complianceIssues(findings({ pages: home({ trackersBefore: ['Plausible'] }) })), []);
});

test('US only: trackers before consent are fine, but ads need a Do Not Sell link and must respect GPC', () => {
  const f = findings({ regions: ['us', 'us-ca'], links: { ...allLinks, optOut: null }, trackersWithGpc: ['Meta Pixel'], pages: home({ trackersBefore: ['Google Analytics', 'Meta Pixel'] }) });
  assert.deepEqual(checks(complianceIssues(f)), ['privacy-gpc-ignored', 'privacy-no-optout']);
});

test('no privacy policy is critical when the site has a form', () => {
  const i = complianceIssues(findings({ links: { ...allLinks, privacy: null }, pages: home({ hasForm: true }) }))[0];
  assert.equal(i.check, 'privacy-no-policy');
  assert.equal(i.severity, 'critical');
});

test('German-language EU site needs an Impressum', () => {
  const f = findings({ language: 'de', links: { ...allLinks, imprint: null } });
  assert.deepEqual(checks(complianceIssues(f)), ['privacy-no-imprint']);
  assert.deepEqual(complianceIssues(findings({ language: 'fr', links: { ...allLinks, imprint: null } })), []);
});

// ---------------------------------------------------------------- accessibility rules

test('serious and critical axe failures become accessibility problems, merged across pages', () => {
  const v = (impact, nodes) => ({ id: 'color-contrast', impact, help: 'Elements must meet contrast', helpUrl: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast', nodes, sample: '<p class="grey">' });
  const f = findings({
    pages: [
      { url: 'https://a.test/', trackersBefore: [], axe: [v('serious', 3), { id: 'region', impact: 'moderate', help: 'x', helpUrl: 'x', nodes: 9 }], hasForm: false },
      { url: 'https://a.test/contact', trackersBefore: [], axe: [v('serious', 2)], hasForm: true },
    ],
  });
  const issues = complianceIssues(f);
  assert.deepEqual(checks(issues), ['a11y-color-contrast']);
  assert.equal(issues[0].severity, 'medium');
  assert.match(issues[0].title, /too faint.*5 places on 2 pages/);
  assert.match(issues[0].why, /European Accessibility Act/);
  assert.equal(issues[0].snippet, '<p class="grey">');
});

test('accessibility statement: required for the EU and Israel, not for the US', () => {
  const missing = { ...allLinks, accessibility: null };
  assert.equal(complianceIssues(findings({ regions: ['il'], links: missing }))[0].severity, 'high');
  assert.equal(complianceIssues(findings({ regions: ['eu'], links: missing }))[0].severity, 'medium');
  assert.deepEqual(complianceIssues(findings({ regions: ['us', 'us-ca'], links: missing })), []);
});

test('an overlay widget with real problems underneath gets a note', () => {
  const f = findings({ pages: home({ trackersBefore: ['accessiBe'], axe: [{ id: 'image-alt', impact: 'critical', help: 'x', helpUrl: 'x', nodes: 1 }] }) });
  assert.deepEqual(checks(complianceIssues(f)), ['a11y-image-alt', 'a11y-overlay-not-enough']);
});

test('compliance problems are left to the next visit, not re-checked by the quick page read', () => {
  assert.ok(RECHECKABLE.test('privacy-no-consent'));
  assert.ok(RECHECKABLE.test('a11y-color-contrast'));
  assert.ok(!RECHECKABLE.test('missing-title'));
});

// ---------------------------------------------------------------- which pages, which drafts

test('key pages: home first, then contact and checkout, never more than asked', () => {
  const rows = ['https://a.test/', 'https://a.test/blog/x', 'https://a.test/contact', 'https://a.test/checkout', 'https://a.test/pricing'].map((url) => ({ url }));
  assert.deepEqual(keyPages('https://a.test', rows, 2), ['https://a.test/', 'https://a.test/contact', 'https://a.test/checkout']);
});

const result = (o) => ({ issues: [], regions: ['il'], regionsWhy: [], cmp: null, trackersBefore: [], cookiesBefore: [], pagesChecked: 1, counts: { critical: 0, warnings: 0 }, at: '2026-10-20T00:00:00Z', ...o });

test('drafts: the statement when missing, privacy additions when there are privacy problems, and a summary', () => {
  const r = result({ issues: [{ area: 'privacy', check: 'privacy-no-policy', title: 'No privacy policy link', severity: 'high', why: 'w' }] });
  assert.deepEqual(plannedDocs(r, { links: noLinks }, new Set()).map((o) => o.doc), ['accessibility-statement', 'privacy-additions', 'summary']);
  assert.equal(plannedDocs(r, { links: noLinks }, new Set()).find((o) => o.doc === 'privacy-additions').title, 'Privacy policy');
  // Already drafted: not written again.
  assert.deepEqual(plannedDocs(r, { links: noLinks }, new Set(['accessibility-statement', 'summary'])).map((o) => o.doc), ['privacy-additions']);
  // Clean US site: just the summary.
  assert.deepEqual(plannedDocs(result({ regions: ['us'] }), { links: allLinks }, new Set()).map((o) => o.doc), ['summary']);
});

test('the summary lists only what Plume saw, with the disclaimer', () => {
  const body = summaryBody(result({ regions: ['eu'], trackersBefore: ['Google Analytics'], cmp: 'Cookiebot', issues: [{ area: 'privacy', title: 'Trackers load before the visitor answers', severity: 'high', why: 'Because.' }], counts: { critical: 0, warnings: 1 } }));
  assert.match(body, /not legal advice/);
  assert.match(body, /European Union.*GDPR/);
  assert.match(body, /- Google Analytics/);
  assert.match(body, /Cookiebot/);
  assert.match(body, /### Privacy\n- \*\*Trackers load/);
  assert.doesNotMatch(body, /### Accessibility/);
});

test('the summary can only be exported, not published', () => {
  assert.deepEqual(targetsFor('compliance_report'), ['export']);
});

// ---------------------------------------------------------------- the visit, with a fake Chrome

/** A fake Chrome whose banner shows these button labels. Clicking a reject-like one stops the analytics. */
function fakeSite(labels) {
  const { setBrowserForTests } = require('../src/research/fetchPage');
  const { setLookupForTests } = require('../src/research/safeUrl');
  setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  let rejected = false;
  setBrowserForTests(async () => ({
    close: async () => {},
    newContext: async () => {
      const handlers = [];
      const fire = () => {
        // Before Reject: analytics and the banner load. After Reject: only the banner.
        const urls = [...(labels.length ? ['https://consent.example-cmp.test/banner.js'] : []), ...(rejected ? [] : ['https://www.googletagmanager.com/gtag/js?id=G-1'])];
        for (const u of urls) for (const h of handlers) h({ url: () => u });
      };
      const buttons = labels.map((l) => ({ innerText: async () => l, getAttribute: async () => null, isVisible: async () => true, click: async () => { rejected = true; } }));
      const page = {
        on: (_e, h) => handlers.push(h),
        goto: async () => (fire(), { status: () => 200 }),
        reload: async () => fire(),
        waitForLoadState: async () => {},
        waitForTimeout: async () => {},
        content: async () => '<html><body><p>Hello</p></body></html>',
        evaluate: async (fn) => (String(fn).includes('querySelectorAll') ? [{ text: 'Privacy policy', href: 'https://a.test/privacy' }] : String(fn).includes('axe') ? [] : false),
        addScriptTag: async () => {},
        addInitScript: async () => {},
        // The banner check runs in each frame: a banner shows whenever it has buttons.
        frames: () => [{ locator: () => ({ count: async () => buttons.length, nth: (i) => buttons[i] }), evaluate: async () => buttons.length > 0 }],
      };
      return { newPage: async () => page, cookies: async () => [{ name: '_ga', domain: '.a.test' }], close: async () => {} };
    },
  }), 1);
}

async function scanWith(labels) {
  const { shutdownBrowser } = require('../src/research/fetchPage');
  const { runComplianceScan } = require('../src/compliance/scan');
  fakeSite(labels);
  try {
    return await runComplianceScan('https://a.test');
  } finally {
    require('../src/research/safeUrl').setLookupForTests(null);
    await shutdownBrowser();
  }
}

test('the visit records trackers before consent, clicks Reject, and saves the result', async () => {
  const { lastCompliance } = require('../src/compliance/scan');
  {
    const r = await scanWith(['Accept all', 'Reject all']);
    assert.deepEqual(r.regions.sort(), ['eu', 'us', 'us-ca']);
    // An unknown banner platform, found by its shape rather than its name.
    assert.equal(r.cmp, null);
    assert.deepEqual(r.trackersBefore, ['Google Tag Manager']);
    assert.deepEqual(r.cookiesBefore, ['_ga (a.test)']);
    const found = r.issues.map((i) => i.check);
    assert.ok(found.includes('privacy-trackers-before-consent'));
    assert.ok(!found.includes('privacy-reject-ignored'), 'reject worked, so it should not be flagged');
    assert.ok(found.includes('a11y-no-statement'));
    assert.equal(lastCompliance().at, r.at);
  }
});

test('"no reject button" only when an Accept button stands alone', async () => {
  const has = async (labels) => (await scanWith(labels)).issues.some((i) => i.check === 'privacy-no-reject');
  assert.equal(await has(['Accept all']), true);
  // The refusal may be behind "Manage": Plume can't be sure, so it says nothing.
  assert.equal(await has(['Accept all', 'Manage or reject cookies']), false);
  assert.equal(await has(['Accept all', 'Cookie settings']), false);
});

test('no banner at all, with analytics loading: critical', async () => {
  const r = await scanWith([]);
  assert.equal(r.issues.find((i) => i.check === 'privacy-no-consent')?.severity, 'critical');
  assert.ok(!r.issues.some((i) => i.check === 'privacy-no-reject'));
});
