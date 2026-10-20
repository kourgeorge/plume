import { readFileSync } from 'fs';
import { getDb, getSetting, setSetting } from '../db';
import { BROWSER_USER_AGENT, withBrowser } from '../research/fetchPage';
import { assertPublicUrl } from '../research/safeUrl';
import { contentLanguage } from '../context/language';
import { HEAD_CODE, type Issue, type Severity } from '../agents/seoAudit';
import { AxeViolation, PageScan, ScanFindings, complianceIssues, matchCmp, matchTrackers } from './checks';
import { Region, regionsFor, visitorCountries } from './regions';

/**
 * The compliance visit: open the site in Chrome like a first-time visitor and watch what happens before
 * they click anything. Then try "Reject", and try again with the browser's "don't share my data" signal.
 * Accessibility is checked on each page with axe-core, the standard open-source WCAG checker.
 */

export interface ComplianceResult {
  issues: Issue[];
  regions: Region[];
  regionsWhy: string[];
  cmp: string | null;
  /** Trackers seen before any click, across the pages visited. */
  trackersBefore: string[];
  cookiesBefore: string[];
  pagesChecked: number;
  /** Every page was visited, not one of each kind. */
  allPages: boolean;
  counts: { critical: number; warnings: number };
  at: string;
}

/** Text on links to the pages the law asks for, in the languages Plume writes in. */
const LINK_TEXT: Record<keyof ScanFindings['links'], RegExp> = {
  privacy: /privacy|privacidad|confidentialit|datenschutz|privacidade|privacy policy|פרטיות|מדיניות פרטיות|خصوصية|конфиденциальн/i,
  cookies: /cookie|עוגיות|קוקיז/i,
  accessibility: /accessib|barrierefrei|accesibilidad|accessibilit|נגישות|إمكانية الوصول|доступност/i,
  optOut: /do not sell|don.t sell|your privacy choices|opt.?out of (sale|sharing)/i,
  imprint: /impressum|imprint|legal notice|mentions légales|aviso legal/i,
};
const LINK_HREF: Record<keyof ScanFindings['links'], RegExp> = {
  privacy: /privacy|datenschutz|privacidad|confidentialite|פרטיות/i,
  cookies: /cookie|עוגיות/i,
  accessibility: /accessib|barrierefrei|accesibilidad|negishut|nagishut|נגישות/i,
  optOut: /do-not-sell|donotsell|privacy-choices|opt-out/i,
  imprint: /impressum|imprint|legal-notice|mentions-legales/i,
};
/** Buttons that refuse cookies. */
const REJECT = /^(reject|decline|deny|refuse|only (strictly )?necessary|necessary only|essential only|use necessary|continue without|ablehnen|nur notwendige|refuser|continuer sans|rechazar|rifiuta|דחה|דחייה|סרב|רק הכרחי|رفض|отклонить)/i;
/** Buttons that accept them. Seeing one with no reject next to it is what "no reject button" means. */
const ACCEPT = /^(accept|allow|agree|i agree|got it|ok(ay)?|yes,? i agree|alle akzeptieren|akzeptieren|zustimmen|accepter|tout accepter|aceptar|accetta|קבל|אישור|אני מסכים|מסכים|موافق|принять)/i;
/** "Manage or reject", "Settings": a second layer that may hold the refusal, so Plume can't be sure there is none. */
const MORE_CHOICES = /manage|settings|preferences|options|customi[sz]e|more choices|einstellungen|paramètres|configurar|הגדרות|ניהול/i;
/** Words a cookie notice almost always contains, in the languages Plume writes in. */
const COOKIE_WORD = 'cookie|cookies|עוגיות|קוקיז|כוקיז|ملفات تعريف الارتباط|куки|файлы cookie';

let axeSource: string | null = null;
const axe = () => (axeSource ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));

