import * as cheerio from 'cheerio';
import { contentLanguages } from '../context/language';
import { publicOnly } from './safeUrl';

export const USER_AGENT = 'PlumeBot/0.1 (+local marketing assistant)';
/** Real-browser identity for the fallback: some firewalls only let browsers through. */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

export type FailureKind = 'unreachable' | 'blocked' | 'needs-js' | 'not-html' | 'http-error';

export interface Fetched {
  ok: true;
  url: string;      // after redirects
  status: number;
  html: string;
  via: 'http' | 'browser';
}

export interface Failed {
  ok: false;
  url: string;
  kind: FailureKind;
  /** Plain English, shown to the user. */
  reason: string;
  status?: number;
  /** What came back when the page was merely thin, so it can still be used if nothing better works. */
  html?: string;
}

export type FetchResult = Fetched | Failed;

/** Opens a page in a real browser. Injected so tests don't need Chrome. */
export type BrowserFetch = (url: string) => Promise<{ status: number; html: string; url: string }>;

/** Words a page needs to count as having content. Below this, the page is probably built by JavaScript. */
const MIN_WORDS = 40;

export function visibleWords(html: string): number {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, template').remove();
  const t = $('body').text().replace(/\s+/g, ' ').trim();
  return t ? t.split(' ').length : 0;
}

/** Signs of a bot-protection or challenge page rather than the real site. */
export function looksLikeChallenge(status: number, headers: Headers | Record<string, string>, html: string): string | null {
  const h = (k: string) => (headers instanceof Headers ? headers.get(k) : headers[k]) ?? '';
  const body = html.slice(0, 20000).toLowerCase();
  if (h('cf-mitigated') === 'challenge' || /just a moment\.\.\.|cf-chl-/.test(body)) return 'Cloudflare bot protection';
  // Cloudflare also adds a background challenge-platform script to normal pages; only a near-empty page is a real challenge.
  if (/challenge-platform/.test(body) && visibleWords(html) < MIN_WORDS) return 'Cloudflare bot protection';
  if (/captcha|are you a robot|access denied|request unsuccessful\. incapsula|_incapsula_|perimeterx|px-captcha|datadome/.test(body) && visibleWords(html) < 200)
    return 'bot protection (captcha / firewall)';
  if ((status === 403 || status === 429 || status === 503) && /cloudflare|akamai|sucuri|imperva|incapsula/i.test(`${h('server')} ${h('x-cdn')} ${h('x-sucuri-id') ? 'sucuri' : ''}`))
    return `the site's firewall (${h('server') || 'CDN'})`;
  return null;
}

function explainNetworkError(err: any): string {
  const code = err?.cause?.code ?? err?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the address does not exist (no DNS record) — check the spelling';
  if (code === 'ECONNREFUSED') return 'the server refused the connection';
  if (/CERT|SSL|TLS/i.test(code) || /certificate/i.test(err?.cause?.message ?? '')) return `the site's security certificate is invalid (${code})`;
  if (err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'the site took too long to answer';
  return `could not connect (${code || err?.message || 'network error'})`;
}

/**
 * The languages to ask a site for: the site's own once they are known (main first), English last.
 * Always a real list: Node's default is "*", which some sites put into their redirect (IBM sends you to /il-*, a 404).
 */
export function acceptLanguage(langs: string[] = siteLanguages()): string {
  const all = [...new Set([...langs, 'en'])];
  return all.map((c, i) => (i ? `${c};q=${Math.max(1 - i / 10, 0.1).toFixed(1)}` : c)).join(',');
}

/** The current site's languages, or none when no site is open (or it has never been read). */
function siteLanguages(): string[] {
  try {
    return contentLanguages();
  } catch {
    return [];
  }
}

/** One plain HTTP read, classified. */
export async function fetchHttp(url: string, fetchFn: typeof fetch = fetch): Promise<FetchResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*', 'accept-language': acceptLanguage() }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return { ok: false, url, kind: 'unreachable', reason: explainNetworkError(err) };
  }
  const finalUrl = res.url || url;
  const type = res.headers.get('content-type') ?? '';
  const html = await res.text().catch(() => '');
  const challenge = looksLikeChallenge(res.status, res.headers, html);
  if (challenge) return { ok: false, url: finalUrl, kind: 'blocked', status: res.status, reason: `blocked by ${challenge}` };
  if (res.status >= 400) {
    const kind: FailureKind = res.status === 403 || res.status === 429 ? 'blocked' : 'http-error';
    return { ok: false, url: finalUrl, kind, status: res.status, reason: kind === 'blocked' ? `the site refused automated visitors (error ${res.status})` : `the page returned error ${res.status}` };
  }
  if (type && !type.includes('html')) return { ok: false, url: finalUrl, kind: 'not-html', status: res.status, reason: `not a web page (${type.split(';')[0]})` };
  if (visibleWords(html) < MIN_WORDS) return { ok: false, url: finalUrl, kind: 'needs-js', status: res.status, reason: 'the page is empty until JavaScript runs', html };
  return { ok: true, url: finalUrl, status: res.status, html, via: 'http' };
}

/**
 * Headless Chrome via the user's installed Chrome (no browser download). One Chrome is shared by every
 * job running at the same time; each page read opens its own tab.
 */
