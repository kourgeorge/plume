import * as cheerio from 'cheerio';
import { getDb } from '../db';
import { brandProfiles, listPeople } from '../context/extra';
import { getSite, siteUrl } from '../sites';
import { currentSite } from '../site';
import { AI_CRAWLERS } from '../research/aiCrawlers';
import { fetchPage } from '../research/fetchPage';

/**
 * Free tools: no AI, nothing saved, nothing published. Each one builds or checks something the owner then
 * copies to their site. Pre-filled from what Plume already knows about this website.
 */

// ---------------------------------------------------------------- meta tag checker

export interface MetaCheck {
  url: string;
  status: number | null;
  title: string;
  description: string;
  canonical: string;
  robots: string;
  lang: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  problems: string[];
  good: string[];
}

/** Read one page's head the way search engines and link previews do, and say what's missing. */
export function checkMeta(html: string, url: string, status: number | null = 200): MetaCheck {
  const $ = cheerio.load(html);
  const meta = (sel: string) => ($(sel).first().attr('content') ?? '').trim();
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => void (og[String($(el).attr('property')).slice(3)] ||= String($(el).attr('content') ?? '').trim()));
  $('meta[name^="twitter:"]').each((_, el) => void (twitter[String($(el).attr('name')).slice(8)] ||= String($(el).attr('content') ?? '').trim()));
  const r: MetaCheck = {
    url,
    status,
    title: $('head title').first().text().trim() || $('title').first().text().trim(),
    description: meta('meta[name="description"]'),
    canonical: ($('link[rel="canonical"]').first().attr('href') ?? '').trim(),
    robots: meta('meta[name="robots"]'),
    lang: ($('html').attr('lang') ?? '').trim(),
    og,
    twitter,
    problems: [],
    good: [],
  };
  const p = r.problems;
  const g = r.good;
  if (status && status >= 400) p.push(`The page answered ${status}, so search engines won't show it.`);
  if (!r.title) p.push('No title. Search results will make one up.');
  else if (r.title.length > 60) p.push(`The title is ${r.title.length} characters; Google cuts it at about 60.`);
  else if (r.title.length < 15) p.push(`The title is only ${r.title.length} characters — say what the page is about.`);
  else g.push(`Title is ${r.title.length} characters.`);
  if (!r.description) p.push('No meta description. Google will pick some text from the page instead.');
  else if (r.description.length > 160) p.push(`The description is ${r.description.length} characters; Google cuts it at about 155.`);
  else if (r.description.length < 70) p.push(`The description is only ${r.description.length} characters — use the space to say why to click.`);
  else g.push(`Description is ${r.description.length} characters.`);
  if (/noindex/i.test(r.robots)) p.push('This page tells search engines not to list it (noindex).');
  if (!r.canonical) p.push('No canonical link. If the page is reachable at several addresses, Google may split its ranking between them.');
  else {
    try {
      const c = new URL(r.canonical, url);
      if (c.origin !== new URL(url).origin) p.push(`The canonical link points to another site (${c.origin}).`);
      else g.push('Has a canonical link.');
    } catch {
      p.push(`The canonical link "${r.canonical}" isn't a valid address.`);
    }
  }
  if (!r.lang) p.push('The page does not say what language it is in (<html lang="…">).');
  const missingOg = ['title', 'description', 'image'].filter((k) => !og[k]);
  if (missingOg.length) p.push(`Shared links (WhatsApp, LinkedIn, Facebook) lack og:${missingOg.join(', og:')} — previews will look bare.`);
  else g.push('Has a share preview (title, description, image).');
  if (!twitter.card) p.push('No twitter:card — links shared on X show as plain text.');
  return r;
}

export async function checkMetaUrl(raw: string, fetchFn: typeof fetch = fetch): Promise<MetaCheck> {
  const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`).toString();
  const r = await fetchPage(url, { fetchFn, browserFn: null });
  if (!r.ok) throw new Error(`Couldn't read ${url}: ${r.reason}`);
  return checkMeta(r.html, r.url || url, r.status);
}

// ---------------------------------------------------------------- robots.txt

export interface RobotsOptions {
  /** search: let AI answer engines read the site (recommended); training: also allow model-training crawlers. */
  aiSearch: boolean;
  aiTraining: boolean;
  /** Paths no crawler should read, e.g. /admin, /cart. */
  disallow: string[];
  sitemap: string;
}

export function buildRobots(o: RobotsOptions): string {
  const paths = [...new Set(o.disallow.map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith('/') ? p : `/${p}`)))];
  const lines = ['# Built with Plume', 'User-agent: *', ...(paths.length ? paths.map((p) => `Disallow: ${p}`) : ['Allow: /']), ''];
  const blocked = AI_CRAWLERS.filter((c) => (c.kind === 'search' ? !o.aiSearch : !o.aiTraining));
  if (blocked.length) {
    lines.push(`# AI crawlers you chose to keep out`);
    for (const c of blocked) lines.push(`User-agent: ${c.agent}`);
    lines.push('Disallow: /', '');
  }
  if (o.sitemap.trim()) lines.push(`Sitemap: ${o.sitemap.trim()}`);
  return lines.join('\n').trim() + '\n';
}

