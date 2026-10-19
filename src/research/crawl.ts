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

async function sitemapUrls(origin: string, fetchFn: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchFn(`${origin}/sitemap.xml`, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text(), { xml: true });
    return $('loc').map((_, el) => $(el).text().trim()).get();
  } catch {
    return [];
  }
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

/** Crawl one site breadth-first, sitemap URLs first. Saves every page to the `pages` table. */
export async function crawlSite(startUrl: string, opts: CrawlOptions = {}): Promise<CrawledPage[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxPages = opts.maxPages ?? 40;
  startUrl = await withWorkingHost(startUrl, fetchFn);
  const origin = new URL(startUrl).origin;

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

  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (href: string, base: string) => {
    const u = normaliseUrl(href, base, origin);
    if (u && !seen.has(u) && allowed(u)) {
      seen.add(u);
      queue.push(u);
    }
  };
  enqueue(startUrl, startUrl);
  for (const u of await sitemapUrls(origin, fetchFn)) enqueue(u, origin);

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

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!;
    const r = await fetchPage(url, { fetchFn, browserFn: opts.browserFn, preferBrowser });
    if (!r.ok) {
      failures.push(r);
      // A missing page is normal; record it for the site check, then move on.
      if (r.kind === 'http-error' && r.status) {
        changes.push(...pageChanges(before.get(url) as PageRow | undefined, { url, status: r.status }));
        saveMissing(url, r.status);
      }
      continue;
    }
    if (r.via === 'browser') preferBrowser = true;
    const { page, links } = extractPage(url, r.status, r.html);
    signals.push(detectTech(r.html, url));
    pages.push(page);
    const { lang: _lang, ...row } = page;
    changes.push(...pageChanges(before.get(url) as PageRow | undefined, page));
    save.run({
      ...row, headings: JSON.stringify(page.headings), hasSchema: page.hasSchema ? 1 : 0, crawledAt: new Date().toISOString(), schemaTypes: JSON.stringify(page.schemaTypes),
      og: JSON.stringify(page.og), linksOut: JSON.stringify(page.linksOut), heroLazy: page.heroLazy ? 1 : 0, hreflang: JSON.stringify(page.hreflang),
    });
    if (pages.length === 1) setSetting('homeFacts', homeFacts(r.html, r.url));
    opts.onPage?.(page, pages.length);
    for (const l of links) enqueue(l, r.url);
  }
  if (!pages.length) throw new CrawlError(startUrl, failures);
  forgetGonePages(seen);
  savePageChanges(changes);
  // "Nothing links here" is only fair when every page the site lists was opened.
  setSetting('crawlComplete', seen.size === pages.length + failures.length);
  saveTechSignals(mergeSignals(signals));
  // A language the owner picked by hand stays; reading the site only fills it in.
  if (!languageSetByOwner()) setContentLanguages(detectLanguages(pages));
  return pages;
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
