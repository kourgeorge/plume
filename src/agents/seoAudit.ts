import { getDb, getSetting, setSetting } from '../db';
import { escapeHtml } from '../publish';
import { aiAccess, unblockSnippet } from '../research/aiCrawlers';
import { saveAuditHistory } from '../actions';
import { BusinessFacts, IDENTITY_TYPES, RETIRED_RICH_RESULTS, identitySchema } from '../research/schema';
import type { PageRow } from '../research/pageChanges';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Area = 'technical' | 'on-page' | 'content' | 'performance' | 'ai-search' | 'security' | 'privacy' | 'accessibility';

/** One problem found on the site, with a fix someone without SEO knowledge can apply. */
export interface Issue {
  id: string;            // stable: check + url, so the same problem isn't reported twice
  check: string;
  severity: Severity;
  area: Area;
  url: string;
  title: string;
  why: string;
  steps: string[];
  /** Copy-paste code, when the fix is a code change. */
  snippet?: string;
}

export interface AuditResult {
  score: number;
  counts: { critical: number; warnings: number; passed: number };
  issues: Issue[];
  pagesChecked: number;
  at: string;
}


/** What the site check knows beyond the pages themselves. Everything is optional: a missing fact skips its check. */
export interface SiteFacts {
  robotsOk?: boolean;
  sitemapOk?: boolean;
  /** robots.txt text; null = the site has none; undefined = not read yet. */
  robots?: string | null;
  /** Cloudflare can block AI crawlers on its own side, where robots.txt doesn't show it. */
  cloudflare?: boolean;
  /** What the site is built with (from tech signals), so fixes say where to click. */
  builder?: string;
  /** For writing the structured-data block. */
  business?: BusinessFacts;
  /** For the "old page" check; defaults to now. */
  now?: Date;
  /** The whole site was read (no page limit hit), so "no page links here" can be trusted. */
  crawlComplete?: boolean;
  /** Does the http:// address send visitors on to https://? undefined = not checked. */
  httpsRedirect?: boolean;
}

/** Where each builder lets the owner edit robots.txt. */
const ROBOTS_EDIT: Record<string, string> = {
  WordPress: 'In WordPress, an SEO plugin (Yoast: Tools → File editor; Rank Math: General settings → Edit robots.txt) lets you edit it.',
  Wix: 'In Wix, open SEO settings → Robots.txt editor.',
  Webflow: 'In Webflow, open Site settings → SEO → Indexing → robots.txt.',
  Shopify: 'In Shopify, edit the robots.txt.liquid template under Online Store → Themes → Edit code.',
  Squarespace: 'Squarespace writes robots.txt for you; under Settings → Crawlers you can choose whether to block AI crawlers.',
};

/**
 * Where each builder lets the owner paste code into the page <head>. Null = it can't be done there,
 * so the fix says so instead of handing over code with nowhere to go.
 */
export const HEAD_CODE: Record<string, string | null> = {
  WordPress: 'In WordPress, install a plugin such as "WPCode" or "Insert Headers and Footers" and paste it into the header box. (Yoast and Rank Math add some of this automatically — check before adding a second copy.)',
  Webflow: 'In Webflow, open Site settings → Custom code → Head code, paste it, save and publish.',
  Wix: 'In Wix, open Settings → Custom code → Add custom code, paste it, choose "All pages" and "Head", then apply.',
  Squarespace: 'In Squarespace, open Settings → Advanced → Code injection, paste it into Header and save.',
  Framer: 'In Framer, open Site settings → General → Custom code, paste it into "End of <head> tag" and publish.',
  Shopify: 'In Shopify, open Online Store → Themes → Edit code → theme.liquid, and paste it just before </head>.',
  'HubSpot CMS': 'In HubSpot, open Settings → Website → Pages → Site header HTML, paste it and save.',
  'Google Sites': null,
};

const typesOf = (p: PageRow): string[] => {
  try {
    return JSON.parse(p.schema_types ?? '[]');
  } catch {
    return [];
  }
};

