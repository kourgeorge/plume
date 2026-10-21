import * as cheerio from 'cheerio';
import { getDb } from '../db';
import { BrowserFetch, Failed, USER_AGENT, fetchHttp, fetchPage } from './fetchPage';
import { TechSignal, detectTech, mergeSignals, saveTechSignals } from './techSignals';
import { contactLinks, pageDate, profileLinks, schemaTypes } from './schema';
import { setSetting } from '../db';
import { detectLanguages, languageSetByOwner, setContentLanguages } from '../context/language';
import { PageChange, PageRow, pageChanges, savePageChanges } from './pageChanges';

export interface CrawledPage {
  url: string;
  status: number;
  title: string;
  metaDescription: string;
  canonical: string;
  h1: string;
  headings: { level: number; text: string }[];
  imagesMissingAlt: number;
  hasSchema: boolean;
  wordCount: number;
  text: string;
  /** From <html lang>, e.g. "he" or "en-US"; empty if the page doesn't say. */
  lang: string;
  /** Structured-data kinds on the page, e.g. ["Organization", "WebSite"]. */
  schemaTypes: string[];
  /** Newest published/updated date the page states, or null. */
  pageDate: string | null;
  /** The robots meta tag(s), e.g. "noindex, follow"; empty when the page has none. */
  metaRobots: string;
  /** Social preview tags (Open Graph). */
  og: { title: string; description: string; image: string };
  /** Same-site pages this page links to (normalised), for finding pages nothing links to. */
  linksOut: string[];
  /** Images without width and height, so the page jumps as they load. */
  imagesNoSize: number;
  /** The first image in the main content loads late (loading="lazy"), which slows the part visitors see first. */
  heroLazy: boolean;
  /** Language versions the page points at: <link rel="alternate" hreflang>. */
  hreflang: { lang: string; href: string }[];
}

/** Found on the home page, for the structured-data fix: how to reach the business and its profiles elsewhere. */
export interface HomeFacts {
  phone: string | null;
  email: string | null;
  profiles: string[];
  logo: string | null;
}

export interface CrawlOptions {
  maxPages?: number;
  /** Swappable for tests. */
  fetchFn?: typeof fetch;
  /** Real-browser fallback; null = never use one. Default: the installed Chrome. */
  browserFn?: BrowserFetch | null;
  onPage?: (page: CrawledPage, done: number) => void;
}

const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|mp3|css|js|ico|xml|json)$/i;

/** Normalise a link: same origin only, no hash, no query, no trailing slash (except root). */
export function normaliseUrl(href: string, base: string, origin: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.origin !== origin || SKIP_EXT.test(u.pathname)) return null;
  u.hash = '';
  u.search = '';
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

/** Very small robots.txt reader: honours Disallow lines under `User-agent: *`. */
export function parseRobots(body: string): string[] {
  const disallow: string[] = [];
  let applies = false;
  for (const raw of body.split('\n')) {
    const line = raw.split('#')[0].trim();
    const [k, ...rest] = line.split(':');
    const v = rest.join(':').trim();
    if (/^user-agent$/i.test(k)) applies = v === '*';
    else if (applies && /^disallow$/i.test(k) && v) disallow.push(v);
  }
  return disallow;
}

export function extractPage(url: string, status: number, html: string): { page: CrawledPage; links: string[] } {
  const $ = cheerio.load(html);
  const schemaCount = $('script[type="application/ld+json"]').length;
  const schema = schemaTypes(html);
  const date = pageDate(html);
  const links = $('a[href]').map((_, el) => $(el).attr('href') ?? '').get();
  const imagesMissingAlt = $('img').filter((_, el) => !($(el).attr('alt') ?? '').trim()).length;
  const origin = new URL(url).origin;
  const linksOut = [...new Set(links.map((l) => normaliseUrl(l, url, origin)).filter((l): l is string => !!l && l !== url))];
  const imagesNoSize = $('img').filter((_, el) => !$(el).attr('width') || !$(el).attr('height')).length;
  // The logo in the header is often the first image; the one that matters is the first in the content.
  const hero = $('img').filter((_, el) => !$(el).closest('header, nav, footer').length).first();
  const hreflang = $('link[rel="alternate"][hreflang]')
    .map((_, el) => {
      try {
        return { lang: ($(el).attr('hreflang') ?? '').trim(), href: new URL($(el).attr('href') ?? '', url).toString() };
      } catch {
        return null;
      }
    })
    .get()
    .filter((h): h is { lang: string; href: string } => !!h?.lang);
  const meta = (prop: string) => ($(`meta[property="${prop}"]`).attr('content') ?? $(`meta[name="${prop}"]`).attr('content') ?? '').trim();
  const headings = $('h1, h2, h3')
    .map((_, el) => ({ level: Number(el.tagName.slice(1)), text: $(el).text().trim().replace(/\s+/g, ' ') }))
    .get()
    .filter((h) => h.text);
  $('script, style, noscript, svg, nav, footer, header').remove();
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  return {
    links,
    page: {
      url,
      status,
      title: $('title').first().text().trim(),
      metaDescription: $('meta[name="description"]').attr('content')?.trim() ?? '',
      canonical: $('link[rel="canonical"]').attr('href') ?? '',
      h1: $('h1').first().text().trim(),
      headings,
      imagesMissingAlt,
      hasSchema: schemaCount > 0,
      wordCount: text ? text.split(' ').length : 0,
      text,
      lang: ($('html').attr('lang') ?? '').trim(),
      schemaTypes: schema.types,
      pageDate: date,
      metaRobots: $('meta[name="robots" i], meta[name="googlebot" i]').map((_, el) => ($(el).attr('content') ?? '').trim()).get().filter(Boolean).join(', '),
      og: { title: meta('og:title'), description: meta('og:description'), image: meta('og:image') },
      linksOut,
      imagesNoSize,
      heroLazy: (hero.attr('loading') ?? '').toLowerCase() === 'lazy',
      hreflang,
    },
  };
}

