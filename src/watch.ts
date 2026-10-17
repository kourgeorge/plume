import * as cheerio from 'cheerio';
import { getDb } from './db';
import { MODELS } from './config';
import { askJson } from './llm/client';
import { BudgetExceeded } from './llm/budget';
import { Competitor, getCompetitor, listCompetitors, siteOrigin } from './context/extra';
import { USER_AGENT, fetchPage } from './research/fetchPage';

/**
 * Competitor watch. Two kinds of scan:
 * - site (free): reads their website and compares it with last time — new pages, headline, description, prices;
 * - news-social (AI + web search, costs money): recent LinkedIn and X posts and news about them, plus
 *   competitors in the same space that aren't on the list yet.
 * Every finding carries the page it came from, so the owner can check it.
 * The first scan of each kind is a baseline; later ones report changes, or "unchanged".
 */

/** What we remember about a competitor's site between checks. */
export interface Snapshot {
  pages: string[];      // paths from their sitemap (or homepage links when there is no sitemap)
  headline: string;     // homepage <h1>
  title: string;
  description: string;  // homepage meta description
  prices: string[];     // price-looking strings on the homepage and pricing page
  pricingUrl?: string;  // where the prices were read
  socials?: Socials;    // their LinkedIn / X pages, from links on the homepage
}

export interface Socials {
  linkedin?: string;
  x?: string;
}

export interface Change {
  kind: 'new-pages' | 'removed-pages' | 'headline' | 'description' | 'prices' | 'unreachable' | 'linkedin' | 'x' | 'news';
  text: string;
  items?: string[];
  /** Where to check it: their homepage, pricing page, the article or the post. */
  url?: string;
}

export type ScanOutcome = 'baseline' | 'changed' | 'unchanged' | 'failed';

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

/** Their company LinkedIn page and X account, from links on their homepage. Personal profiles and share links don't count. */
export function findSocials(links: string[]): Socials {
  const out: Socials = {};
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if (!out.linkedin && host.endsWith('linkedin.com') && (parts[0] === 'company' || parts[0] === 'showcase') && parts[1])
      out.linkedin = `https://www.linkedin.com/${parts[0]}/${parts[1]}`;
    if (!out.x && (host === 'x.com' || host === 'twitter.com') && parts.length === 1 && /^\w{1,15}$/.test(parts[0]) && !['share', 'intent', 'home', 'search'].includes(parts[0].toLowerCase()))
      out.x = `https://x.com/${parts[0]}`;
  }
  return out;
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
  let pricingUrl: string | undefined;
  if (pricing) {
    const r = await fetchPage(`${origin}${pricing}`, { fetchFn, browserFn: opts.browserFn });
    if (r.ok) {
      priceText += ' ' + cheerio.load(r.html)('body').text();
      pricingUrl = `${origin}${pricing}`;
    }
  }
  const absolute = links.map((l) => {
    try {
      return new URL(l, origin).href;
    } catch {
      return '';
    }
  });
  return {
    pages: pages.slice(0, 2000),
    headline: $('h1').first().text().replace(/\s+/g, ' ').trim(),
    title: $('title').first().text().trim(),
    description: $('meta[name="description"]').attr('content')?.trim() ?? '',
    prices: findPrices(priceText),
    pricingUrl,
    socials: findSocials(absolute),
  };
}

const list = (xs: string[], max = 8) => (xs.length > max ? [...xs.slice(0, max), `…and ${xs.length - max} more`] : xs);

