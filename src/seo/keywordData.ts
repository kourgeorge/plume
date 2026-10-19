import type Database from 'better-sqlite3';
import { getDb } from '../db';
import { listCompetitors } from '../context/extra';
import { siteUrl } from '../sites';
import { log } from '../log';
import { dfsPost, keywordLanguage, serpCreds, serpLocation } from './serp';

/**
 * Search numbers from DataForSEO, on the same login as "who outranks you":
 * - how many people search a term each month (Google's own figures) and how hard it is to reach page one
 *   (DataForSEO's 0–100 estimate, based on how strong the pages already there are);
 * - the searches each competitor ranks for, so the SEO agent can go after the ones we have no page for.
 * Costs about $0.012 per request plus $0.00012 per keyword returned. Everything is saved and reused for a
 * month, because these numbers barely move week to week.
 */

const TABLES = `
CREATE TABLE IF NOT EXISTS keyword_metrics (
  keyword TEXT NOT NULL,
  location TEXT NOT NULL,
  volume INTEGER,                  -- monthly searches; null = DataForSEO has no figure for it
  difficulty INTEGER,              -- 0-100
  intent TEXT,                     -- informational | navigational | commercial | transactional
  cpc REAL,                        -- what advertisers pay per click, USD
  at TEXT NOT NULL,
  PRIMARY KEY (keyword, location)
);
CREATE TABLE IF NOT EXISTS competitor_keywords (
  competitor_id INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  position INTEGER NOT NULL,
  url TEXT,
  volume INTEGER,
  difficulty INTEGER,
  at TEXT NOT NULL,
  PRIMARY KEY (competitor_id, keyword)
);
`;
const ready = new WeakSet<Database.Database>();
function db(): Database.Database {
  const d = getDb();
  if (!ready.has(d)) {
    d.exec(TABLES);
    ready.add(d);
  }
  return d;
}

export const FRESH_DAYS = 30;
/** Above this, a small site rarely reaches page one. */
export const MAX_DIFFICULTY = 50;
/** DataForSEO's limit per request. */
const BATCH = 700;

export interface KeywordMetrics {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  cpc: number | null;
}

const num = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Read a DataForSEO task, failing with its own message when the task itself went wrong. */
function taskOf(data: any): any {
  const task = data?.tasks?.[0];
  if (!task) throw new Error(data?.status_message ?? 'DataForSEO returned no result');
  if (task.status_code !== 20000) throw new Error(`DataForSEO: ${task.status_message ?? `error ${task.status_code}`}`);
  return task;
}

/** Keyword overview response → one row per keyword DataForSEO knows. */
export function parseOverview(data: any): { items: KeywordMetrics[]; cost: number } {
  const task = taskOf(data);
  const items = (task.result?.[0]?.items ?? []).map((i: any) => ({
    keyword: String(i.keyword ?? '').toLowerCase(),
    volume: num(i.keyword_info?.search_volume),
    difficulty: num(i.keyword_properties?.keyword_difficulty),
    intent: i.search_intent_info?.main_intent ?? null,
    cpc: num(i.keyword_info?.cpc),
  }));
  return { items: items.filter((i: KeywordMetrics) => i.keyword), cost: Number(task.cost ?? data.cost ?? 0) };
}

/** What is saved for these searches, fresh or not. Missing = never looked up. */
export function savedMetrics(keywords: string[], location = serpLocation()): Map<string, KeywordMetrics & { at: string }> {
  const out = new Map<string, KeywordMetrics & { at: string }>();
  const get = db().prepare('SELECT * FROM keyword_metrics WHERE keyword = ? AND location = ?');
  for (const k of new Set(keywords.map((x) => x.toLowerCase().trim()))) {
    const r = get.get(k, location) as any;
    if (r) out.set(k, { keyword: k, volume: r.volume, difficulty: r.difficulty, intent: r.intent, cpc: r.cpc, at: r.at });
  }
  return out;
}

/**
 * Search numbers for these searches, looking up only the ones not checked in the last month.
 * A search DataForSEO has no figure for is saved too (as empty), so it isn't paid for again next run.
 */