const WEIGHT: Record<Severity, number> = { critical: 10, high: 5, medium: 2, low: 1 };
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function siteName(pages: PageRow[]): string {
  const home = pages.find((p) => new URL(p.url).pathname === '/') ?? pages[0];
  return (home?.title.split(/[|–—-]/)[0] ?? '').trim() || new URL(home.url).hostname;
}

/** Every check runs on the crawl already in the database — no extra requests. */
export function auditPages(pages: PageRow[], site: SiteFacts = {}): AuditResult {
  const issues: Issue[] = [];
  let passed = 0;
  const add = (i: Omit<Issue, 'id'>) => issues.push({ ...i, id: `${i.check}:${i.url}` });
  const name = pages.length ? siteName(pages) : '';

  const titleCounts = new Map<string, string[]>();
  for (const p of pages) if (p.title) titleCounts.set(p.title, [...(titleCounts.get(p.title) ?? []), p.url]);

  for (const p of pages) {
    const path = new URL(p.url).pathname;

    if (p.status >= 400) {
      add({ check: 'broken-page', severity: 'critical', area: 'technical', url: p.url, title: `Page returns error ${p.status}`,
        why: 'Visitors and search engines hit a dead end, and links pointing here are wasted.',
        steps: ['Restore the page, or add a 301 redirect to the closest live page.', 'Update internal links that point here.'] });
      continue;
    }

    if (!p.title) {
      add({ check: 'missing-title', severity: 'critical', area: 'on-page', url: p.url, title: 'Page has no title',
        why: 'The title is the blue headline in Google results. Without one, Google invents it.',
        steps: ['Add a <title> inside <head>, 50–60 characters, with the main topic first.'],
        snippet: `<title>${escapeHtml(p.h1 || 'Topic')} | ${escapeHtml(name)}</title>` });
    } else if (p.title.length > 60 || p.title.length < 15) {
      add({ check: 'title-length', severity: 'medium', area: 'on-page', url: p.url, title: `Title is ${p.title.length} characters`,
        why: p.title.length > 60 ? 'Google cuts titles off after about 60 characters.' : 'A very short title wastes space that could describe the page.',
        steps: ['Rewrite the title to 30–60 characters, main topic first.'] });
    } else passed++;

    if (!p.meta_description) {
      add({ check: 'missing-meta-description', severity: 'high', area: 'on-page', url: p.url, title: 'Missing meta description',
        why: 'This is the grey text under your result in Google. Without it, Google picks a random sentence, and fewer people click.',
        steps: ['Add a meta description of 120–155 characters that says what the page offers and who it is for.'],
        snippet: `<meta name="description" content="${escapeHtml((p.h1 || p.title).slice(0, 100))} — write 120–155 characters here.">` });
    } else if (p.meta_description.length > 160) {
      add({ check: 'meta-description-length', severity: 'low', area: 'on-page', url: p.url, title: 'Meta description too long',
        why: 'Google truncates descriptions after about 155 characters.', steps: ['Shorten it to 120–155 characters.'] });
    } else passed++;

    if (!p.h1) {
      add({ check: 'missing-h1', severity: 'high', area: 'on-page', url: p.url, title: 'No main heading (H1)',
        why: 'The H1 tells readers and search engines what the page is about.',
        steps: ['Add one <h1> near the top that states the page topic.'], snippet: `<h1>${escapeHtml(p.title || 'Page topic')}</h1>` });
    } else passed++;

    if (!p.canonical) {
      add({ check: 'missing-canonical', severity: 'medium', area: 'technical', url: p.url, title: 'No canonical link',
        why: 'Without it, copies of this page (with tracking codes, http/https, trailing slash) can compete with each other.',
        steps: ['Add a canonical link pointing at the main address of this page.'], snippet: `<link rel="canonical" href="${escapeHtml(p.url)}">` });
    } else passed++;

    if (p.images_missing_alt > 0) {
      add({ check: 'images-missing-alt', severity: p.images_missing_alt > 5 ? 'high' : 'medium', area: 'on-page', url: p.url,
        title: `${p.images_missing_alt} image${p.images_missing_alt > 1 ? 's' : ''} without alt text`,
        why: 'Alt text is read aloud to blind visitors and is how search engines understand images.',
        steps: ['Give every meaningful image a short description in its alt attribute.', 'Use alt="" for purely decorative images.'],
        snippet: '<img src="…" alt="Short description of what the image shows">' });
    } else passed++;

    if (path === '/') {
      const types = typesOf(p);
      // Older crawls only know yes/no; with no list of kinds, "has some" has to count.
      const known = p.schema_types !== undefined && (types.length > 0 || !p.has_schema);
      const hasIdentity = known ? types.some((t) => IDENTITY_TYPES.includes(t)) : !!p.has_schema;
      if (!hasIdentity) {
        const block = identitySchema(site.business ?? { name, url: new URL(p.url).origin, sameAs: [] });
        const missingLinks = !(block.sameAs as string[] | undefined)?.length;
        const where = site.builder !== undefined ? HEAD_CODE[site.builder] : undefined;
        if (where === null) {
          add({ check: 'missing-identity-schema', severity: 'medium', area: 'ai-search', url: p.url,
            title: 'No structured data — and Google Sites cannot add it',
            why: 'Structured data is a hidden label that tells Google and AI assistants exactly who you are. Google Sites does not let you add it (or edit robots.txt) — its "Embed code" box puts code in a separate frame, which does not count for your page.',
            steps: [
              'You can still help AI assistants recognise you: say clearly on the home page, in plain words, who you are, what you offer, where, and how to reach you.',
              'Link from the site to your profiles elsewhere (YouTube, Facebook, Instagram), and back from them to the site.',
              'Fill in a Google Business Profile — Google and its AI answers read it directly.',
              'If AI search matters a lot to you, a builder that allows custom code (WordPress, Wix, Webflow, Squarespace) would let you add this. Plume can then give you the code.',
            ] });
        } else {
          const block = identitySchema(site.business ?? { name, url: new URL(p.url).origin, sameAs: [] });
          const missingLinks = !(block.sameAs as string[] | undefined)?.length;
          add({ check: 'missing-identity-schema', severity: 'high', area: 'ai-search', url: p.url,
            title: p.has_schema ? 'Structured data does not say who the business is' : 'No structured data on the home page',
            why: 'Structured data is a hidden label that tells Google and AI assistants exactly who you are, what you do and which profiles elsewhere are yours. ' +
              'Without it they have to guess, and a business they are unsure about is less likely to be named in an answer.',
            steps: [
              where ?? 'Paste this into the <head> of your home page. Your site builder or developer can tell you where custom code goes.',
              'Check every value before you paste — Plume only filled in what it found on your site, and left out anything it was unsure of.',
              missingLinks
                ? 'Add your Facebook, Instagram, YouTube or LinkedIn page under "sameAs" — Plume found none on the site. Those links are how AI assistants tell you apart from businesses with similar names.'
                : 'Check the "sameAs" links: each should be a profile that belongs to this business.',
              'Test it at https://search.google.com/test/rich-results',
            ],
            snippet: `<script type="application/ld+json">\n${JSON.stringify(block, null, 2)}\n</script>` });
        }
      } else passed++;
      for (const t of types.filter((t) => RETIRED_RICH_RESULTS[t])) {
        add({ check: `retired-schema-${t}`, severity: 'low', area: 'ai-search', url: p.url, title: `${t} markup won't show as a special result`,
          why: `${RETIRED_RICH_RESULTS[t]} The markup does no harm and AI assistants can still read it, so keep it — just don't expect it to change how you look in Google.`,
          steps: ['Nothing to fix. Leave it in place.'] });
      }
    }

    // ---- checks on columns newer crawls record; rows from older crawls skip them ----
    if (p.meta_robots != null) {
      if (/noindex|\bnone\b/i.test(p.meta_robots)) {
        add({ check: 'noindex', severity: path === '/' ? 'critical' : 'high', area: 'technical', url: p.url, title: 'Page is hidden from Google',
          why: `This page tells Google not to list it ("${p.meta_robots}"). That is right for thank-you pages, logins and drafts, but on a page you want people to find, it can't rank at all.`,
          steps: [
            'If this page should be found in Google, remove the "noindex" setting.',
            site.builder === 'WordPress' ? 'In WordPress, check the page\'s SEO box (Yoast or Rank Math → Advanced → "Allow search engines to show this page") and Settings → Reading → "Discourage search engines" (must be off).' : 'Your site builder usually calls it "Hide from search engines" in the page\'s SEO settings.',
            'If it is meant to be hidden, mark this as fixed and it won\'t come back.',
          ] });
      } else passed++;
    }

    if (p.og != null) {
      const og = JSON.parse(p.og || '{}') as { title?: string; description?: string; image?: string };
      if (!og.title || !og.image) {
        const missing = [!og.title && 'og:title', !og.image && 'og:image', !og.description && 'og:description'].filter(Boolean);
        add({ check: 'missing-social-preview', severity: path === '/' ? 'medium' : 'low', area: 'on-page', url: p.url,
          title: og.image ? 'No title for social previews' : 'No social preview image',
          why: 'When someone shares this page on WhatsApp, Facebook, LinkedIn or X, these tags choose the picture and headline. Without them the share is a plain link, and fewer people click.',
          steps: [`Add the missing tags (${missing.join(', ')}) to the page <head>. Many builders have a "Social share" or "Open Graph" box in the page settings.`, 'Use an image of at least 1200×630 pixels.', 'Check it at https://www.opengraph.xyz/'],
          snippet: [
            `<meta property="og:title" content="${escapeHtml(og.title || p.title || p.h1)}">`,
            `<meta property="og:description" content="${escapeHtml(og.description || p.meta_description)}">`,
            `<meta property="og:image" content="${escapeHtml(og.image || `${new URL(p.url).origin}/social-preview.jpg`)}">`,
            `<meta property="og:url" content="${escapeHtml(p.url)}">`,
          ].join('\n') });
      } else passed++;
    }

    if (p.hero_lazy) {
      add({ check: 'hero-image-lazy', severity: 'medium', area: 'performance', url: p.url, title: 'Main image loads late',
        why: 'The first big image on the page is set to load "lazily" — only once the browser is sure it is needed. For the image visitors see first, that adds a delay before the page looks ready, and Google counts that in its speed score.',
        steps: ['Remove loading="lazy" from the first image on the page (keep it on images further down).', 'Optionally add fetchpriority="high" to that image.'],
        snippet: '<img src="…" alt="…" fetchpriority="high">' });
    } else if (p.hero_lazy != null) passed++;

    if (p.images_no_size != null) {
      if (p.images_no_size >= 3) {
        add({ check: 'images-no-size', severity: 'low', area: 'performance', url: p.url, title: `${p.images_no_size} images without a set size`,
          why: 'Images without a width and height make the page jump as they load: the text moves while people are reading or about to tap. Google measures this as "layout shift".',
          steps: ['Give each image its width and height (the size of the original file is fine; CSS can still resize it).'],
          snippet: '<img src="photo.jpg" alt="…" width="1200" height="800">' });
      } else passed++;
    }

    if (p.word_count < 250 && path !== '/') {
      add({ check: 'thin-content', severity: 'low', area: 'content', url: p.url, title: `Only ${p.word_count} words`,
        why: 'Very short pages rarely rank, because they rarely answer a question fully.',
        steps: ['Expand the page with the questions a buyer would ask, or merge it into a related page.'] });
    } else passed++;

    // Only pages that state a date: plenty of pages (contact, pricing) rightly have none.
    if (p.page_date && path !== '/') {
      const months = ((site.now ?? new Date()).getTime() - new Date(p.page_date).getTime()) / (30.44 * 86400e3);
      if (months > 18) {
        add({ check: 'stale-page', severity: months > 36 ? 'medium' : 'low', area: 'content', url: p.url,
          title: `Last updated ${Math.floor(months / 12) >= 2 ? `${Math.floor(months / 12)} years` : `${Math.round(months)} months`} ago`,
          why: 'Google and AI assistants prefer pages that are clearly current. An old date on a guide makes readers and machines wonder whether it is still right.',
          steps: ['Re-read the page and fix anything out of date (prices, rules, dates, screenshots).', 'Then update its "last updated" date.', 'If it is still entirely correct, just update the date — that is honest and it helps.'] });
      } else passed++;
    }
  }

  for (const [title, urls] of titleCounts) {
    if (urls.length < 2) continue;
    for (const url of urls.slice(1)) {
      add({ check: 'duplicate-title', severity: 'high', area: 'on-page', url, title: `Same title as ${urls.length - 1} other page(s)`,
        why: `"${title}" is used on ${urls.length} pages, so Google can't tell which one to show.`,
        steps: ['Give each page its own title describing what is unique about it.'] });
    }
  }

  // ---- pages nothing links to: Google finds them late and treats them as unimportant ----
  if (site.crawlComplete && pages.some((p) => p.links_out != null)) {
    const linked = new Set<string>();
    for (const p of pages) for (const l of JSON.parse(p.links_out || '[]') as string[]) linked.add(l);
    const live = pages.filter((p) => p.status < 400 && new URL(p.url).pathname !== '/' && !/noindex/i.test(p.meta_robots ?? ''));
    const orphans = live.filter((p) => !linked.has(p.url));
    for (const p of orphans.slice(0, 10)) {
      add({ check: 'orphan-page', severity: 'medium', area: 'technical', url: p.url, title: 'No other page links here',
        why: 'Plume only found this page through the sitemap. Pages without links from the rest of the site are found late by Google, rank as less important, and visitors can\'t reach them.',
        steps: ['Link to it from a related page, the menu or the footer, with words that say what it is about.', 'If it is an old page nobody needs, remove it from the sitemap or redirect it.'] });
    }
    if (!orphans.length) passed++;
  }

  // ---- language versions (hreflang) must point at each other ----
  const byUrl = new Map(pages.map((p) => [p.url.replace(/\/$/, ''), p]));
  for (const p of pages) {
    const links = JSON.parse(p.hreflang || '[]') as { lang: string; href: string }[];
    if (!links.length) continue;
    const problems: string[] = [];
    const bad = links.filter((l) => l.lang.toLowerCase() !== 'x-default' && !/^[a-z]{2,3}(-([a-z]{2}|\d{3}|[a-z]{4}))?$/i.test(l.lang));
    if (bad.length) problems.push(`Language codes Google doesn't understand: ${bad.map((l) => `"${l.lang}"`).join(', ')} (use codes like "en", "he" or "en-GB"; "uk" is Ukrainian, Britain is "en-GB").`);
    if (!links.some((l) => l.href.replace(/\/$/, '') === p.url.replace(/\/$/, '')))
      problems.push('The page does not list itself among its language versions — Google needs each version to include its own address too.');
    for (const l of links) {
      const other = byUrl.get(l.href.replace(/\/$/, ''));
      if (!other || other.url === p.url || other.hreflang == null) continue;
      const back = JSON.parse(other.hreflang || '[]') as { href: string }[];
      if (!back.some((b) => b.href.replace(/\/$/, '') === p.url.replace(/\/$/, '')))
        problems.push(`${other.url} (${l.lang}) doesn't link back to this page, so Google ignores the pair.`);
    }
    if (problems.length) {
      add({ check: 'hreflang-errors', severity: 'medium', area: 'technical', url: p.url, title: 'Language versions are not linked correctly',
        why: 'The "hreflang" tags tell Google which language version to show to whom. When they are wrong, Google may show the English page to Hebrew speakers, or ignore the tags altogether.',
        steps: [...problems, 'Most multilingual plugins (WPML, Polylang, Weglot) and builders write these for you — check their settings rather than editing by hand.'] });
    } else passed++;
  }

  if (site.httpsRedirect === false && pages[0]) {
    const host = new URL(pages[0].url).host;
    add({ check: 'no-https-redirect', severity: 'high', area: 'technical', url: `http://${host}/`, title: 'The http:// address does not move visitors to https://',
      why: 'Old links and people typing the address can land on the unsafe http:// version. Browsers mark it "Not secure", and Google may see two copies of the site.',
      steps: ['Turn on "Always use HTTPS" (or "Force HTTPS") in your host or site builder settings.', 'On Cloudflare: SSL/TLS → Edge Certificates → Always Use HTTPS.', `Then open http://${host}/ and check it switches to https://.`] });
  } else if (site.httpsRedirect) passed++;

  if (site.robotsOk === false) {
    add({ check: 'missing-robots', severity: 'low', area: 'technical', url: pages[0]?.url ?? '', title: 'No robots.txt',
      why: 'Not harmful by itself, but it is where you point search engines at your sitemap.',
      steps: ['Create /robots.txt with the lines below.'], snippet: `User-agent: *\nAllow: /\nSitemap: ${pages[0] ? new URL(pages[0].url).origin : ''}/sitemap.xml` });
  } else if (site.robotsOk) passed++;
  if (site.sitemapOk === false) {
    add({ check: 'missing-sitemap', severity: 'high', area: 'technical', url: pages[0]?.url ?? '', title: 'No sitemap.xml',
      why: 'A sitemap lists every page so search engines find new content quickly.',
      steps: ['Most site builders can generate one in settings. Otherwise create /sitemap.xml listing each page.'] });
  } else if (site.sitemapOk) passed++;

  // ---- AI search: can the AI services read the site at all? ----
  if (site.robots !== undefined && pages[0]) {
    const origin = new URL(pages[0].url).origin;
    const access = aiAccess(site.robots);
    const blocked = access.filter((c) => c.kind === 'search' && !c.allowed);
    if (blocked.length) {
      const all = blocked.length === access.filter((c) => c.kind === 'search').length;
      const ownGroup = blocked.filter((c) => c.named);
      add({ check: 'ai-crawlers-blocked', severity: all ? 'critical' : 'high', area: 'ai-search', url: `${origin}/robots.txt`,
        title: all ? 'Your robots.txt blocks every AI assistant' : `Your robots.txt blocks ${blocked.map((c) => c.owner).filter((o, i, a) => a.indexOf(o) === i).join(', ')}`,
        why: `These can't read your site, so they can't recommend you or quote you when someone asks them: ${blocked.map((c) => `${c.agent} (${c.what})`).join('; ')}. ` +
          'More and more people ask an AI assistant instead of searching. Blocking the ones that only collect text for training is fine and is not counted here.',
        steps: [
          ownGroup.length
            ? `Your robots.txt names ${ownGroup.map((c) => c.agent).join(', ')} and blocks ${ownGroup.length > 1 ? 'them' : 'it'}. Find those lines and change "Disallow: /" to "Allow: /" (or delete the lines).`
            : 'Add the lines below to your robots.txt (at the end is fine). They only let these assistants in; nothing else changes.',
          ROBOTS_EDIT[site.builder ?? ''] ?? 'Your site builder or host controls robots.txt; look for "robots.txt" in its SEO settings, or ask your developer.',
          `Check the result at ${origin}/robots.txt`,
        ],
        snippet: ownGroup.length ? undefined : unblockSnippet(blocked) });
    } else passed++;
    if (site.cloudflare) {
      add({ check: 'cloudflare-ai-block', severity: 'medium', area: 'ai-search', url: origin, title: 'Check Cloudflare is not blocking AI assistants',
        why: 'Your site uses Cloudflare. Cloudflare can block AI assistants on its own side, which robots.txt does not show — and for new sites it is often on by default.',
        steps: ['Sign in to Cloudflare and open your site.', 'Go to Security → Bots (or "AI Crawl Control").', 'Make sure "Block AI bots" is off, or allow at least ChatGPT, Claude, Perplexity and Google.', 'Then mark this as fixed.'] });
    }
  }

  issues.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.url.localeCompare(b.url));
  const penalty = issues.reduce((s, i) => s + WEIGHT[i.severity], 0);
  const possible = penalty + passed * 2;
  const score = possible ? Math.round(100 * (1 - penalty / possible)) : 100;
  return {
    score: Math.max(0, Math.min(100, score)),
    counts: {
      critical: issues.filter((i) => i.severity === 'critical').length,
      warnings: issues.filter((i) => i.severity !== 'critical').length,
      passed,
    },
    issues,
    pagesChecked: pages.length,
    at: new Date().toISOString(),
  };
}