/** Plain-English differences between two snapshots. Small sitemaps churn, so a single page added counts; removal needs two. */
export function compare(before: Snapshot, after: Snapshot, origin = ''): Change[] {
  const out: Change[] = [];
  const home = origin ? `${origin}/` : undefined;
  const was = new Set(before.pages);
  const now = new Set(after.pages);
  const added = after.pages.filter((p) => !was.has(p));
  const removed = before.pages.filter((p) => !now.has(p));
  // A sitemap that vanished entirely is a fetch hiccup, not a site that deleted everything.
  const sitemapLost = before.pages.length > 5 && after.pages.length === 0;
  if (added.length) out.push({ kind: 'new-pages', text: `added ${added.length} page${added.length > 1 ? 's' : ''}`, items: list(added), url: origin && added.length === 1 ? `${origin}${added[0]}` : home });
  if (removed.length >= 2 && !sitemapLost) out.push({ kind: 'removed-pages', text: `removed ${removed.length} pages`, items: list(removed), url: home });
  if (before.headline && after.headline && before.headline !== after.headline)
    out.push({ kind: 'headline', text: `changed their homepage headline from "${before.headline}" to "${after.headline}"`, url: home });
  if (before.description && after.description && before.description !== after.description)
    out.push({ kind: 'description', text: `rewrote their Google description: "${after.description}"`, url: home });
  const pricesGone = before.prices.filter((p) => !after.prices.includes(p));
  const pricesNew = after.prices.filter((p) => !before.prices.includes(p));
  if (before.prices.length && (pricesGone.length || pricesNew.length))
    out.push({ kind: 'prices', text: `changed prices${pricesGone.length ? `: ${pricesGone.join(', ')} gone` : ''}${pricesNew.length ? `${pricesGone.length ? ';' : ':'} now ${pricesNew.join(', ')}` : ''}`, url: after.pricingUrl ?? home });
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
    const changes: Change[] = [{ kind: 'unreachable', text: `couldn't be checked: ${err.message}`, url: `${c.url}/` }];
    recordScan(c.id, at, 'site', 'failed', changes);
    // Only worth telling the user when it was readable before.
    if (before) getDb().prepare('INSERT INTO competitor_changes (competitor_id, at, changes) VALUES (?, ?, ?)').run(c.id, at, JSON.stringify(changes));
    return changes;
  }
  if (after.socials && (after.socials.linkedin || after.socials.x)) saveSocials(c.id, after.socials);
  getDb().prepare('INSERT INTO competitor_snapshots (competitor_id, at, data) VALUES (?, ?, ?)').run(c.id, at, JSON.stringify(after));
  // Keep the last 10 snapshots per competitor.
  getDb()
    .prepare('DELETE FROM competitor_snapshots WHERE competitor_id = ? AND at NOT IN (SELECT at FROM competitor_snapshots WHERE competitor_id = ? ORDER BY at DESC LIMIT 10)')
    .run(c.id, c.id);
  if (!before) {
    recordScan(c.id, at, 'site', 'baseline', []);
    return []; // first look: nothing to compare yet
  }
  const changes = compare(before, after, c.url);
  recordScan(c.id, at, 'site', changes.length ? 'changed' : 'unchanged', changes);
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

// ---------------------------------------------------------------- scan history

export interface Scan {
  id: number;
  competitorId: number;
  at: string;
  scope: 'site' | 'news-social';
  outcome: ScanOutcome;
  findings: Change[];
}

function recordScan(competitorId: number, at: string, scope: Scan['scope'], outcome: ScanOutcome, findings: Change[]): void {
  getDb().prepare('INSERT INTO competitor_scans (competitor_id, at, scope, outcome, findings) VALUES (?, ?, ?, ?, ?)').run(competitorId, at, scope, outcome, JSON.stringify(findings));
  // Keep the last 20 scans per competitor.
  getDb()
    .prepare('DELETE FROM competitor_scans WHERE competitor_id = ? AND id NOT IN (SELECT id FROM competitor_scans WHERE competitor_id = ? ORDER BY id DESC LIMIT 20)')
    .run(competitorId, competitorId);
}

export function listScans(competitorId: number, limit = 10): Scan[] {
  return (getDb().prepare('SELECT * FROM competitor_scans WHERE competitor_id = ? ORDER BY id DESC LIMIT ?').all(competitorId, limit) as any[]).map((r) => ({
    id: r.id,
    competitorId: r.competitor_id,
    at: r.at,
    scope: r.scope,
    outcome: r.outcome,
    findings: JSON.parse(r.findings),
  }));
}

export function socialsOf(competitorId: number): Socials {
  const r = getDb().prepare('SELECT socials FROM competitors WHERE id = ?').get(competitorId) as { socials: string } | undefined;
  return r ? JSON.parse(r.socials || '{}') : {};
}