export async function keywordMetrics(keywords: string[], fetchFn: typeof fetch = fetch): Promise<{ metrics: Map<string, KeywordMetrics>; cost: number }> {
  const location = serpLocation();
  const all = [...new Set(keywords.map((k) => k.toLowerCase().trim()).filter((k) => k && k.length <= 80 && k.split(/\s+/).length <= 10))];
  const saved = savedMetrics(all, location);
  const cutoff = new Date(Date.now() - FRESH_DAYS * 86400e3).toISOString();
  const stale = all.filter((k) => !saved.has(k) || saved.get(k)!.at < cutoff);
  let cost = 0;
  if (stale.length && serpCreds()) {
    // One request per language: a Hebrew search has to be asked in Hebrew.
    const byLang = new Map<string, string[]>();
    for (const k of stale) byLang.set(keywordLanguage(k), [...(byLang.get(keywordLanguage(k)) ?? []), k]);
    const put = db().prepare('INSERT OR REPLACE INTO keyword_metrics (keyword, location, volume, difficulty, intent, cpc, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [lang, list] of byLang) {
      for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH);
        const r = parseOverview(await dfsPost('/v3/dataforseo_labs/google/keyword_overview/live', { keywords: chunk, location_name: location, language_code: lang }, fetchFn));
        cost += r.cost;
        const found = new Map(r.items.map((m) => [m.keyword, m]));
        const at = new Date().toISOString();
        db().transaction(() => {
          for (const k of chunk) {
            const m = found.get(k);
            put.run(k, location, m?.volume ?? null, m?.difficulty ?? null, m?.intent ?? null, m?.cpc ?? null, at);
            saved.set(k, { keyword: k, volume: m?.volume ?? null, difficulty: m?.difficulty ?? null, intent: m?.intent ?? null, cpc: m?.cpc ?? null, at });
          }
        })();
      }
    }
  }
  return { metrics: new Map([...saved].map(([k, v]) => [k, { keyword: v.keyword, volume: v.volume, difficulty: v.difficulty, intent: v.intent, cpc: v.cpc }])), cost };
}

/**
 * Worth writing for? Unknown numbers pass (DataForSEO doesn't know every small search). Known numbers fail
 * when nobody searches for it, or when page one is out of reach for a small site.
 */
export function winnable(m: KeywordMetrics | undefined, maxDifficulty = MAX_DIFFICULTY): boolean {
  if (!m) return true;
  if (m.volume === 0) return false;
  return m.difficulty === null || m.difficulty <= maxDifficulty;
}

/** "about 1,300 searches a month, difficulty 22 of 100" — for reasons shown to the owner. */
export function describeMetrics(m: KeywordMetrics | undefined): string {
  if (!m || (m.volume === null && m.difficulty === null)) return '';
  const parts: string[] = [];
  if (m.volume !== null) parts.push(`about ${m.volume.toLocaleString('en-US')} searches a month`);
  if (m.difficulty !== null) parts.push(`difficulty ${m.difficulty} of 100`);
  return parts.join(', ');
}

// ---------------------------------------------------------------- competitor keywords

export interface RankedKeyword {
  keyword: string;
  position: number;
  url: string | null;
  volume: number | null;
  difficulty: number | null;
}

/** Ranked keywords response → the searches a site ranks for. */
export function parseRanked(data: any): { items: RankedKeyword[]; cost: number } {
  const task = taskOf(data);
  const items = (task.result?.[0]?.items ?? [])
    .map((i: any) => ({
      keyword: String(i.keyword_data?.keyword ?? '').toLowerCase(),
      position: Number(i.ranked_serp_element?.serp_item?.rank_group),
      url: i.ranked_serp_element?.serp_item?.url ?? null,
      volume: num(i.keyword_data?.keyword_info?.search_volume),
      difficulty: num(i.keyword_data?.keyword_properties?.keyword_difficulty),
    }))
    .filter((i: RankedKeyword) => i.keyword && Number.isFinite(i.position));
  return { items, cost: Number(task.cost ?? data.cost ?? 0) };
}

const bareHost = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, '');

/** The searches one site is on page one for, most searched first. */
export async function rankedKeywords(site: string, limit = 100, fetchFn: typeof fetch = fetch): Promise<{ items: RankedKeyword[]; cost: number }> {
  const data = await dfsPost(
    '/v3/dataforseo_labs/google/ranked_keywords/live',
    {
      target: bareHost(site),
      location_name: serpLocation(),
      language_code: keywordLanguage(''),
      limit,
      item_types: ['organic'],
      order_by: ['keyword_data.keyword_info.search_volume,desc'],
      filters: [['ranked_serp_element.serp_item.rank_group', '<=', 10], 'and', ['keyword_data.keyword_info.search_volume', '>', 0]],
    },
    fetchFn,
  );
  return parseRanked(data);
}