// ---------------------------------------------------------------- sitemap

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** The pages Plume read on this site that are worth listing: answered 200, not noindex, canonical to themselves. */
export function sitemapPages(): { url: string; lastmod: string | null }[] {
  const rows = getDb().prepare('SELECT url, status, canonical, page_date, crawled_at FROM pages ORDER BY url').all() as { url: string; status: number | null; canonical: string | null; page_date: string | null; crawled_at: string | null }[];
  return rows
    .filter((r) => r.status === 200)
    .filter((r) => {
      if (!r.canonical) return true;
      try {
        return new URL(r.canonical, r.url).toString().replace(/\/$/, '') === r.url.replace(/\/$/, '');
      } catch {
        return true;
      }
    })
    .map((r) => ({ url: r.url, lastmod: r.page_date ? r.page_date.slice(0, 10) : null }));
}

export function buildSitemap(pages: { url: string; lastmod: string | null }[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map((p) => `  <url><loc>${xmlEsc(p.url)}</loc>${p.lastmod ? `<lastmod>${p.lastmod}</lastmod>` : ''}</url>`),
    '</urlset>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- UTM links

export interface UtmInput {
  url: string;
  source: string;
  medium: string;
  campaign: string;
  term?: string;
  content?: string;
}

/** Campaign tracking link. Values are lower-cased and spaces become dashes, so reports don't split "Email" and "email". */
export function buildUtm(i: UtmInput): string {
  const u = new URL(/^https?:\/\//i.test(i.url.trim()) ? i.url.trim() : `https://${i.url.trim()}`);
  const clean = (s?: string) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  for (const k of ['source', 'medium', 'campaign'] as const) if (!clean(i[k])) throw new Error(`utm_${k} is needed`);
  for (const [k, v] of Object.entries({ source: i.source, medium: i.medium, campaign: i.campaign, term: i.term, content: i.content })) {
    if (clean(v)) u.searchParams.set(`utm_${k}`, clean(v));
    else u.searchParams.delete(`utm_${k}`);
  }
  return u.toString();
}

// ---------------------------------------------------------------- structured data

export type SchemaKind = 'organization' | 'faq' | 'article';

export interface SchemaInput {
  kind: SchemaKind;
  name?: string;
  url?: string;
  logo?: string;
  description?: string;
  sameAs?: string[];
  faq?: { q: string; a: string }[];
  headline?: string;
  author?: string;
  datePublished?: string;
  image?: string;
}

/** JSON-LD to paste into the page's <head> as a <script type="application/ld+json"> block. Empty fields are left out. */
export function buildSchema(i: SchemaInput): string {
  const drop = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
  let data: Record<string, unknown>;
  if (i.kind === 'organization') {
    if (!i.name?.trim()) throw new Error('the business name is needed');
    data = drop({ '@context': 'https://schema.org', '@type': 'Organization', name: i.name.trim(), url: i.url, logo: i.logo, description: i.description, sameAs: (i.sameAs ?? []).map((s) => s.trim()).filter(Boolean) });
  } else if (i.kind === 'faq') {
    const qa = (i.faq ?? []).filter((x) => x.q?.trim() && x.a?.trim());
    if (!qa.length) throw new Error('add at least one question with an answer');
    data = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q.trim(), acceptedAnswer: { '@type': 'Answer', text: x.a.trim() } })) };
  } else {
    if (!i.headline?.trim()) throw new Error('the headline is needed');
    if (i.datePublished && isNaN(Date.parse(i.datePublished))) throw new Error(`"${i.datePublished}" isn't a date`);
    data = drop({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: i.headline.trim().slice(0, 110),
      image: i.image,
      datePublished: i.datePublished,
      author: i.author ? { '@type': 'Person', name: i.author } : undefined,
      publisher: i.name ? drop({ '@type': 'Organization', name: i.name, logo: i.logo ? { '@type': 'ImageObject', url: i.logo } : undefined }) : undefined,
    });
  }
  // "</" inside a script block would end it early; JSON allows the escaped form.
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/<\//g, '<\\/')}\n</script>\n`;
}

// ---------------------------------------------------------------- what the page starts with

export function toolDefaults() {
  const site = siteUrl() ?? '';
  const b = brandProfiles();
  const sameAs = [b.x ? `https://x.com/${b.x}` : '', b.linkedin ?? ''].filter(Boolean);
  const pages = sitemapPages();
  return {
    site,
    name: getSite(currentSite())?.name ?? currentSite(),
    author: listPeople()[0]?.name ?? '',
    sameAs,
    sitemapUrl: site ? `${site.replace(/\/$/, '')}/sitemap.xml` : '',
    sitemapPages: pages.length,
    aiCrawlers: AI_CRAWLERS.map((c) => ({ agent: c.agent, owner: c.owner, kind: c.kind, what: c.what })),
  };
}
