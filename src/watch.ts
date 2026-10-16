import * as cheerio from 'cheerio';
import { getDb } from './db';
import { Competitor, getCompetitor, listCompetitors } from './context/extra';
import { USER_AGENT, fetchPage } from './research/fetchPage';

/** What we remember about a competitor's site between checks. */
export interface Snapshot {
  pages: string[];      // paths from their sitemap (or homepage links when there is no sitemap)
  headline: string;     // homepage <h1>
  title: string;
  description: string;  // homepage meta description
  prices: string[];     // price-looking strings on the homepage and pricing page
}

export interface Change {
  kind: 'new-pages' | 'removed-pages' | 'headline' | 'description' | 'prices' | 'unreachable';
  text: string;
  items?: string[];
}

const PRICE_RE = /(?:[$€£₪]\s?\d[\d,.]*(?:\s?\/\s?(?:month|mo|year|yr))?|\d[\d,.]*\s?(?:₪|€|USD|EUR|ILS|ש"ח|ש״ח)(?:\s?\/\s?(?:month|mo|year|yr))?)/gi;

export function findPrices(text: string): string[] {
  return [...new Set((text.match(PRICE_RE) ?? []).map((p) => p.replace(/\s+/g, ' ').trim()))].slice(0, 30).sort();
}

function pathOnly(u: string, origin: string): string | null {
  try {
    const x = new URL(u, origin);
    if (x.origin.replace('://www.', '://') !== origin.replace('://www.', '://')) return null;
    return x.pathname.replace(/\/$/, '') || '/';
  } catch {
    return null;
  }
}

async function sitemapPaths(origin: string, fetchFn: typeof fetch): Promise<string[]> {
  try {
    const res = await fetchFn(`${origin}/sitemap.xml`, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return [];
    const $ = cheerio.load(await res.text(), { xml: true });
    const locs = $('loc').map((_, el) => $(el).text().trim()).get();
    // A sitemap index points at more sitemaps: read up to five of them.
    const nested = locs.filter((l) => /\.xml(\.gz)?$/i.test(l)).slice(0, 5);
    const pages = locs.filter((l) => !/\.xml(\.gz)?$/i.test(l));
    for (const n of nested) {
      try {
        const r = await fetchFn(n, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
        if (r.ok) {
          const $$ = cheerio.load(await r.text(), { xml: true });
          pages.push(...$$('loc').map((_, el) => $$(el).text().trim()).get());
        }
      } catch {
        /* skip that part of the sitemap */
      }
    }
    return [...new Set(pages.map((p) => pathOnly(p, origin)).filter((p): p is string => !!p))].sort();
  } catch {
    return [];
  }
}

/** Read a competitor's site now. Uses the same reader as research, so blocked or JavaScript sites work too. */
export async function takeSnapshot(origin: string, opts: { fetchFn?: typeof fetch; browserFn?: any } = {}): Promise<Snapshot> {
  const fetchFn = opts.fetchFn ?? fetch;
  const home = await fetchPage(`${origin}/`, { fetchFn, browserFn: opts.browserFn });
  if (!home.ok) throw new Error(home.reason);
  const $ = cheerio.load(home.html);
  const links = $('a[href]').map((_, el) => $(el).attr('href') ?? '').get();
  let pages = await sitemapPaths(origin, fetchFn);
  if (!pages.length) pages = [...new Set(links.map((l) => pathOnly(l, origin)).filter((p): p is string => !!p))].sort();
  let priceText = $('body').text();
  const pricing = pages.find((p) => /pric|plans|מחיר|מחירון/i.test(p));
  if (pricing) {
    const r = await fetchPage(`${origin}${pricing}`, { fetchFn, browserFn: opts.browserFn });
    if (r.ok) priceText += ' ' + cheerio.load(r.html)('body').text();
  }
  return {
    pages: pages.slice(0, 2000),
    headline: $('h1').first().text().replace(/\s+/g, ' ').trim(),
    title: $('title').first().text().trim(),
    description: $('meta[name="description"]').attr('content')?.trim() ?? '',
    prices: findPrices(priceText),
  };
}

const list = (xs: string[], max = 8) => (xs.length > max ? [...xs.slice(0, max), `…and ${xs.length - max} more`] : xs);

/** Plain-English differences between two snapshots. Small sitemaps churn, so a single page added counts; removal needs two. */
export function compare(before: Snapshot, after: Snapshot): Change[] {
  const out: Change[] = [];
  const was = new Set(before.pages);
  const now = new Set(after.pages);
  const added = after.pages.filter((p) => !was.has(p));
  const removed = before.pages.filter((p) => !now.has(p));
  // A sitemap that vanished entirely is a fetch hiccup, not a site that deleted everything.
  const sitemapLost = before.pages.length > 5 && after.pages.length === 0;
  if (added.length) out.push({ kind: 'new-pages', text: `added ${added.length} page${added.length > 1 ? 's' : ''}`, items: list(added) });
  if (removed.length >= 2 && !sitemapLost) out.push({ kind: 'removed-pages', text: `removed ${removed.length} pages`, items: list(removed) });
  if (before.headline && after.headline && before.headline !== after.headline)
    out.push({ kind: 'headline', text: `changed their homepage headline from "${before.headline}" to "${after.headline}"` });
  if (before.description && after.description && before.description !== after.description)
    out.push({ kind: 'description', text: `rewrote their Google description: "${after.description}"` });
  const pricesGone = before.prices.filter((p) => !after.prices.includes(p));
  const pricesNew = after.prices.filter((p) => !before.prices.includes(p));
  if (before.prices.length && (pricesGone.length || pricesNew.length))
    out.push({ kind: 'prices', text: `changed prices${pricesGone.length ? `: ${pricesGone.join(', ')} gone` : ''}${pricesNew.length ? `${pricesGone.length ? ';' : ':'} now ${pricesNew.join(', ')}` : ''}` });
  return out;
}

function lastSnapshot(id: number): Snapshot | null {
  const r = getDb().prepare('SELECT data FROM competitor_snapshots WHERE competitor_id = ? ORDER BY at DESC LIMIT 1').get(id) as { data: string } | undefined;
  return r ? JSON.parse(r.data) : null;
}

/** Check one competitor: save a new snapshot and record any changes since the last one. */
export async function checkCompetitor(c: Competitor, opts: { fetchFn?: typeof fetch; browserFn?: any; now?: Date } = {}): Promise<Change[]> {
  if (!c.url) throw new Error(`${c.name} has no website`);
  const at = (opts.now ?? new Date()).toISOString();
  const before = lastSnapshot(c.id);
  let after: Snapshot;
  try {
    after = await takeSnapshot(c.url, opts);
  } catch (err: any) {
    const changes: Change[] = [{ kind: 'unreachable', text: `couldn't be checked: ${err.message}` }];
    // Only worth telling the user when it was readable before.
    if (before) getDb().prepare('INSERT INTO competitor_changes (competitor_id, at, changes) VALUES (?, ?, ?)').run(c.id, at, JSON.stringify(changes));
    return changes;
  }
  getDb().prepare('INSERT INTO competitor_snapshots (competitor_id, at, data) VALUES (?, ?, ?)').run(c.id, at, JSON.stringify(after));
  // Keep the last 10 snapshots per competitor.
  getDb()
    .prepare('DELETE FROM competitor_snapshots WHERE competitor_id = ? AND at NOT IN (SELECT at FROM competitor_snapshots WHERE competitor_id = ? ORDER BY at DESC LIMIT 10)')
    .run(c.id, c.id);
  if (!before) return []; // first look: nothing to compare yet
  const changes = compare(before, after);
  if (changes.length) getDb().prepare('INSERT INTO competitor_changes (competitor_id, at, changes) VALUES (?, ?, ?)').run(c.id, at, JSON.stringify(changes));
  return changes;
}

/** The weekly task: every watched competitor, one after another. */
export async function checkWatched(opts: { fetchFn?: typeof fetch; browserFn?: any } = {}): Promise<{ checked: number; withChanges: number; failed: string[] }> {
  const watched = listCompetitors().filter((c) => c.watch && c.url);
  let withChanges = 0;
  const failed: string[] = [];
  for (const c of watched) {
    const ch = await checkCompetitor(c, opts);
    if (ch.some((x) => x.kind === 'unreachable')) failed.push(c.name);
    else if (ch.length) withChanges++;
  }
  return { checked: watched.length, withChanges, failed };
}

export interface ChangeCard {
  id: number;
  competitorId: number;
  name: string;
  url: string | null;
  at: string;
  changes: Change[];
}

export function openChanges(): ChangeCard[] {
  const rows = getDb().prepare('SELECT * FROM competitor_changes WHERE dismissed = 0 ORDER BY at DESC').all() as any[];
  return rows
    .map((r) => {
      const c = getCompetitor(r.competitor_id);
      return c ? { id: r.id, competitorId: c.id, name: c.name, url: c.url, at: r.at, changes: JSON.parse(r.changes) } : null;
    })
    .filter((x): x is ChangeCard => !!x);
}

export function dismissChange(id: number): void {
  getDb().prepare('UPDATE competitor_changes SET dismissed = 1 WHERE id = ?').run(id);
}

export function lastChecked(id: number): string | null {
  return (getDb().prepare('SELECT MAX(at) at FROM competitor_snapshots WHERE competitor_id = ?').get(id) as { at: string | null }).at;
}
