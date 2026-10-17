import { getDb } from '../db';
import { topQueries } from '../analytics/results';
import { searchConsoleGaps } from '../agents/seo';

/**
 * Keyword tracking from the Search Console history Plume already keeps (one row per day per search
 * and page). No extra account needed; the history grows with every daily pull.
 */

export const MAX_TRACKED = 100;

export interface Tracked {
  keyword: string;
  source: 'user' | 'suggested';
  addedAt: string;
}

/** "  Best  Widgets " → "best widgets". Search Console reports searches in lowercase. */
export function normalizeKeyword(raw: string): string {
  const k = String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!k) throw new Error('type a search term');
  if (k.length > 120) throw new Error('that search term is too long (keep it under 120 characters)');
  return k;
}

export function listTracked(): Tracked[] {
  return (getDb().prepare('SELECT * FROM tracked_keywords ORDER BY rowid').all() as any[]).map((r) => ({ keyword: r.keyword, source: r.source, addedAt: r.added_at }));
}

/** Start tracking a search. Returns null if it is already tracked. */
export function trackKeyword(raw: string, source: Tracked['source'] = 'user'): Tracked | null {
  const keyword = normalizeKeyword(raw);
  if (getDb().prepare('SELECT 1 FROM tracked_keywords WHERE keyword = ?').get(keyword)) return null;
  const count = (getDb().prepare('SELECT COUNT(*) n FROM tracked_keywords').get() as { n: number }).n;
  if (count >= MAX_TRACKED) throw new Error(`you can track up to ${MAX_TRACKED} searches — remove one first`);
  const addedAt = new Date().toISOString();
  getDb().prepare('INSERT INTO tracked_keywords (keyword, source, added_at) VALUES (?, ?, ?)').run(keyword, source, addedAt);
  return { keyword, source, addedAt };
}

/** Stop tracking. Past lookups and alerts for it go too; the Search Console history stays. */
export function untrackKeyword(raw: string): void {
  const keyword = normalizeKeyword(raw);
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM tracked_keywords WHERE keyword = ?').run(keyword);
    db.prepare('DELETE FROM serp_snapshots WHERE keyword = ?').run(keyword);
    db.prepare('DELETE FROM rank_alerts WHERE keyword = ?').run(keyword);
  })();
}

/** Searches worth tracking: near page one first, then the ones that already bring clicks. */
export function suggestKeywords(limit = 10): { keyword: string; why: string }[] {
  const tracked = new Set(listTracked().map((t) => t.keyword));
  const out: { keyword: string; why: string }[] = [];
  const add = (keyword: string, why: string) => {
    if (out.length < limit && !tracked.has(keyword) && !out.some((o) => o.keyword === keyword)) out.push({ keyword, why });
  };
  const queries = topQueries(500, 30);
  for (const g of searchConsoleGaps(queries)) add(g.keyword!, `close to page one (position ${Number(g.position).toFixed(1)}, shown ${g.impressions} times)`);
  for (const q of [...queries].sort((a, b) => b.clicks - a.clicks)) if (q.clicks > 0) add(q.query, `brings visitors (${q.clicks} clicks in 30 days)`);
  return out;
}

// ---------------------------------------------------------------- weekly history

/** The Monday of the week a date falls in, as YYYY-MM-DD (UTC). */
export function weekOf(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - back * 86400e3).toISOString().slice(0, 10);
}

export interface WeekPoint {
  week: string;
  /** Average position that week, weighted by how often each day/page was shown. Null = not shown. */
  position: number | null;
  clicks: number;
  impressions: number;
  topPage: string | null;
}

function latestDate(): string | null {
  return (getDb().prepare('SELECT MAX(date) d FROM gsc_daily').get() as { d: string | null }).d;
}

/** Weeks whose last day (Sunday) has Search Console data — partial weeks would make positions jump. */
export function completeWeeks(count: number, last = latestDate()): string[] {
  if (!last) return [];
  let week = weekOf(last);
  const sunday = new Date(new Date(`${week}T00:00:00Z`).getTime() + 6 * 86400e3).toISOString().slice(0, 10);
  if (sunday > last) week = new Date(new Date(`${week}T00:00:00Z`).getTime() - 7 * 86400e3).toISOString().slice(0, 10);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(new Date(new Date(`${week}T00:00:00Z`).getTime() - i * 7 * 86400e3).toISOString().slice(0, 10));
  return out;
}