/** Addresses read as text: "/%D7%A6%D7%95%D7%A8-%D7%A7%D7%A9%D7%A8" becomes "/צור-קשר", so Hebrew page names match. */
export function readablePath(u: string): string {
  const p = new URL(u).pathname.toLowerCase();
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** True when one of the words is a whole part of the address ("/contact-us", "/shop/"), not inside another word ("/workshops"). */
const hasWord = (path: string, words: string) => new RegExp(`(^|[/_.-])(${words})($|[/_.-])`).test(path);

/** Pages where people type in their details or pay, best first. 0 = not one of them. */
function formScore(u: string): number {
  const p = readablePath(u);
  if (hasWord(p, 'contact|kontakt|צור-קשר|צרו-קשר|יצירת-קשר|اتصل')) return 4;
  if (hasWord(p, 'checkout|cart|basket|bookings|booking|book|register|signup|sign-up|login|order|join|apply|quote|subscribe|newsletter|הרשמה|הזמנה|תשלום|הצעת-מחיר')) return 3;
  if (hasWord(p, 'pricing|prices|price|plans|shop|store|products|product|מחירון|חנות')) return 2;
  return 0;
}

/**
 * Which pages to visit. Most pages share one layout (same banner, footer and trackers), so checking 40 blog
 * posts finds the same problems 40 times. Instead: the home page, every page where people fill something in,
 * and one example from each section of the site ("/blog/…", "/services/…"), up to `max` in all.
 * With `all`, every page Plume has read.
 */
export function pagesToVisit(origin: string, rows: { url: string }[], opts: { all?: boolean; max?: number } = {}): string[] {
  const home = `${origin.replace(/\/$/, '')}/`;
  const urls = [...new Set(rows.map((r) => r.url))].filter((u) => u !== home && !/\.(pdf|xml|txt)$/i.test(u));
  if (opts.all) return [home, ...urls.sort((a, b) => formScore(b) - formScore(a) || a.length - b.length)];
  const max = opts.max ?? 20;
  const forms = urls.filter((u) => formScore(u) > 0).sort((a, b) => formScore(b) - formScore(a) || a.length - b.length);
  const sections = new Map<string, string>();
  for (const u of [...urls].sort((a, b) => a.length - b.length)) {
    // "/about" and "/about/team" are one section; the shortest address stands for it.
    const key = readablePath(u).split('/').filter(Boolean)[0] ?? '';
    if (!sections.has(key)) sections.set(key, u);
  }
  return [home, ...new Set([...forms, ...sections.values()])].slice(0, max);
}

interface Visit {
  requests: string[];
  cookies: string[];
  html: string;
  links: { text: string; href: string }[];
  hasForm: boolean;
  axe: AxeViolation[];
  rejectClicked: boolean | null;
  /** A visible box that talks about cookies and has a button in it, in the page or any frame. */
  bannerVisible: boolean;
}

/** One visit in a fresh browser (no cookies). Optionally runs axe, clicks Reject, or sends the GPC signal. */
async function visit(browser: any, url: string, opts: { axe?: boolean; clickReject?: boolean; gpc?: boolean } = {}): Promise<Visit> {
  const ctx = await browser.newContext({ userAgent: BROWSER_USER_AGENT, locale: 'en-US', extraHTTPHeaders: opts.gpc ? { 'Sec-GPC': '1' } : undefined });
  try {
    const page = await ctx.newPage();
    if (opts.gpc) await page.addInitScript?.(() => Object.defineProperty((globalThis as any).navigator, 'globalPrivacyControl', { get: () => true }));
    const requests: string[] = [];
    page.on?.('request', (r: any) => requests.push(r.url()));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    let rejectClicked: boolean | null = null;
    if (opts.clickReject) {
      rejectClicked = await clickReject(page);
      if (rejectClicked) {
        // Only what loads after the refusal counts, so start the list again and reload.
        requests.length = 0;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      }
    }
    const html: string = await page.content();
    // These run inside the page, where `document` exists; this project's types don't include the browser's.
    const links: { text: string; href: string }[] = await page.evaluate(() => {
      const doc = (globalThis as any).document;
      return Array.from(doc.querySelectorAll('a[href]') as ArrayLike<any>).map((a) => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 120), href: a.href }));
    }).catch(() => []);
    const bannerVisible = await findBanner(page);
    const hasForm: boolean = await page.evaluate(() => !!(globalThis as any).document.querySelector('form input:not([type=hidden]):not([type=search]), input[type=email], input[type=tel]')).catch(() => false);
    let violations: AxeViolation[] = [];
    if (opts.axe) {
      await page.addScriptTag({ content: axe() }).catch(() => {});
      violations = await page.evaluate(async () => {
        const w = globalThis as any;
        if (!w.axe) return [];
        const r = await w.axe.run(w.document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
        return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, nodes: v.nodes.length, sample: v.nodes[0]?.html?.slice(0, 300) }));
      }).catch(() => []);
    }
    const cookies = ((await ctx.cookies().catch(() => [])) as { name: string; domain: string }[]).map((c) => `${c.name} (${c.domain.replace(/^\./, '')})`);
    return { requests, cookies, html, links, hasForm, axe: violations, rejectClicked, bannerVisible };
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * Find and click a visible "reject" button, including inside the banner's frame. True = clicked one.
 * False only when an "Accept" button is plainly visible with nothing to refuse or manage next to it; any
 * doubt (the banner hasn't appeared, or the refusal is behind "Manage") gives null, so nothing is reported.
 */
async function clickReject(page: any): Promise<boolean | null> {
  // Some banners appear a moment after the page settles.
  await page.waitForTimeout?.(1_500);
  let accept = false;
  let more = false;
  for (const frame of page.frames?.() ?? [page]) {
    const buttons = frame.locator?.('button, a[role=button], [role=button], input[type=button]');
    if (!buttons) continue;
    const n = Math.min(await buttons.count().catch(() => 0), 60);
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      const text = ((await b.innerText().catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || '').trim();
      if (!text || !(await b.isVisible().catch(() => false))) continue;
      if (REJECT.test(text) || /\breject\b|ablehnen|refuser|rechazar|דחה/i.test(text) && !ACCEPT.test(text)) {
        if (MORE_CHOICES.test(text) && !REJECT.test(text)) {
          more = true;
          continue;
        }
        await b.click({ timeout: 3_000 }).catch(() => {});
        await page.waitForTimeout?.(1_000);
        return true;
      }
      if (ACCEPT.test(text)) accept = true;
      else if (MORE_CHOICES.test(text)) more = true;
    }
  }
  return accept && !more ? false : null;
}

/**
 * Is a cookie notice showing? Banners come in too many wordings to match sentences, so this looks for its
 * shape instead: a visible element, not the whole page, that mentions cookies and holds a button or link.
 */
async function findBanner(page: any): Promise<boolean> {
  await page.waitForTimeout?.(1_500);
  for (const frame of page.frames?.() ?? [page]) {
    const seen = await frame.evaluate?.((words: string) => {
      const doc = (globalThis as any).document;
      const re = new RegExp(words, 'i');
      const all = Array.from(doc.querySelectorAll('div, section, aside, dialog, form, footer') as ArrayLike<any>);
      return all.some((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 150 || r.height < 30 || r.height > (globalThis as any).innerHeight * 0.9) return false;
        const st = (globalThis as any).getComputedStyle(el);
        if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) return false;
        const text = (el.innerText || '').slice(0, 2000);
        return text.length < 1500 && re.test(text) && !!el.querySelector('button, [role=button], a[href], input[type=button], input[type=submit]');
      });
    }, COOKIE_WORD).catch(() => false);
    if (seen) return true;
  }
  return false;
}