function saveSocials(competitorId: number, found: Socials): void {
  getDb().prepare('UPDATE competitors SET socials = ? WHERE id = ?').run(JSON.stringify({ ...socialsOf(competitorId), ...found }), competitorId);
}

// ---------------------------------------------------------------- news and social (AI + web search)

const NEWS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'other_competitors'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'url'],
        properties: {
          kind: { type: 'string', enum: ['linkedin', 'x', 'news'] },
          text: { type: 'string', description: 'One plain sentence: what they posted or what the article says, and the date if known.' },
          url: { type: 'string', description: 'The exact post or article you read. Required.' },
        },
      },
    },
    other_competitors: {
      type: 'array',
      description: 'Businesses you came across that compete in the same space and are NOT in the known list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'website', 'reason', 'source_url'],
        properties: {
          name: { type: 'string' },
          website: { type: 'string', description: 'Their main site, or empty string if unknown.' },
          reason: { type: 'string', description: 'One sentence: why they compete.' },
          source_url: { type: 'string', description: 'The page where you saw them.' },
        },
      },
    },
  },
};

type NewsAnswer = { findings: { kind: 'linkedin' | 'x' | 'news'; text: string; url: string }[]; other_competitors: { name: string; website: string; reason: string; source_url: string }[] };
export type AskNews = (prompt: string) => Promise<NewsAnswer & { _sources?: string[] }>;

const defaultAsk: AskNews = (prompt) =>
  askJson<NewsAnswer>({
    purpose: 'watch:news-social',
    model: MODELS.score,
    effort: 'low',
    maxTokens: 4000,
    webSearches: 5,
    system: 'You research a company for a competitor report. Report only what you actually found and read, each with its exact link. Never guess or invent posts, articles or links.',
    schema: NEWS_SCHEMA,
    prompt,
  });