async function exists(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { method: 'GET' })).ok;
  } catch {
    return false;
  }
}

/** Does http://host/ end up on https://? Undefined when the http address can't be reached at all (nothing to fix then). */
async function redirectsToHttps(origin: string): Promise<boolean | undefined> {
  try {
    const res = await fetch(origin.replace(/^https:/, 'http:'), { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    return res.url.startsWith('https://');
  } catch {
    return undefined;
  }
}

/** Audit the latest crawl, save it, and return it. */
export async function runAudit(origin?: string): Promise<AuditResult> {
  const pages = getDb().prepare('SELECT * FROM pages').all() as PageRow[];
  const site: SiteFacts = origin ? { robotsOk: await exists(`${origin}/robots.txt`), sitemapOk: await exists(`${origin}/sitemap.xml`) } : {};
  // Read from the last crawl; a site crawled before these were recorded simply skips those checks.
  const robots = getSetting<{ body: string | null } | null>('robotsTxt', null);
  if (robots) site.robots = robots.body;
  const tech = getSetting<{ list: { name: string; kind: string }[] }>('techSignals', { list: [] }).list ?? [];
  site.cloudflare = tech.some((t) => t.name === 'Cloudflare');
  site.builder = tech.find((t) => t.kind === 'builder' && t.name in HEAD_CODE)?.name;
  site.crawlComplete = getSetting<boolean>('crawlComplete', false);
  if (origin?.startsWith('https://')) site.httpsRedirect = await redirectsToHttps(origin);
  if (origin) site.business = businessFacts(origin, pages);
  const result = auditPages(pages, site);
  setSetting('lastAudit', result);
  saveAuditHistory(result);
  return result;
}

/**
 * Today's fixes: the two most severe open issues not handed out before.
 * Same day = same two, so refreshing the page doesn't reshuffle them.
 */
export function dailyFixes(audit: AuditResult, perDay = 2, today = new Date().toISOString().slice(0, 10)): Issue[] {
  const log = getSetting<{ day: string; ids: string[]; given: string[]; done: string[] }>('dailyFixes', { day: '', ids: [], given: [], done: [] });
  // Problems the user sent over by hand come first, on top of the daily two, until marked fixed.
  const pinned = pinnedIssues().filter((i) => !log.done.includes(i.id));
  if (log.day === today)
    return [...pinned, ...log.ids.filter((id) => !log.done.includes(id)).map((id) => audit.issues.find((i) => i.id === id)).filter((i): i is Issue => !!i)];
  const skip = new Set([...log.given, ...log.done]);
  const pick = audit.issues.filter((i) => !skip.has(i.id)).slice(0, perDay);
  setSetting('dailyFixes', { day: today, ids: pick.map((i) => i.id), given: [...log.given, ...pick.map((i) => i.id)], done: log.done });
  return [...pinned, ...pick];
}

export function markFixDone(id: string): void {
  const log = getSetting<{ day: string; ids: string[]; given: string[]; done: string[] }>('dailyFixes', { day: '', ids: [], given: [], done: [] });
  if (!log.done.includes(id)) log.done.push(id);
  setSetting('dailyFixes', log);
  setSetting('pinnedIssues', pinnedIssues().filter((i) => i.id !== id));
}

export function pinnedIssues(): Issue[] {
  return getSetting<Issue[]>('pinnedIssues', []);
}

/** Put a problem in today's fixes now (e.g. from the speed panel). Re-sending replaces the old copy. */
export function pinIssue(issue: Issue): void {
  const log = getSetting<{ day: string; ids: string[]; given: string[]; done: string[] }>('dailyFixes', { day: '', ids: [], given: [], done: [] });
  setSetting('dailyFixes', { ...log, done: log.done.filter((d) => d !== issue.id) });
  setSetting('pinnedIssues', [issue, ...pinnedIssues().filter((i) => i.id !== issue.id)]);
}

/** What Plume knows about the business, for its structured data. Only facts found on the site or entered by the owner. */
function businessFacts(origin: string, pages: PageRow[]): BusinessFacts {
  const { brandProfiles, listPeople } = require('../context/extra') as typeof import('../context/extra');
  const { contentLanguage } = require('../context/language') as typeof import('../context/language');
  const home = getSetting<{ phone: string | null; email: string | null; profiles: string[]; logo: string | null } | null>('homeFacts', null);
  const brand = brandProfiles();
  const sameAs = new Set(home?.profiles ?? []);
  if (brand.x) sameAs.add(`https://x.com/${brand.x}`);
  if (brand.linkedin) sameAs.add(brand.linkedin);
  if (brand.facebook) sameAs.add(brand.facebook);
  const founder = listPeople()[0];
  const homePage = pages.find((p) => new URL(p.url).pathname === '/') ?? pages[0];
  return {
    name: siteName(pages),
    url: origin,
    description: homePage?.meta_description || undefined,
    logo: home?.logo ?? null,
    // A phone number on the home page is the plainest sign of a local service.
    local: !!home?.phone,
    phone: home?.phone ?? null,
    email: home?.email ?? null,
    sameAs: [...sameAs],
    founder: founder
      ? { name: founder.name, role: founder.role || undefined, sameAs: [founder.linkedinUrl, founder.xHandle && `https://x.com/${founder.xHandle}`].filter(Boolean) as string[] }
      : null,
    language: pageLanguage(pages, contentLanguage()),
  };
}

/**
 * The site's language for the structured data, only when Plume is sure of it. A wrong language is worse than none:
 * some builders (Google Sites) mark every page "en-US" whatever it is written in, and some sites mix several.
 */
function pageLanguage(pages: PageRow[], saved: string): string | undefined {
  const text = pages.map((p) => (p as PageRow & { text?: string }).text ?? '').join(' ').slice(0, 40000);
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
  if (!letters) return undefined;
  const share = (re: RegExp) => (text.match(re) ?? []).length / letters;
  const scripts: [string, number][] = [
    ['he', share(/[\u0590-\u05FF]/g)],
    ['ar', share(/[\u0600-\u06FF]/g)],
    ['ru', share(/[\u0400-\u04FF]/g)],
    ['latin', share(/[a-zA-Z\u00C0-\u024F]/g)],
  ];
  const [top, n] = scripts.sort((a, b) => b[1] - a[1])[0];
  // Mixed sites (several languages at once) get no language rather than one that's only partly true.
  if (n < 0.8) return undefined;
  if (top !== 'latin') return top;
  // Latin script: trust the saved language only when it is a Latin-script one.
  return ['he', 'ar', 'ru'].includes(saved) ? undefined : saved;
}

/** Exposed for tests only. */
export const pageLanguageForTests = pageLanguage;