export function homeFacts(html: string, url: string): HomeFacts {
  const $ = cheerio.load(html);
  const logo = $('img[src*="logo" i], img[alt*="logo" i], header img').first().attr('src');
  let logoUrl: string | null = null;
  try {
    logoUrl = logo ? new URL(logo, url).toString() : null;
  } catch {
    /* bad src */
  }
  return { ...contactLinks(html), profiles: profileLinks(html, url), logo: logoUrl };
}

/** Sitemap files read per crawl, and addresses kept from them. Big sites list hundreds of files and millions of pages. */
const MAX_SITEMAP_FILES = 20;
const MAX_SITEMAP_URLS = 50_000;

/** The same site, with or without "www.". */
function sameSite(a: string, b: string): boolean {
  return a.replace(/^www\./, '') === b.replace(/^www\./, '');
}

/** "Sitemap:" lines in robots.txt (any user-agent group). */
export function robotsSitemaps(robots: string | null): string[] {
  return (robots ?? '').split('\n').map((l) => l.split('#')[0].trim()).filter((l) => /^sitemap\s*:/i.test(l)).map((l) => l.replace(/^sitemap\s*:/i, '').trim()).filter(Boolean);
}

/**
 * Every page address the site's sitemaps list. Starts from the sitemaps named in robots.txt (or /sitemap.xml)
 * and follows sitemap index files, which only list other sitemaps. `complete` is false when a file could not be
 * read or a limit cut the list short, so pages missing from the list may still exist.
 */
