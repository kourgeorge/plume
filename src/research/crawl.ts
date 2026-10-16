import * as cheerio from 'cheerio';
import { getDb } from '../db';

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
}

export interface CrawlOptions {
  maxPages?: number;
  /** Swappable for tests. */
  fetchFn?: typeof fetch;
  onPage?: (page: CrawledPage, done: number) => void;
}

const USER_AGENT = 'PlumeBot/0.1 (+local marketing assistant)';
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
  const links = $('a[href]').map((_, el) => $(el).attr('href') ?? '').get();
  const imagesMissingAlt = $('img').filter((_, el) => !($(el).attr('alt') ?? '').trim()).length;
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
    },
  };
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

/** Crawl one site breadth-first, sitemap URLs first. Saves every page to the `pages` table. */
export async function crawlSite(startUrl: string, opts: CrawlOptions = {}): Promise<CrawledPage[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const maxPages = opts.maxPages ?? 40;
  const origin = new URL(startUrl).origin;

  let disallow: string[] = [];
  try {
    const r = await fetchFn(`${origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT } });
    if (r.ok) disallow = parseRobots(await r.text());
  } catch {
    /* no robots.txt = no restrictions */
  }
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
  const save = getDb().prepare(
    `INSERT OR REPLACE INTO pages (url, status, title, meta_description, canonical, h1, headings, images_missing_alt, has_schema, word_count, text, crawled_at)
     VALUES (@url, @status, @title, @metaDescription, @canonical, @h1, @headings, @imagesMissingAlt, @hasSchema, @wordCount, @text, @crawledAt)`,
  );

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!;
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' });
    } catch {
      continue;
    }
    if (!(res.headers.get('content-type') ?? '').includes('text/html')) continue;
    const { page, links } = extractPage(url, res.status, await res.text());
    pages.push(page);
    save.run({ ...page, headings: JSON.stringify(page.headings), hasSchema: page.hasSchema ? 1 : 0, crawledAt: new Date().toISOString() });
    opts.onPage?.(page, pages.length);
    for (const l of links) enqueue(l, url);
  }
  return pages;
}