function findLinks(links: { text: string; href: string }[]): ScanFindings['links'] {
  const out = {} as ScanFindings['links'];
  for (const k of Object.keys(LINK_TEXT) as (keyof ScanFindings['links'])[]) {
    out[k] = links.find((l) => LINK_TEXT[k].test(l.text) || LINK_HREF[k].test(readable(l.href)))?.href ?? null;
  }
  return out;
}

const readable = (u: string) => {
  try {
    return readablePath(u);
  } catch {
    return u;
  }
};

/**
 * Fill in what the home page didn't show from every page Plume has read: a privacy policy linked only from the
 * contact page, or a page called /accessibility, still counts as there. Free: the pages are already stored.
 */
export function addStoredLinks(found: ScanFindings['links'], rows: { url: string; links_out?: string | null; title?: string | null }[]): ScanFindings['links'] {
  const out = { ...found };
  const known: { text: string; href: string }[] = [];
  for (const r of rows) {
    known.push({ text: r.title ?? '', href: r.url });
    try {
      for (const l of JSON.parse(r.links_out || '[]') as string[]) known.push({ text: '', href: l });
    } catch {
      /* old row */
    }
  }
  const more = findLinks(known);
  for (const k of Object.keys(out) as (keyof ScanFindings['links'])[]) out[k] ??= more[k];
  return out;
}