/** One search's position per complete week, oldest first. Weeks with no impressions have position null. */
export function keywordHistory(keyword: string, weeks = 12): WeekPoint[] {
  const ws = completeWeeks(weeks);
  if (!ws.length) return [];
  const end = new Date(new Date(`${ws[ws.length - 1]}T00:00:00Z`).getTime() + 6 * 86400e3).toISOString().slice(0, 10);
  const rows = getDb()
    .prepare('SELECT date, page, clicks, impressions, position FROM gsc_daily WHERE lower(query) = ? AND date >= ? AND date <= ?')
    .all(keyword, ws[0], end) as { date: string; page: string; clicks: number; impressions: number; position: number }[];
  return ws.map((week) => {
    const inWeek = rows.filter((r) => weekOf(r.date) === week);
    const impressions = inWeek.reduce((s, r) => s + r.impressions, 0);
    const clicks = inWeek.reduce((s, r) => s + r.clicks, 0);
    const byPage = new Map<string, number>();
    for (const r of inWeek) byPage.set(r.page, (byPage.get(r.page) ?? 0) + r.impressions);
    const topPage = [...byPage].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const position = impressions ? inWeek.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : null;
    return { week, position: position === null ? null : Math.round(position * 10) / 10, clicks, impressions, topPage };
  });
}

export interface RankRow {
  keyword: string;
  source: Tracked['source'];
  history: WeekPoint[];
  /** Latest week that had impressions. */
  current: WeekPoint | null;
  /** Positive = moved up (a smaller position number) since the week before that had data. */
  change: number | null;
  clicks: number;
  serp: { at: string; ourPosition: number | null; above: string[]; location: string } | null;
}

/** Everything the Rankings page shows, one row per tracked search. */
export function rankingsTable(weeks = 12): RankRow[] {
  return listTracked().map((t) => {
    const history = keywordHistory(t.keyword, weeks);
    const withData = history.filter((h) => h.position !== null);
    const current = withData[withData.length - 1] ?? null;
    const before = withData[withData.length - 2] ?? null;
    const change = current && before ? Math.round((before.position! - current.position!) * 10) / 10 : null;
    const snap = getDb().prepare('SELECT * FROM serp_snapshots WHERE keyword = ? ORDER BY at DESC LIMIT 1').get(t.keyword) as any;
    let serp: RankRow['serp'] = null;
    if (snap) {
      const results = JSON.parse(snap.results) as { position: number; domain: string }[];
      const above = results.filter((r) => snap.our_position === null || r.position < snap.our_position).map((r) => r.domain);
      serp = { at: snap.at, ourPosition: snap.our_position, above: [...new Set(above)].slice(0, 5), location: snap.location };
    }
    return { keyword: t.keyword, source: t.source, history, current, change, clicks: history.reduce((s, h) => s + h.clicks, 0), serp };
  });
}

// ---------------------------------------------------------------- big moves

export interface RankAlert {
  id: number;
  keyword: string;
  week: string;
  from: number;
  to: number;
}

/**
 * Compare the last two complete weeks for every tracked search. A move of `threshold` places or more,
 * with enough impressions both weeks to be real, becomes an alert (once per search per week).
 */
export function detectMoves(threshold = 3, minImpressions = 10): number {
  let added = 0;
  const ins = getDb().prepare('INSERT OR IGNORE INTO rank_alerts (keyword, week, from_position, to_position) VALUES (?, ?, ?, ?)');
  for (const t of listTracked()) {
    const [prev, last] = keywordHistory(t.keyword, 2);
    if (!prev || !last || prev.position === null || last.position === null) continue;
    if (prev.impressions < minImpressions || last.impressions < minImpressions) continue;
    if (Math.abs(prev.position - last.position) < threshold) continue;
    added += ins.run(t.keyword, last.week, prev.position, last.position).changes;
  }
  return added;
}

export function openAlerts(): RankAlert[] {
  return (getDb().prepare('SELECT * FROM rank_alerts WHERE dismissed = 0 ORDER BY week DESC, id').all() as any[]).map((r) => ({
    id: r.id,
    keyword: r.keyword,
    week: r.week,
    from: r.from_position,
    to: r.to_position,
  }));
}

export function dismissAlert(id: number): void {
  getDb().prepare('UPDATE rank_alerts SET dismissed = 1 WHERE id = ?').run(id);
}
