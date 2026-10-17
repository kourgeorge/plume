import * as cheerio from 'cheerio';

/**
 * Structured data (schema.org JSON-LD): hidden labels that tell Google and AI assistants what the business is.
 * Read from each page during the crawl, so the site check knows which kinds exist, not just whether any do.
 */

/** Every @type in the page's JSON-LD blocks, including ones nested in @graph or inside other objects. */
export function schemaTypes(html: string): { types: string[]; broken: number } {
  const $ = cheerio.load(html);
  const types = new Set<string>();
  let broken = 0;
  const walk = (v: unknown, depth = 0): void => {
    if (depth > 8 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const t = o['@type'];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === 'string' && x) types.add(x.replace(/^https?:\/\/schema\.org\//, ''));
    for (const k of Object.keys(o)) if (k !== '@context') walk(o[k], depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).text()));
    } catch {
      broken++;
    }
  });
  return { types: [...types], broken };
}

/** The newest date the page states about itself: structured data first, then meta tags, then <time>. Null if none. */
export function pageDate(html: string): string | null {
  const $ = cheerio.load(html);
  const found: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    for (const m of $(el).text().matchAll(/"(?:dateModified|datePublished)"\s*:\s*"([^"]+)"/g)) found.push(m[1]);
  });
  for (const sel of ['meta[property="article:modified_time"]', 'meta[property="article:published_time"]', 'meta[property="og:updated_time"]', 'meta[name="date"]'])
    $(sel).each((_, el) => void found.push($(el).attr('content') ?? ''));
  $('time[datetime]').each((_, el) => void found.push($(el).attr('datetime') ?? ''));
  const dates = found.map((s) => new Date(s)).filter((d) => !isNaN(d.getTime()) && d.getFullYear() > 1995 && d.getTime() < Date.now() + 86400e3);
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString();
}

/** Kinds that tell AI assistants who the business is. Any one of them on the home page is enough. */
export const IDENTITY_TYPES = ['Organization', 'LocalBusiness', 'Corporation', 'EducationalOrganization', 'Person', 'ProfessionalService', 'Store', 'OnlineStore', 'DrivingSchool', 'AutomotiveBusiness'];

/** Kinds Google stopped showing as special results in 2023. Harmless, but not worth adding for that reason. */
export const RETIRED_RICH_RESULTS: Record<string, string> = {
  FAQPage: 'Google stopped showing FAQ results for most sites in 2023.',
  HowTo: 'Google stopped showing how-to results in 2023.',
  SpecialAnnouncement: 'This was for COVID notices and is no longer used.',
};

export interface BusinessFacts {
  name: string;
  url: string;
  description?: string;
  logo?: string | null;
  /** Inferred from the site: a local service (address, phone, area) gets LocalBusiness. */
  local?: boolean;
  phone?: string | null;
  email?: string | null;
  /** Profiles elsewhere: social accounts, YouTube, Wikipedia. */
  sameAs: string[];
  founder?: { name: string; role?: string; sameAs: string[] } | null;
  language?: string;
}

/** The block to paste into the home page. Fields Plume doesn't know are left out, never invented. */
export function identitySchema(f: BusinessFacts): Record<string, unknown> {
  const org: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': f.local ? 'LocalBusiness' : 'Organization',
    '@id': `${f.url}/#organization`,
    name: f.name,
    url: f.url,
  };
  if (f.description) org.description = f.description;
  if (f.logo) org.logo = f.logo;
  if (f.phone) org.telephone = f.phone;
  if (f.email) org.email = f.email;
  if (f.language) org.inLanguage = f.language;
  if (f.sameAs.length) org.sameAs = f.sameAs;
  if (f.founder) {
    const p: Record<string, unknown> = { '@type': 'Person', name: f.founder.name };
    if (f.founder.role) p.jobTitle = f.founder.role;
    if (f.founder.sameAs.length) p.sameAs = f.founder.sameAs;
    org.founder = p;
  }
  return org;
}

/**
 * Phone and email on the page: tap-to-call and mailto links first, then a number written as plain text.
 * Plain-text numbers must look like a phone number (9–15 digits, grouped with dashes or spaces, or starting with + or 0),
 * so prices, years and order numbers are not mistaken for one.
 */
export function contactLinks(html: string): { phone: string | null; email: string | null } {
  const $ = cheerio.load(html);
  const tel = $('a[href^="tel:"]').first().attr('href');
  const mail = $('a[href^="mailto:"]').first().attr('href');
  let phone = tel ? decodeURIComponent(tel.slice(4)).replace(/[^\d+]/g, '') || null : null;
  if (!phone) {
    $('script, style, noscript').remove();
    const text = $('body').text();
    const m = text.match(/(?<![\d.,/])(\+\d{1,3}[\s-]?)?\(?0?\d{1,3}\)?[\s-]\d{3,4}[\s-]?\d{3,4}(?![\d.,/])/);
    const digits = m?.[0].replace(/[^\d+]/g, '') ?? '';
    if (m && digits.replace('+', '').length >= 9 && digits.replace('+', '').length <= 15 && /^(\+|0)/.test(digits)) phone = digits;
  }
  return {
    phone,
    email: mail ? decodeURIComponent(mail.slice(7)).split('?')[0].trim() || null : null,
  };
}

/** Links on the page to the business's own profiles elsewhere (footer icons, usually). */
const PROFILE_HOSTS = /(^|\.)(facebook\.com|instagram\.com|linkedin\.com|youtube\.com|x\.com|twitter\.com|tiktok\.com|wikipedia\.org|wikidata\.org|github\.com|pinterest\.com|threads\.net)$/i;
export function profileLinks(html: string, base: string): string[] {
  const $ = cheerio.load(html);
  const out = new Set<string>();
  $('a[href]').each((_, el) => {
    try {
      const u = new URL($(el).attr('href')!, base);
      if (!PROFILE_HOSTS.test(u.hostname)) return;
      // Share buttons and single posts are not the business's profile.
      if (/\/(sharer|share|intent|watch|status|posts?|p|reel|hashtag)\b/i.test(u.pathname) || u.searchParams.has('u') || u.pathname === '/') return;
      u.hash = '';
      u.search = '';
      out.add(u.toString().replace(/\/$/, ''));
    } catch {
      /* not a link */
    }
  });
  return [...out];
}