/** Visit the site and work out the problems. Saved as `lastCompliance` for the agent page. */
export interface ScanOptions {
  /** Visit every page Plume has read, not just one of each kind. Slow: about 10–40 seconds a page. */
  allPages?: boolean;
}

export async function runComplianceScan(origin: string, onProgress: (m: string) => void = () => {}, opts: ScanOptions = {}): Promise<ComplianceResult> {
  await assertPublicUrl(origin);
  const rows = (() => {
    try {
      return getDb().prepare('SELECT url, title, links_out FROM pages WHERE status < 400').all() as { url: string; title: string; links_out: string | null }[];
    } catch {
      return [];
    }
  })();
  const urls = pagesToVisit(origin, rows, { all: opts.allPages });
  const home = getSetting<{ phone: string | null } | null>('homeFacts', null);
  const language = contentLanguage();
  const { regions, why } = regionsFor({ countries: visitorCountries(), language, phone: home?.phone });
  const tech = getSetting<{ list: { name: string; kind: string }[] }>('techSignals', { list: [] }).list ?? [];
  const builder = tech.find((t) => t.kind === 'builder' && t.name in HEAD_CODE)?.name;

  const findings = await withBrowser(async (browser) => {
    const pages: PageScan[] = [];
    let first: Visit | null = null;
    for (const [i, url] of urls.entries()) {
      onProgress(`Visiting ${new URL(url).pathname} as a new visitor (${i + 1} of ${urls.length})`);
      try {
        const v = await visit(browser, url, { axe: true });
        first ??= v;
        pages.push({ url, trackersBefore: matchTrackers(v.requests, origin).map((t) => t.name), axe: v.axe, hasForm: v.hasForm });
      } catch (err: any) {
        if (i === 0) throw new Error(`couldn't open the home page in Chrome: ${String(err?.message ?? err).split('\n')[0]}`);
      }
    }
    const v0 = first!;
    const cmp = matchCmp(v0.requests, v0.html);
    const bannerSeen = !!cmp || v0.bannerVisible;
    let rejectButton: boolean | null = null;
    let trackersAfterReject: string[] | null = null;
    if (bannerSeen) {
      onProgress('Clicking "Reject" on the cookie banner and checking what still loads');
      const r = await visit(browser, urls[0], { clickReject: true }).catch(() => null);
      rejectButton = r?.rejectClicked ?? null;
      if (r?.rejectClicked) trackersAfterReject = matchTrackers(r.requests, origin).map((t) => t.name);
    }
    let trackersWithGpc: string[] | null = null;
    if (regions.some((r) => r === 'us' || r === 'us-ca')) {
      onProgress('Visiting with the browser\'s "don\'t share my data" signal on');
      const g = await visit(browser, urls[0], { gpc: true }).catch(() => null);
      if (g) trackersWithGpc = matchTrackers(g.requests, origin).map((t) => t.name);
    }
    const f: ScanFindings = {
      origin, regions, language, builder, cmp, bannerSeen, rejectButton, trackersAfterReject, trackersWithGpc,
      links: addStoredLinks(findLinks(v0.links), rows), pages,
    };
    return { f, cookies: v0.cookies };
  });

  const issues = complianceIssues(findings.f);
  const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const result: ComplianceResult = {
    issues,
    regions,
    regionsWhy: why,
    cmp: findings.f.cmp,
    trackersBefore: [...new Set(findings.f.pages.flatMap((p) => p.trackersBefore))],
    cookiesBefore: findings.cookies,
    pagesChecked: findings.f.pages.length,
    allPages: !!opts.allPages,
    counts: { critical: issues.filter((i) => i.severity === 'critical').length, warnings: issues.filter((i) => i.severity !== 'critical').length },
    at: new Date().toISOString(),
  };
  setSetting('lastCompliance', result);
  setSetting('lastComplianceFindings', findings.f);
  return result;
}

export function lastCompliance(): ComplianceResult | null {
  return getSetting<ComplianceResult | null>('lastCompliance', null);
}