export async function sitemapUrls(origin: string, fetchFn: typeof fetch, robots: string | null = null): Promise<{ urls: string[]; complete: boolean }> {
  const host = new URL(origin).hostname;
  const named = robotsSitemaps(robots).filter((u) => {
    try {
      return sameSite(new URL(u).hostname, host);
    } catch {
      return false;
    }
  });
  const queue = named.length ? [...named] : [`${origin}/sitemap.xml`];
  const done = new Set<string>();
  const urls: string[] = [];
  let complete = true;
  while (queue.length) {
    const file = queue.shift()!;
    if (done.has(file)) continue;
    if (done.size >= MAX_SITEMAP_FILES || urls.length >= MAX_SITEMAP_URLS) {
      complete = false;
      break;
    }
    done.add(file);
    try {
      const res = await fetchFn(file, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      // A missing /sitemap.xml just means the site has none; a sitemap robots.txt names but can't be read is a gap.
      if (!res.ok) {
        if (named.length) complete = false;
        continue;
      }
      const $ = cheerio.load(await res.text(), { xml: true });
      // A sitemap index lists more sitemaps; a plain sitemap lists pages.
      $('sitemap > loc').each((_, el) => void queue.push($(el).text().trim()));
      $('url > loc').each((_, el) => void (urls.length < MAX_SITEMAP_URLS ? urls.push($(el).text().trim()) : (complete = false)));
    } catch {
      complete = false;
    }
  }
  return { urls, complete };
}

/**
 * Some sites only answer on the www address (the bare one has no server behind it).
 * If the address given never connects but the www version does, use www instead.
 */
export async function withWorkingHost(startUrl: string, fetchFn: typeof fetch): Promise<string> {
  const u = new URL(startUrl);
  if (u.hostname.startsWith('www.') || u.hostname.split('.').length > 3 || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return startUrl;
  const first = await fetchHttp(startUrl, fetchFn);
  if (first.ok || first.kind !== 'unreachable') return startUrl;
  u.hostname = `www.${u.hostname}`;
  const second = await fetchHttp(u.toString(), fetchFn);
  return second.ok || second.kind !== 'unreachable' ? u.toString() : startUrl;
}

/** Pages read at the same time. Enough to be quick, few enough not to hammer a small site. */
const CONCURRENCY = 4;

/**
 * Crawl one site. The home page first, then pages its links lead to (the menu and content, closest first), and
 * only after those the pages the sitemap lists that no link reached. Saves every page to the `pages` table.
 */
export async function crawlSite(startUrl: string, opts: CrawlOptions = {}): Promise<CrawledPage[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxPages = opts.maxPages ?? 40;
  startUrl = await withWorkingHost(startUrl, fetchFn);
  let origin = new URL(startUrl).origin;

  let disallow: string[] = [];
  // Kept for the site check, which reads it again per AI crawler. null = the site has none.
  let robots: string | null = null;
  try {
    const r = await fetchFn(`${origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT } });
    if (r.ok) {
      robots = await r.text();
      disallow = parseRobots(robots);
    }
  } catch {
    /* no robots.txt = no restrictions */
  }
  setSetting('robotsTxt', { at: new Date().toISOString(), body: robots });
  const allowed = (u: string) => !disallow.some((d) => new URL(u).pathname.startsWith(d));

  /** Every address found: kept on the next crawl even if the page limit stopped us opening it. */
  const seen = new Set<string>();
  /** Addresses opened (or being opened), so a page found twice is read once. */
  const taken = new Set<string>();
  /** Found through a link: read first. */
  const linked: string[] = [];
  /** Only in the sitemap so far: read when no linked page is left. */
  const listed: string[] = [];
  /** Another address for a saved page (where a redirect started or ended), so links to it count for that page. */
  const alias = new Map<string, string>();
  const add = (href: string, base: string, to: string[]) => {
    const u = normaliseUrl(href, base, origin);
    if (!u || taken.has(u) || !allowed(u)) return;
    // A sitemap page that a link also reaches moves up to the linked list.
    if (to === linked || !seen.has(u)) to.push(u);
    seen.add(u);
  };
  const next = (): string | undefined => {
    for (const q of [linked, listed]) {
      while (q.length) {
        const u = q.shift()!;
        if (!taken.has(u)) return taken.add(u), u;
      }
    }
    return undefined;
  };

  const pages: CrawledPage[] = [];
  const failures: Failed[] = [];
  const save = getDb().prepare(
    `INSERT OR REPLACE INTO pages (url, status, title, meta_description, canonical, h1, headings, images_missing_alt, has_schema, word_count, text, crawled_at, schema_types, page_date,
       meta_robots, og, links_out, images_no_size, hero_lazy, hreflang)
     VALUES (@url, @status, @title, @metaDescription, @canonical, @h1, @headings, @imagesMissingAlt, @hasSchema, @wordCount, @text, @crawledAt, @schemaTypes, @pageDate,
       @metaRobots, @og, @linksOut, @imagesNoSize, @heroLazy, @hreflang)`,
  );
  const before = getDb().prepare('SELECT * FROM pages WHERE url = ?');
  const changes: PageChange[] = [];
  const signals: TechSignal[][] = [];
  // Once a page only opened in a real browser, use the browser for the rest of the site.
  let preferBrowser = false;

  const read = async (url: string, isHome = false): Promise<void> => {
    const r = await fetchPage(url, { fetchFn, browserFn: opts.browserFn, preferBrowser });
    if (!r.ok) {
      failures.push(r);
      // A missing page is normal; record it for the site check, then move on.
      if (r.kind === 'http-error' && r.status) {
        changes.push(...pageChanges(before.get(url) as PageRow | undefined, { url, status: r.status }));
        saveMissing(url, r.status);
      }
      return;
    }
    if (r.via === 'browser') preferBrowser = true;
    // The home page sends visitors to the www (or bare) address: that is the site from now on.
    if (isHome && new URL(r.url).origin !== origin && sameSite(new URL(r.url).hostname, new URL(origin).hostname)) {
      origin = new URL(r.url).origin;
      const root = `${origin}/`;
      if (root !== url) alias.set(root, url), taken.add(root), seen.add(root);
    }
    // A redirect: save the page under the address it really lives at, once. The home page keeps the address the
    // site was added with (it is how the home page is found later); its real address becomes an alias.
    let key = url;
    const landed = normaliseUrl(r.url, r.url, origin);
    if (landed && landed !== url) {
      if (isHome) alias.set(landed, url);
      else {
        alias.set(url, landed);
        if (taken.has(landed)) return; // read (or being read) under its real address already
        key = landed;
      }
      taken.add(landed);
      seen.add(landed);
    }
    const { page, links } = extractPage(key, r.status, r.html);
    signals.push(detectTech(r.html, key));
    pages.push(page);
    const { lang: _lang, ...row } = page;
    changes.push(...pageChanges(before.get(key) as PageRow | undefined, page));
    save.run({
      ...row, headings: JSON.stringify(page.headings), hasSchema: page.hasSchema ? 1 : 0, crawledAt: new Date().toISOString(), schemaTypes: JSON.stringify(page.schemaTypes),
      og: JSON.stringify(page.og), linksOut: JSON.stringify(page.linksOut), heroLazy: page.heroLazy ? 1 : 0, hreflang: JSON.stringify(page.hreflang),
    });
    if (pages.length === 1) setSetting('homeFacts', homeFacts(r.html, r.url));
    opts.onPage?.(page, pages.length);
    for (const l of links) add(l, r.url, linked);
  };

  // The home page alone first: it can move the site to its www address and show whether a browser is needed.
  add(startUrl, startUrl, linked);
  const home = next();
  if (home) await read(home, true);
  const sitemap = await sitemapUrls(origin, fetchFn, robots);
  for (const u of sitemap.urls) add(u, origin, listed);

  const running = new Set<Promise<void>>();
  for (;;) {
    while (running.size < CONCURRENCY && pages.length + running.size < maxPages) {
      const url = next();
      if (!url) break;
      const job: Promise<void> = read(url).catch(() => {}).finally(() => running.delete(job));
      running.add(job);
    }
    if (!running.size) break;
    await Promise.race(running);
  }
  if (!pages.length) throw new CrawlError(startUrl, failures);
  relinkAliases(pages, alias);
  // Pages listed only in a sitemap file we could not read may still exist: keep them until the list is whole.
  if (sitemap.complete) forgetGonePages(seen);
  savePageChanges(changes);
  // "Nothing links here" is only fair when every page the site lists was opened.
  setSetting('crawlComplete', sitemap.complete && !linked.some((u) => !taken.has(u)) && !listed.some((u) => !taken.has(u)));
  saveTechSignals(mergeSignals(signals));
  // A language the owner picked by hand stays; reading the site only fills it in.
  if (!languageSetByOwner()) setContentLanguages(detectLanguages(pages));
  return pages;
}

/**
 * Links to an address that redirects now point at the page it lands on, so that page doesn't look unlinked.
 * A copy saved under the old address by an earlier crawl is dropped: the page lives at the new one now.
 */
function relinkAliases(pages: CrawledPage[], alias: Map<string, string>): void {
  if (!alias.size) return;
  const drop = getDb().prepare('DELETE FROM pages WHERE url = ?');
  for (const from of alias.keys()) drop.run(from);
  const update = getDb().prepare('UPDATE pages SET links_out = ? WHERE url = ?');
  for (const p of pages) {
    const out = [...new Set(p.linksOut.map((l) => alias.get(l) ?? l))].filter((l) => l !== p.url);
    if (out.length === p.linksOut.length && out.every((l, i) => l === p.linksOut[i])) continue;
    p.linksOut = out;
    update.run(JSON.stringify(out), p.url);
  }
}

/**
 * Drop saved pages the site no longer links to or lists in its sitemap. `seen` holds every address found this
 * time, including ones the page limit stopped us from opening, so those keep their older copy.
 */
function forgetGonePages(seen: Set<string>): void {
  const db = getDb();
  const gone = (db.prepare('SELECT url FROM pages').all() as { url: string }[]).map((r) => r.url).filter((u) => !seen.has(u));
  const del = db.prepare('DELETE FROM pages WHERE url = ?');
  db.transaction(() => gone.forEach((u) => del.run(u)))();
}

/** Raised when not a single page could be read; the message says why in plain English. */
export class CrawlError extends Error {
  constructor(public site: string, public failures: Failed[]) {
    const first = failures[0];
    super(first ? `Could not read ${site}: ${first.reason}.` : `Could not read ${site}: no pages found.`);
  }
}

function saveMissing(url: string, status: number): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO pages (url, status, title, meta_description, canonical, h1, headings, images_missing_alt, has_schema, word_count, text, crawled_at)
              VALUES (?, ?, '', '', '', '', '[]', 0, 0, 0, '', ?)`)
    .run(url, status, new Date().toISOString());
}
