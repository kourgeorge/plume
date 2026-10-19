import { getDb } from '../db';

/**
 * Changes on the site's own pages between two reads, worst first. A theme update or a plugin can quietly
 * hide a page from Google or drop its title; this catches it on the next daily read instead of weeks later
 * in the traffic numbers. Based on the drift rules in claude-seo (MIT).
 */

export type ChangeSeverity = 'critical' | 'high' | 'low';

export interface PageChange {
  url: string;
  check: string;
  severity: ChangeSeverity;
  /** Plain words: what happened and why it matters. */
  text: string;
  before?: string;
  after?: string;
}

/** A saved row of the `pages` table. Columns added later are missing (undefined or null) on older rows. */
export interface PageRow {
  url: string; status: number; title: string; meta_description: string; canonical: string;
  h1: string; headings: string; images_missing_alt: number; has_schema: number; word_count: number;
  schema_types?: string;
  page_date?: string | null;
  meta_robots?: string | null;
  og?: string | null;
  links_out?: string | null;
  images_no_size?: number | null;
  hero_lazy?: number | null;
  hreflang?: string | null;
}

/** What a fresh read knows about a page (a CrawledPage, or just a status for one that failed). */
export interface PageNow {
  url: string;
  status: number;
  title?: string;
  metaDescription?: string;
  canonical?: string;
  h1?: string;
  wordCount?: number;
  schemaTypes?: string[];
  metaRobots?: string;
  og?: { image: string };
}

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

/** Same address written differently (trailing slash, upper-case host) is not a change. */
const sameUrl = (a: string, b: string, base: string) => {
  const norm = (u: string) => {
    try {
      const x = new URL(u, base);
      return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/$/, '')}${x.search}`;
    } catch {
      return u.trim();
    }
  };
  return norm(a) === norm(b);
};

const noindex = (s: string | null | undefined) => /noindex|\bnone\b/i.test(s ?? '');

/** Compare the saved copy of a page with what was just read. No saved copy = first read = nothing to report. */
export function pageChanges(before: PageRow | undefined, now: PageNow): PageChange[] {
  if (!before) return [];
  const out: PageChange[] = [];
  const add = (c: Omit<PageChange, 'url'>) => out.push({ url: now.url, ...c });
  const wasOk = before.status < 400;

  if (now.status >= 400) {
    if (wasOk) add({ check: 'page-broken', severity: 'critical', text: `The page now returns error ${now.status}. Visitors and Google hit a dead end, and it will drop out of Google within days.`, before: String(before.status), after: String(now.status) });
    return out;
  }
  if (!wasOk) {
    add({ check: 'page-back', severity: 'low', text: 'The page works again.', before: String(before.status), after: String(now.status) });
    return out;
  }

  // Only compare what both reads recorded: rows from older versions of Plume lack the newer columns.
  if (before.meta_robots != null && !noindex(before.meta_robots) && noindex(now.metaRobots))
    add({ check: 'noindex-added', severity: 'critical', text: 'The page is now hidden from Google (a "noindex" tag was added). Unless that was on purpose, it will disappear from search results.', before: before.meta_robots || '(none)', after: now.metaRobots });
  if (before.meta_robots != null && noindex(before.meta_robots) && !noindex(now.metaRobots))
    add({ check: 'noindex-removed', severity: 'low', text: 'The page can now appear in Google again (the "noindex" tag was removed).', before: before.meta_robots, after: now.metaRobots || '(none)' });

  if (before.canonical && !now.canonical)
    add({ check: 'canonical-removed', severity: 'critical', text: 'The canonical link was removed, so Google has to guess which address is the main one.', before: before.canonical });
  else if (before.canonical && now.canonical && !sameUrl(before.canonical, now.canonical, now.url))
    add({ check: 'canonical-changed', severity: 'critical', text: 'The canonical link now points somewhere else. Google may pass this page\'s ranking to that address instead.', before: before.canonical, after: now.canonical });

  const typesBefore = json<string[]>(before.schema_types, []);
  const typesNow = now.schemaTypes ?? [];
  if (typesBefore.length && !typesNow.length)
    add({ check: 'schema-removed', severity: 'critical', text: 'All structured data was removed. Google and AI assistants lose the label that says what this page and business are.', before: typesBefore.join(', ') });
  else {
    const lost = typesBefore.filter((t) => !typesNow.includes(t));
    if (lost.length) add({ check: 'schema-changed', severity: 'high', text: `Some structured data was removed: ${lost.join(', ')}.`, before: typesBefore.join(', '), after: typesNow.join(', ') });
  }

  if (before.title && !now.title)
    add({ check: 'title-removed', severity: 'critical', text: 'The page lost its title, the headline Google shows in results.', before: before.title });
  else if (before.title && now.title && before.title !== now.title)
    add({ check: 'title-changed', severity: 'high', text: 'The title changed. Rankings for this page can move for a few weeks while Google re-reads it.', before: before.title, after: now.title });

  if (before.h1 && !now.h1)
    add({ check: 'h1-removed', severity: 'critical', text: 'The main heading (H1) is gone.', before: before.h1 });
  else if (before.h1 && now.h1 && before.h1 !== now.h1)
    add({ check: 'h1-changed', severity: 'high', text: 'The main heading (H1) changed.', before: before.h1, after: now.h1 });

  if (before.meta_description && !now.metaDescription)
    add({ check: 'description-removed', severity: 'high', text: 'The meta description was removed, so Google will pick its own text for this page.', before: before.meta_description });
  else if (before.meta_description && now.metaDescription && before.meta_description !== now.metaDescription)
    add({ check: 'description-changed', severity: 'low', text: 'The meta description changed.', before: before.meta_description, after: now.metaDescription });

  const imgBefore = json<{ image?: string }>(before.og, {}).image;
  if (imgBefore && !now.og?.image)
    add({ check: 'og-image-removed', severity: 'high', text: 'The social preview image was removed. Shares on Facebook, LinkedIn and WhatsApp now show no picture.', before: imgBefore });

  if (before.word_count >= 200 && now.wordCount !== undefined && now.wordCount < before.word_count * 0.5)
    add({ check: 'content-shrank', severity: 'high', text: `The page lost most of its text (${before.word_count} → ${now.wordCount} words). If that wasn't intended, part of the page may not be loading.`, before: String(before.word_count), after: String(now.wordCount) });

  return out;
}

