import { getDb } from '../db';
import { listDrafts } from '../queue';

export interface QueryRow { query: string; clicks: number; impressions: number; ctr: number; position: number }
export interface PageRow { page: string; clicks: number; impressions: number; position: number; views: number | null; engagement: number | null }
export interface PublishedResult { id: number; title: string; agent: string; url: string; publishedDaysAgo: number; clicks: number; impressions: number; position: number | null; views: number | null; topQuery: string | null }

function latest(table: 'gsc_rows' | 'ga_pages'): string | null {
  return (getDb().prepare(`SELECT MAX(pulled_on) d FROM ${table}`).get() as { d: string | null }).d;
}

/** Compare by path only: Search Console gives full URLs, Analytics gives paths, and www/trailing slashes vary. */
export function pathOf(url: string): string {
  try {
    const p = new URL(url, 'https://x').pathname;
    return p.length > 1 ? p.replace(/\/$/, '') : '/';
  } catch {
    return url;
  }
}

export function topQueries(limit = 50): QueryRow[] {
  const on = latest('gsc_rows');
  if (!on) return [];
  return getDb()
    .prepare(
      `SELECT query, SUM(clicks) clicks, SUM(impressions) impressions,
              CAST(SUM(clicks) AS REAL) / MAX(SUM(impressions), 1) ctr,
              SUM(position * impressions) / MAX(SUM(impressions), 1) position
       FROM gsc_rows WHERE pulled_on = ? GROUP BY query ORDER BY impressions DESC LIMIT ?`,
    )
    .all(on, limit) as QueryRow[];
}

export function topPages(limit = 50): PageRow[] {
  const gscOn = latest('gsc_rows');
  const gaOn = latest('ga_pages');
  const search = gscOn
    ? (getDb()
        .prepare(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) / MAX(SUM(impressions), 1) position FROM gsc_rows WHERE pulled_on = ? GROUP BY page`)
        .all(gscOn) as { page: string; clicks: number; impressions: number; position: number }[])
    : [];
  const ga = gaOn ? (getDb().prepare('SELECT path, views, engagement_rate FROM ga_pages WHERE pulled_on = ?').all(gaOn) as { path: string; views: number; engagement_rate: number }[]) : [];
  const byPath = new Map<string, PageRow>();
  for (const s of search) {
    const p = pathOf(s.page);
    const row = byPath.get(p) ?? { page: p, clicks: 0, impressions: 0, position: 0, views: null, engagement: null };
    // Same page under two addresses: add them up, position weighted by how often each was shown.
    const shown = row.impressions + s.impressions;
    row.position = shown ? (row.position * row.impressions + s.position * s.impressions) / shown : 0;
    row.clicks += s.clicks;
    row.impressions = shown;
    byPath.set(p, row);
  }
  for (const g of ga) {
    const p = pathOf(g.path);
    const row = byPath.get(p) ?? { page: p, clicks: 0, impressions: 0, position: 0, views: null, engagement: null };
    row.views = (row.views ?? 0) + g.views;
    row.engagement = g.engagement_rate;
    byPath.set(p, row);
  }
  return [...byPath.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0) || b.clicks - a.clicks).slice(0, limit);
}

/** How each published item is doing. Dry runs and file exports have no live page, so they're skipped. */
export function publishedResults(now = new Date()): PublishedResult[] {
  const pages = new Map(topPages(10000).map((p) => [p.page, p]));
  const on = latest('gsc_rows');
  const q = on ? getDb().prepare('SELECT query, page, impressions FROM gsc_rows WHERE pulled_on = ? ORDER BY impressions DESC').all(on) as { query: string; page: string; impressions: number }[] : [];
  return listDrafts({ status: 'published' })
    .filter((d) => !d.dryRun && d.publishedUrl?.startsWith('http'))
    .map((d) => {
      const path = pathOf(d.publishedUrl!);
      const p = pages.get(path);
      return {
        id: d.id,
        title: d.title,
        agent: d.agent,
        url: d.publishedUrl!,
        publishedDaysAgo: Math.floor((now.getTime() - new Date(d.updatedAt).getTime()) / 86400e3),
        clicks: p?.clicks ?? 0,
        impressions: p?.impressions ?? 0,
        position: p && p.impressions ? p.position : null,
        views: p?.views ?? null,
        topQuery: q.find((r) => pathOf(r.page) === path)?.query ?? null,
      };
    });
}

/**
 * Plain-English notes every agent reads: what's bringing people in, what's close to page one,
 * and how our own published work is doing. Numbers, not adjectives, so agents can't over-read them.
 */
export function performanceNotes(now = new Date()): string | null {
  const queries = topQueries(200);
  const pages = topPages(200);
  const mine = publishedResults(now);
  if (!queries.length && !pages.length) return null;
  const lines: string[] = ['Results from Google Search Console and Google Analytics, last 28 days.'];

  const winners = [...queries].sort((a, b) => b.clicks - a.clicks).filter((q) => q.clicks > 0).slice(0, 10);
  if (winners.length) lines.push('', 'Searches that bring the most visitors:', ...winners.map((q) => `- "${q.query}": ${q.clicks} clicks from ${q.impressions} impressions, average position ${q.position.toFixed(1)}`));

  const close = queries.filter((q) => q.impressions >= 50 && q.position >= 8 && q.position <= 30).slice(0, 10);
  if (close.length) lines.push('', 'Searches where we are on page 2–3 and a better page could reach page one:', ...close.map((q) => `- "${q.query}": ${q.impressions} impressions, position ${q.position.toFixed(1)}`));

  const lowCtr = queries.filter((q) => q.impressions >= 200 && q.position <= 10 && q.ctr < 0.02).slice(0, 5);
  if (lowCtr.length) lines.push('', 'Searches where we show on page one but few people click (title/description may need work):', ...lowCtr.map((q) => `- "${q.query}": position ${q.position.toFixed(1)}, ${(q.ctr * 100).toFixed(1)}% click rate`));

  const topViewed = pages.filter((p) => p.views).slice(0, 8);
  if (topViewed.length) lines.push('', 'Most visited pages:', ...topViewed.map((p) => `- ${p.page}: ${p.views} views${p.engagement != null ? `, ${(p.engagement * 100).toFixed(0)}% engaged` : ''}`));

  const settled = mine.filter((m) => m.publishedDaysAgo >= 14);
  if (settled.length) {
    lines.push('', 'Our published work (at least 2 weeks old):');
    for (const m of settled.sort((a, b) => b.clicks - a.clicks))
      lines.push(`- "${m.title}" (${m.agent}): ${m.clicks} clicks, ${m.impressions} impressions${m.position ? `, position ${m.position.toFixed(1)}` : ''}${m.views != null ? `, ${m.views} views` : ''}${m.topQuery ? `, best search "${m.topQuery}"` : ''}`);
    lines.push('Write more like what is working; don\'t repeat topics that got no impressions after 4 weeks.');
  }
  return lines.join('\n');
}