/**
 * The monthly task: what each listed competitor with a website ranks for. Saves the numbers too, so the
 * gaps can be ranked without another lookup. Stops at the first account-level error.
 */
export async function refreshCompetitorKeywords(fetchFn: typeof fetch = fetch): Promise<{ checked: number; keywords: number; cost: number; failed: string | null }> {
  if (!serpCreds()) return { checked: 0, keywords: 0, cost: 0, failed: null };
  const location = serpLocation();
  let checked = 0;
  let keywords = 0;
  let cost = 0;
  for (const c of listCompetitors().filter((x) => x.url)) {
    try {
      const r = await rankedKeywords(c.url!, 100, fetchFn);
      cost += r.cost;
      const at = new Date().toISOString();
      const d = db();
      d.transaction(() => {
        d.prepare('DELETE FROM competitor_keywords WHERE competitor_id = ?').run(c.id);
        const ins = d.prepare('INSERT OR REPLACE INTO competitor_keywords (competitor_id, keyword, position, url, volume, difficulty, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
        const met = d.prepare('INSERT OR REPLACE INTO keyword_metrics (keyword, location, volume, difficulty, intent, cpc, at) VALUES (?, ?, ?, ?, NULL, NULL, ?)');
        for (const k of r.items) {
          ins.run(c.id, k.keyword, k.position, k.url, k.volume, k.difficulty, at);
          met.run(k.keyword, location, k.volume, k.difficulty, at);
        }
      })();
      checked++;
      keywords += r.items.length;
    } catch (err: any) {
      log('warn', 'seo', `competitor keywords for ${c.name} failed: ${err?.message ?? err}`);
      return { checked, keywords, cost, failed: `${c.name}: ${err?.message ?? err}` };
    }
  }
  return { checked, keywords, cost, failed: null };
}

export interface KeywordGap {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  /** Competitors on page one for it, best position first. */
  competitors: { name: string; position: number; url: string | null }[];
}

/** Searches we already get shown for (any position up to page 3), from Search Console. */
function oursAlready(): Set<string> {
  const rows = getDb().prepare('SELECT DISTINCT lower(query) q FROM gsc_daily WHERE position <= 30').all() as { q: string }[];
  return new Set(rows.map((r) => r.q));
}

/**
 * Searches competitors are on page one for and we don't show up for at all — the content gap.
 * Hard ones are dropped; the rest go most searched (and easiest) first.
 */
export function keywordGaps(limit = 20, skip: Iterable<string> = []): KeywordGap[] {
  const names = new Map(listCompetitors().map((c) => [c.id, c.name]));
  const rows = db().prepare('SELECT * FROM competitor_keywords ORDER BY position').all() as any[];
  const ours = oursAlready();
  const site = siteUrl();
  const mine = site ? bareHost(site) : null;
  const skipped = new Set([...skip].map((k) => k.toLowerCase()));
  const gaps = new Map<string, KeywordGap>();
  for (const r of rows) {
    if (!names.has(r.competitor_id) || ours.has(r.keyword) || skipped.has(r.keyword)) continue;
    // A search with our own name in it is ours already, whatever Search Console says.
    if (mine && r.keyword.includes(mine.split('.')[0])) continue;
    const g: KeywordGap = gaps.get(r.keyword) ?? { keyword: r.keyword, volume: r.volume, difficulty: r.difficulty, competitors: [] };
    g.competitors.push({ name: names.get(r.competitor_id)!, position: r.position, url: r.url });
    gaps.set(r.keyword, g);
  }
  // Volume divided by how hard it is; several competitors ranking for it is a sign buyers want it.
  const score = (g: KeywordGap) => ((g.volume ?? 10) * (1 + 0.5 * (g.competitors.length - 1))) / ((g.difficulty ?? 30) + 10);
  return [...gaps.values()]
    .filter((g) => winnable({ ...g, intent: null, cpc: null }))
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit);
}

export function competitorKeywordsCheckedAt(): string | null {
  return (db().prepare('SELECT MAX(at) at FROM competitor_keywords').get() as { at: string | null }).at;
}