const RANK: Record<ChangeSeverity, number> = { critical: 0, high: 1, low: 2 };

/** Keep what one read found, as one Dashboard card. Nothing found = nothing saved. */
export function savePageChanges(changes: PageChange[], at = new Date().toISOString()): number | null {
  if (!changes.length) return null;
  const sorted = [...changes].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.url.localeCompare(b.url));
  return Number(getDb().prepare('INSERT INTO page_changes (at, changes) VALUES (?, ?)').run(at, JSON.stringify(sorted)).lastInsertRowid);
}

export interface PageChangeCard {
  id: number;
  at: string;
  changes: PageChange[];
  worst: ChangeSeverity;
  sent: boolean;
}

const toCard = (r: any): PageChangeCard => {
  const changes = json<PageChange[]>(r.changes, []);
  return { id: r.id, at: r.at, changes, worst: changes[0]?.severity ?? 'low', sent: !!r.sent };
};

export function openPageChanges(): PageChangeCard[] {
  return (getDb().prepare('SELECT * FROM page_changes WHERE dismissed = 0 ORDER BY id DESC').all() as any[]).map(toCard);
}

export function dismissPageChange(id: number): void {
  getDb().prepare('UPDATE page_changes SET dismissed = 1 WHERE id = ?').run(id);
}

/** Serious changes not yet sent to the phone; marking them sent is the caller's job once they went out. */
export function unsentSerious(): PageChangeCard[] {
  return (getDb().prepare('SELECT * FROM page_changes WHERE dismissed = 0 AND sent = 0 ORDER BY id').all() as any[])
    .map(toCard)
    .filter((c) => c.worst === 'critical');
}

export function markPageChangeSent(id: number): void {
  getDb().prepare('UPDATE page_changes SET sent = 1 WHERE id = ?').run(id);
}