let browserPromise: Promise<any> | null = null;
/** Page reads in progress right now, across every job and site. */
let openReads = 0;
/** A close that was asked for while reads were still running, or that waits a moment for the next job. */
let closeTimer: NodeJS.Timeout | null = null;
let closeWanted = false;
let closeDelayMs = 5_000;
/** How Chrome is started. Swapped in tests so they don't need Chrome. */
let launchChrome = async () => {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ channel: 'chrome', headless: true });
};
/** Tests only: use a fake browser and a short close delay. */
export function setBrowserForTests(launch: () => Promise<any>, delayMs = 20): void {
  launchChrome = launch;
  closeDelayMs = delayMs;
}

/**
 * Run `fn` with the shared Chrome, counting it as an open read so Chrome isn't closed under it. For jobs that
 * need more than the page's HTML (the compliance visit watches network requests and clicks buttons).
 */
export async function withBrowser<T>(fn: (browser: any) => Promise<T>): Promise<T> {
  if (closeTimer) clearTimeout(closeTimer), (closeTimer = null);
  openReads++;
  try {
    browserPromise ??= (async () => {
      try {
        return await launchChrome();
      } catch (err: any) {
        browserPromise = null;
        throw new Error(`Google Chrome could not be started for reading JavaScript pages (${String(err.message).split('\n')[0]})`);
      }
    })();
    return await fn(await browserPromise);
  } finally {
    openReads--;
    if (closeWanted && openReads === 0) scheduleClose();
  }
}

export const BROWSER_USER_AGENT = BROWSER_UA;

export const chromeFetch: BrowserFetch = (url) =>
  withBrowser(async (browser) => {
    const langs = acceptLanguage();
    const ctx = await browser.newContext({ userAgent: BROWSER_UA, locale: langs.split(',')[0], extraHTTPHeaders: { 'accept-language': langs } });
    try {
      const page = await ctx.newPage();
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      return { status: resp?.status() ?? 200, html: await page.content(), url: page.url() };
    } finally {
      await ctx.close().catch(() => {});
    }
  });

function scheduleClose(): void {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (openReads > 0) return;
    closeWanted = false;
    const b = browserPromise;
    browserPromise = null;
    void b?.then((x) => x.close()).catch(() => {});
  }, closeDelayMs);
  closeTimer.unref?.();
}

/**
 * A job is done with Chrome. Other jobs may still be reading pages, so Chrome only closes once nothing is
 * open, and a few seconds later in case the next job wants it. Never closes a page someone else is reading.
 */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  closeWanted = true;
  if (openReads === 0) scheduleClose();
}

/** Close Chrome now, whatever is running (shutdown only). */
export async function shutdownBrowser(): Promise<void> {
  if (closeTimer) clearTimeout(closeTimer), (closeTimer = null);
  const b = await browserPromise?.catch(() => null);
  browserPromise = null;
  await b?.close().catch(() => {});
}

/** Classify what the browser got back, the same way as an HTTP read. */
export async function fetchBrowser(url: string, browserFn: BrowserFetch): Promise<FetchResult> {
  let r: { status: number; html: string; url: string };
  try {
    r = await browserFn(url);
  } catch (err: any) {
    return { ok: false, url, kind: 'unreachable', reason: String(err?.message ?? err).split('\n')[0] };
  }
  const challenge = looksLikeChallenge(r.status, {}, r.html);
  if (challenge) return { ok: false, url: r.url, kind: 'blocked', status: r.status, reason: `blocked by ${challenge}, even in a real browser` };
  if (r.status >= 400) return { ok: false, url: r.url, kind: 'http-error', status: r.status, reason: `the page returned error ${r.status}` };
  if (visibleWords(r.html) < MIN_WORDS) return { ok: false, url: r.url, kind: 'needs-js', status: r.status, reason: 'the page is still empty after JavaScript ran' };
  return { ok: true, url: r.url, status: r.status, html: r.html, via: 'browser' };
}

/**
 * Plain read first; a real browser only when that fails in a way a browser can fix
 * (bot blocks, JavaScript-built pages). Not for missing pages or dead addresses.
 */
export async function fetchPage(
  url: string,
  opts: { fetchFn?: typeof fetch; browserFn?: BrowserFetch | null; preferBrowser?: boolean; /** Someone else's page found by the AI or search: never let it reach this machine or the local network. */ external?: boolean } = {},
): Promise<FetchResult> {
  const browserFn = opts.browserFn === undefined ? chromeFetch : opts.browserFn;
  if (opts.preferBrowser && browserFn) return fetchBrowser(url, browserFn);
  const first = await fetchHttp(url, opts.external ? publicOnly(opts.fetchFn) : opts.fetchFn);
  const thin = (f: Failed): FetchResult | null =>
    f.kind === 'needs-js' && f.html && visibleWords(f.html) > 0 ? { ok: true, url: f.url, status: f.status ?? 200, html: f.html, via: 'http' } : null;
  if (first.ok) return first;
  if (!browserFn || !(first.kind === 'blocked' || first.kind === 'needs-js')) return thin(first) ?? first;
  const second = await fetchBrowser(url, browserFn);
  if (second.ok) return second;
  return thin(first) ?? { ...second, reason: `${first.reason}; in a real browser: ${second.reason}` };
}