const isLink = (u: string) => /^https?:\/\/[^\s]+\.[^\s]+/i.test(u);
const sameLink = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/[/#?]+$/, '').toLowerCase();

/** Every link reported in earlier news-social scans: a finding is only new once. */
function seenLinks(competitorId: number): Set<string> {
  const rows = getDb().prepare(`SELECT findings FROM competitor_scans WHERE competitor_id = ? AND scope = 'news-social'`).all(competitorId) as { findings: string }[];
  return new Set(rows.flatMap((r) => (JSON.parse(r.findings) as Change[]).map((f) => sameLink(f.url ?? ''))));
}

/** Search for recent LinkedIn and X posts and news about one competitor. Costs AI money. */
export async function scanNewsSocial(c: Competitor, opts: { ask?: AskNews; now?: Date } = {}): Promise<{ outcome: ScanOutcome; findings: Change[]; suggested: number }> {
  const at = (opts.now ?? new Date()).toISOString();
  const last = (getDb().prepare(`SELECT MAX(at) at FROM competitor_scans WHERE competitor_id = ? AND scope = 'news-social' AND outcome != 'failed'`).get(c.id) as { at: string | null }).at;
  const socials = socialsOf(c.id);
  const known = listCompetitors().map((x) => `${x.name}${x.url ? ` (${x.url})` : ''}`);
  const prompt = [
    `Competitor: ${c.name}${c.url ? `, website ${c.url}` : ''}.`,
    c.notes ? `What we know: ${c.notes}` : '',
    socials.linkedin ? `Their LinkedIn page: ${socials.linkedin}` : 'Their LinkedIn page is not known; only report LinkedIn posts if you find their company page.',
    socials.x ? `Their X account: ${socials.x}` : 'Their X account is not known; only report X posts if you find their account.',
    `Find, ${last ? `since ${last.slice(0, 10)}` : 'from the last 30 days'}:`,
    '- recent posts on their company LinkedIn page;',
    '- recent posts from their X account;',
    '- news articles or press mentions about them.',
    'Up to 8 findings, most important first. Skip anything you could not open and read.',
    `Known competitors (do not suggest these): ${known.join('; ') || 'none'}.`,
  ]
    .filter(Boolean)
    .join('\n');
  let answer: NewsAnswer;
  try {
    answer = await (opts.ask ?? defaultAsk)(prompt);
  } catch (err: any) {
    const findings: Change[] = [{ kind: 'unreachable', text: `news and social search failed: ${err.message}` }];
    recordScan(c.id, at, 'news-social', 'failed', findings);
    throw err;
  }
  const seen = seenLinks(c.id);
  const findings: Change[] = [];
  for (const f of answer.findings ?? []) {
    if (!isLink(f.url) || seen.has(sameLink(f.url)) || !['linkedin', 'x', 'news'].includes(f.kind)) continue;
    seen.add(sameLink(f.url));
    findings.push({ kind: f.kind, text: f.text.trim(), url: f.url.trim() });
  }
  const outcome: ScanOutcome = !last ? 'baseline' : findings.length ? 'changed' : 'unchanged';
  recordScan(c.id, at, 'news-social', outcome, findings);
  // Unlike site changes, news found on the first scan is still news: show it.
  if (findings.length) getDb().prepare('INSERT INTO competitor_changes (competitor_id, at, changes) VALUES (?, ?, ?)').run(c.id, at, JSON.stringify(findings));
  let suggested = 0;
  for (const s of answer.other_competitors ?? []) if (suggestCompetitor({ name: s.name, url: s.website, reason: s.reason, sourceUrl: s.source_url, at })) suggested++;
  return { outcome, findings, suggested };
}

/** The weekly paid task: news and social for every watched competitor. */
export async function scanWatchedNews(opts: { ask?: AskNews } = {}): Promise<{ scanned: number; withNews: number; suggested: number; failed: string[] }> {
  const watched = listCompetitors().filter((c) => c.watch);
  let withNews = 0;
  let suggested = 0;
  const failed: string[] = [];
  for (const c of watched) {
    try {
      const r = await scanNewsSocial(c, opts);
      if (r.findings.length) withNews++;
      suggested += r.suggested;
    } catch (err: any) {
      if (err instanceof BudgetExceeded) throw err;
      failed.push(c.name);
    }
  }
  return { scanned: watched.length, withNews, suggested, failed };
}

// ---------------------------------------------------------------- suggested competitors

export interface Suggestion {
  id: number;
  name: string;
  url: string | null;
  reason: string;
  sourceUrl: string | null;
  at: string;
}

const hostOf = (u: string | null) => (u ? new URL(u).hostname.replace(/^www\./, '') : null);

/** Remember a competitor the scan noticed. Skips ones already listed, or already suggested (even if dismissed). */
export function suggestCompetitor(s: { name: string; url?: string; reason: string; sourceUrl?: string; at?: string }): boolean {
  const name = s.name.trim();
  if (!name) return false;
  let url: string | null = null;
  try {
    url = siteOrigin(s.url);
  } catch {
    url = null;
  }
  const same = (n: string, u: string | null) => (url && u && hostOf(u) === hostOf(url)) || n.toLowerCase() === name.toLowerCase();
  if (listCompetitors().some((c) => same(c.name, c.url))) return false;
  const before = getDb().prepare('SELECT name, url FROM competitor_suggestions').all() as { name: string; url: string | null }[];
  if (before.some((x) => same(x.name, x.url))) return false;
  getDb()
    .prepare('INSERT INTO competitor_suggestions (name, url, reason, source_url, at) VALUES (?, ?, ?, ?, ?)')
    .run(name, url, s.reason.trim(), s.sourceUrl && isLink(s.sourceUrl) ? s.sourceUrl : null, s.at ?? new Date().toISOString());
  return true;
}

export function openSuggestions(): Suggestion[] {
  return (getDb().prepare(`SELECT * FROM competitor_suggestions WHERE status = 'open' ORDER BY id DESC`).all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    reason: r.reason,
    sourceUrl: r.source_url,
    at: r.at,
  }));
}

export function getSuggestion(id: number): Suggestion | undefined {
  return openSuggestions().find((s) => s.id === id);
}

export function settleSuggestion(id: number, status: 'added' | 'dismissed'): void {
  getDb().prepare('UPDATE competitor_suggestions SET status = ? WHERE id = ?').run(status, id);
}
