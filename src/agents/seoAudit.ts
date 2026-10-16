import { getDb, getSetting, setSetting } from '../db';
import { escapeHtml } from '../publish';

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Area = 'technical' | 'on-page' | 'content' | 'performance';

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

interface PageRow {
  url: string; status: number; title: string; meta_description: string; canonical: string;
  h1: string; headings: string; images_missing_alt: number; has_schema: number; word_count: number;
}

const WEIGHT: Record<Severity, number> = { critical: 10, high: 5, medium: 2, low: 1 };
const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function siteName(pages: PageRow[]): string {
  const home = pages.find((p) => new URL(p.url).pathname === '/') ?? pages[0];
  return (home?.title.split(/[|–—-]/)[0] ?? '').trim() || new URL(home.url).hostname;
}

/** Every check runs on the crawl already in the database — no extra requests. */
export function auditPages(pages: PageRow[], site: { robotsOk?: boolean; sitemapOk?: boolean } = {}): AuditResult {
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

    if (!p.has_schema && path === '/') {
      add({ check: 'missing-schema', severity: 'medium', area: 'technical', url: p.url, title: 'No structured data on the home page',
        why: 'Structured data tells Google and AI assistants exactly who you are, which helps you get named in answers.',
        steps: ['Paste this into the <head> of the home page and fill in the blanks.'],
        snippet: `<script type="application/ld+json">\n${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name, url: new URL(p.url).origin, logo: '', sameAs: [] }, null, 2)}\n</script>` });
    } else if (path === '/') passed++;

    if (p.word_count < 250 && path !== '/') {
      add({ check: 'thin-content', severity: 'low', area: 'content', url: p.url, title: `Only ${p.word_count} words`,
        why: 'Very short pages rarely rank, because they rarely answer a question fully.',
        steps: ['Expand the page with the questions a buyer would ask, or merge it into a related page.'] });
    } else passed++;
  }

  for (const [title, urls] of titleCounts) {
    if (urls.length < 2) continue;
    for (const url of urls.slice(1)) {
      add({ check: 'duplicate-title', severity: 'high', area: 'on-page', url, title: `Same title as ${urls.length - 1} other page(s)`,
        why: `"${title}" is used on ${urls.length} pages, so Google can't tell which one to show.`,
        steps: ['Give each page its own title describing what is unique about it.'] });
    }
  }

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

/** Audit the latest crawl, save it, and return it. */
export async function runAudit(origin?: string): Promise<AuditResult> {
  const pages = getDb().prepare('SELECT * FROM pages').all() as PageRow[];
  const site = origin ? { robotsOk: await exists(`${origin}/robots.txt`), sitemapOk: await exists(`${origin}/sitemap.xml`) } : {};
  const result = auditPages(pages, site);
  setSetting('lastAudit', result);
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
