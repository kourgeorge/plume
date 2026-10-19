import { getDb } from '../db';
import { listDrafts } from '../queue';
import { countryCode } from './countries';

export interface QueryRow { query: string; clicks: number; impressions: number; ctr: number; position: number }
export interface PageRow { page: string; clicks: number; impressions: number; position: number; views: number | null; engagement: number | null }
export interface PublishedResult { id: number; title: string; agent: string; url: string; publishedDaysAgo: number; clicks: number; impressions: number; position: number | null; views: number | null; topQuery: string | null }

/**
 * The window to sum: the last `days` days that have data. Each source ends on its own latest day
 * (Search Console lags Analytics by a day or two), so both windows are the same length.
 */
function since(table: 'gsc_daily' | 'ga_daily', days: number): string | null {
  const last = (getDb().prepare(`SELECT MAX(date) d FROM ${table}`).get() as { d: string | null }).d;
  if (!last) return null;
  return new Date(new Date(`${last}T00:00:00Z`).getTime() - (days - 1) * 86400e3).toISOString().slice(0, 10);
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

/** The newest day each source has data for (Search Console runs a day or two behind Analytics). */
export function lastDataDay(table: 'gsc_daily' | 'ga_daily'): string | null {
  return (getDb().prepare(`SELECT MAX(date) d FROM ${table}`).get() as { d: string | null }).d;
}

export interface PageTotals { clicks: number; impressions: number; position: number | null; views: number | null }

/**
 * Search and visit totals for one page (matched by path, like everywhere else) or, with path null,
 * the whole site, between two dates inclusive.
 */
export function pageTotals(path: string | null, from: string, to: string): PageTotals {
  const db = getDb();
  const gsc = db.prepare('SELECT page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) pw FROM gsc_daily WHERE date BETWEEN ? AND ? GROUP BY page').all(from, to) as { page: string; clicks: number; impressions: number; pw: number }[];
  const ga = db.prepare('SELECT path, SUM(views) views FROM ga_daily WHERE date BETWEEN ? AND ? GROUP BY path').all(from, to) as { path: string; views: number }[];
  const hasGa = (db.prepare('SELECT 1 FROM ga_daily WHERE date BETWEEN ? AND ? LIMIT 1').get(from, to) as unknown) != null;
  const s = gsc.filter((r) => path === null || pathOf(r.page) === path);
  const a = ga.filter((r) => path === null || pathOf(r.path) === path);
  const impressions = s.reduce((n, r) => n + r.impressions, 0);
  return {
    clicks: s.reduce((n, r) => n + r.clicks, 0),
    impressions,
    position: impressions ? s.reduce((n, r) => n + r.pw, 0) / impressions : null,
    views: hasGa ? a.reduce((n, r) => n + r.views, 0) : null,
  };
}

export function topQueries(limit = 50, days = 28): QueryRow[] {
  const from = since('gsc_daily', days);
  if (!from) return [];
  return getDb()
    .prepare(
      `SELECT query, SUM(clicks) clicks, SUM(impressions) impressions,
              CAST(SUM(clicks) AS REAL) / MAX(SUM(impressions), 1) ctr,
              SUM(position * impressions) / MAX(SUM(impressions), 1) position
       FROM gsc_daily WHERE date >= ? GROUP BY query ORDER BY impressions DESC LIMIT ?`,
    )
    .all(from, limit) as QueryRow[];
}

export function topPages(limit = 50, days = 28): PageRow[] {
  const gscFrom = since('gsc_daily', days);
  const gaFrom = since('ga_daily', days);
  const search = gscFrom
    ? (getDb()
        .prepare(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) / MAX(SUM(impressions), 1) position FROM gsc_daily WHERE date >= ? GROUP BY page`)
        .all(gscFrom) as { page: string; clicks: number; impressions: number; position: number }[])
    : [];
  // Engagement is a rate, so it's averaged by sessions rather than added up.
  const ga = gaFrom
    ? (getDb()
        .prepare('SELECT path, SUM(views) views, SUM(sessions) sessions, SUM(engagement_rate * sessions) / MAX(SUM(sessions), 1) engagement_rate FROM ga_daily WHERE date >= ? GROUP BY path')
        .all(gaFrom) as { path: string; views: number; sessions: number; engagement_rate: number }[])
    : [];
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
  const sessionsByPath = new Map<string, number>();
  for (const g of ga) {
    const p = pathOf(g.path);
    const row = byPath.get(p) ?? { page: p, clicks: 0, impressions: 0, position: 0, views: null, engagement: null };
    const before = sessionsByPath.get(p) ?? 0;
    const total = before + g.sessions;
    row.engagement = total ? ((row.engagement ?? 0) * before + g.engagement_rate * g.sessions) / total : g.engagement_rate;
    sessionsByPath.set(p, total);
    row.views = (row.views ?? 0) + g.views;
    byPath.set(p, row);
  }
  return [...byPath.values()].sort((a, b) => (b.views ?? 0) - (a.views ?? 0) || b.clicks - a.clicks).slice(0, limit);
}

/** How each published item is doing. Dry runs and file exports have no live page, so they're skipped. */
export function publishedResults(now = new Date(), days = 28): PublishedResult[] {
  const pages = new Map(topPages(10000, days).map((p) => [p.page, p]));
  const from = since('gsc_daily', days);
  const q = from
    ? (getDb().prepare('SELECT query, page, SUM(impressions) impressions FROM gsc_daily WHERE date >= ? GROUP BY query, page ORDER BY impressions DESC').all(from) as { query: string; page: string; impressions: number }[])
    : [];
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

export interface Totals {
  clicks: number; impressions: number; position: number | null; views: number | null; sessions: number | null; users: number | null; revenue: number | null;
  /** Visitors who had been before (all visitors minus first-time ones). */
  returning: number | null;
  keyEvents: number | null;
  /** Share of sessions that were engaged (0–1); the bounce rate is the rest. */
  engagement: number | null;
  /** Average session length in seconds. */
  avgSeconds: number | null;
  /** Visitors who arrived from a search engine. */
  searchUsers: number | null;
}
export interface DayPoint { date: string; clicks: number; impressions: number; views: number | null }
export interface VisitDay { date: string; users: number | null; views: number | null }
export interface SourceRow { channel: string; users: number; sessions: number; before: number }
export interface NamedCount { label: string; users: number }
export interface CountryRow { country: string; code: string | null; clicks: number }
export interface Summary {
  days: number; from: string | null; to: string | null; now: Totals; before: Totals; daily: DayPoint[];
  /** Analytics per day, on Analytics' own dates (Search Console runs a day or two behind). */
  visits: VisitDay[];
  previousDaily: DayPoint[];
  previousVisits: VisitDay[];
  sources: SourceRow[]; pages: { page: string; views: number; sessions: number }[];
  /** Plain-word channels (Search, Direct, Social, AI Assistant, ...) by visitors. */
  channels: NamedCount[];
  /** The sites that sent visitors (google, chatgpt.com, ...). */
  topSources: NamedCount[];
  /**
   * Whether the period before has a full set of days to compare with. Plume only starts collecting
   * when Google is connected, so early on the previous period is partly empty and changes would mislead.
   */
  compare: { search: boolean; visits: boolean };
  /** First page of each visit, by visitors. */
  landing: NamedCount[];
  /** Search clicks by the searcher's country. */
  countries: CountryRow[];
}

// AI chat sites, so they show as their own channel even where GA4 files them under Referral.
const AI_SOURCE = /chatgpt|openai|perplexity|gemini\.google|bard\.google|claude\.ai|copilot|deepseek|grok|you\.com|phind|meta\.ai|mistral/i;

/** GA4's channel groups, folded into fewer, plainer names. */
export function channelName(channel: string, source: string): string {
  if (AI_SOURCE.test(source) || /ai assistant/i.test(channel)) return 'AI Assistant';
  if (/search|shopping/i.test(channel)) return 'Search';
  if (/social/i.test(channel)) return 'Social';
  if (/video/i.test(channel)) return 'Video';
  if (/direct/i.test(channel)) return 'Direct';
  if (/referral/i.test(channel)) return 'Other sites';
  if (/email/i.test(channel)) return 'Email';
  if (/display|paid other|cross-network|affiliate/i.test(channel)) return 'Ads';
  return 'Other';
}

const shift = (date: string, days: number) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400e3).toISOString().slice(0, 10);

function totals(gscFrom: string | null, gscTo: string | null, gaFrom: string | null, gaTo: string | null): Totals {
  const db = getDb();
  // The whole-site table counts searches Google leaves out of the by-search one; older pulls only have the latter.
  const gscSql = (table: string) => `SELECT SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) / NULLIF(SUM(impressions), 0) position, COUNT(*) n FROM ${table} WHERE date BETWEEN ? AND ?`;
  type G = { clicks: number | null; impressions: number | null; position: number | null; n: number };
  const whole = gscFrom && gscTo ? (db.prepare(gscSql('gsc_site_daily')).get(gscFrom, gscTo) as G) : null;
  const s = gscFrom && gscTo
    ? whole?.n ? whole : (db.prepare(gscSql('gsc_daily')).get(gscFrom, gscTo) as G)
    : { clicks: 0, impressions: 0, position: null };
  const a = gaFrom && gaTo
    ? (db.prepare(`SELECT SUM(views) views, SUM(sessions) sessions FROM ga_daily WHERE date BETWEEN ? AND ?`).get(gaFrom, gaTo) as { views: number | null; sessions: number | null })
    : { views: null, sessions: null };
  // Whole-site table: only filled by pulls made since it was added, so fall back to page sessions until then.
  const w = gaFrom && gaTo
    ? (db.prepare(`SELECT SUM(users) users, SUM(sessions) sessions, SUM(revenue) revenue, COUNT(*) n,
          SUM(key_events) key_events, SUM(engaged_sessions) engaged, SUM(avg_seconds * sessions) / NULLIF(SUM(CASE WHEN avg_seconds IS NULL THEN 0 ELSE sessions END), 0) avg_seconds,
          SUM(new_users) new_users, COUNT(key_events) has_new
        FROM ga_site_daily WHERE date BETWEEN ? AND ?`).get(gaFrom, gaTo) as { users: number | null; sessions: number | null; revenue: number | null; n: number; key_events: number | null; engaged: number | null; avg_seconds: number | null; new_users: number | null; has_new: number })
    : { users: null, sessions: null, revenue: null, n: 0, key_events: null, engaged: null, avg_seconds: null, new_users: null, has_new: 0 };
  // Search visitors: only the "Organic/Paid Search" channels.
  const sv = gaFrom && gaTo
    ? (db.prepare(`SELECT SUM(users) users, COUNT(*) n FROM ga_sources WHERE date BETWEEN ? AND ? AND (channel LIKE '%Search%' OR channel LIKE '%Shopping%')`).get(gaFrom, gaTo) as { users: number | null; n: number })
    : { users: null, n: 0 };
  const anySources = gaFrom && gaTo ? (db.prepare('SELECT 1 FROM ga_sources WHERE date BETWEEN ? AND ? LIMIT 1').get(gaFrom, gaTo) as unknown) != null : false;
  // The newer columns stay empty on days pulled before they were added.
  const fresh = w.has_new > 0;
  return {
    clicks: s.clicks ?? 0, impressions: s.impressions ?? 0, position: s.position, views: a.views,
    sessions: w.n ? w.sessions : a.sessions, users: w.n ? w.users : null, revenue: w.n ? w.revenue ?? 0 : null,
    returning: fresh && w.users != null && w.new_users != null ? Math.max(0, w.users - w.new_users) : null,
    keyEvents: fresh ? w.key_events ?? 0 : null,
    engagement: fresh && w.sessions ? (w.engaged ?? 0) / w.sessions : null,
    avgSeconds: fresh ? w.avg_seconds : null,
    searchUsers: anySources ? sv.users ?? 0 : null,
  };
}

/** Headline numbers for the last `days` days with data, the same-length period before it, and a per-day line. */
export function resultsSummary(days = 7): Summary {
  const db = getDb();
  const gscFrom = since('gsc_daily', days);
  const gaFrom = since('ga_daily', days);
  const gscTo = gscFrom ? shift(gscFrom, days - 1) : null;
  const gaTo = gaFrom ? shift(gaFrom, days - 1) : null;
  const now = totals(gscFrom, gscTo, gaFrom, gaTo);
  const before = totals(gscFrom && shift(gscFrom, -days), gscFrom && shift(gscFrom, -1), gaFrom && shift(gaFrom, -days), gaFrom && shift(gaFrom, -1));
  const from = gscFrom ?? gaFrom;
  const daily: DayPoint[] = [];
  if (from) {
    const hasWhole = (db.prepare('SELECT 1 FROM gsc_site_daily WHERE date >= ? LIMIT 1').get(from) as unknown) != null;
    const gsc = new Map((db.prepare(hasWhole ? 'SELECT date, clicks, impressions FROM gsc_site_daily WHERE date >= ?' : 'SELECT date, SUM(clicks) clicks, SUM(impressions) impressions FROM gsc_daily WHERE date >= ? GROUP BY date').all(from) as { date: string; clicks: number; impressions: number }[]).map((r) => [r.date, r]));
    const ga = new Map((db.prepare(`SELECT date, SUM(views) views FROM ga_daily WHERE date >= ? GROUP BY date`).all(from) as { date: string; views: number }[]).map((r) => [r.date, r.views]));
    for (let i = 0; i < days; i++) {
      const d = shift(from, i);
      daily.push({ date: d, clicks: gsc.get(d)?.clicks ?? 0, impressions: gsc.get(d)?.impressions ?? 0, views: ga.has(d) ? ga.get(d)! : null });
    }
  }
  let sources: SourceRow[] = [];
  let pages: Summary['pages'] = [];
  let channels: NamedCount[] = [];
  let topSources: NamedCount[] = [];
  let landing: NamedCount[] = [];
  let countries: CountryRow[] = [];
  const visits: VisitDay[] = [];
  if (gscFrom && gscTo) {
    countries = (db.prepare(`SELECT country, SUM(clicks) clicks FROM gsc_country WHERE date BETWEEN ? AND ? GROUP BY country HAVING SUM(clicks) > 0 ORDER BY clicks DESC LIMIT 8`).all(gscFrom, gscTo) as { country: string; clicks: number }[])
      .map((r) => ({ ...r, code: countryCode(r.country) }));
  }
  if (gaFrom && gaTo) {
    const users = new Map((db.prepare(`SELECT date, users FROM ga_site_daily WHERE date >= ?`).all(gaFrom) as { date: string; users: number }[]).map((r) => [r.date, r.users]));
    const views = new Map((db.prepare(`SELECT date, SUM(views) views FROM ga_daily WHERE date >= ? GROUP BY date`).all(gaFrom) as { date: string; views: number }[]).map((r) => [r.date, r.views]));
    for (let i = 0; i < days; i++) {
      const d = shift(gaFrom, i);
      visits.push({ date: d, users: users.get(d) ?? (users.size ? 0 : null), views: views.get(d) ?? 0 });
    }
    const was = new Map((db.prepare(`SELECT channel, SUM(users) users FROM ga_sources WHERE date BETWEEN ? AND ? GROUP BY channel`).all(shift(gaFrom, -days), shift(gaFrom, -1)) as { channel: string; users: number }[]).map((r) => [r.channel, r.users]));
    sources = (db.prepare(`SELECT channel, SUM(users) users, SUM(sessions) sessions FROM ga_sources WHERE date BETWEEN ? AND ? GROUP BY channel ORDER BY users DESC`).all(gaFrom, gaTo) as { channel: string; users: number; sessions: number }[])
      .map((r) => ({ ...r, before: was.get(r.channel) ?? 0 }));
    pages = db.prepare(`SELECT path page, SUM(views) views, SUM(sessions) sessions FROM ga_daily WHERE date BETWEEN ? AND ? GROUP BY path ORDER BY views DESC LIMIT 10`).all(gaFrom, gaTo) as Summary['pages'];
    const detail = db.prepare(`SELECT channel, source, SUM(users) users FROM ga_source_detail WHERE date BETWEEN ? AND ? GROUP BY channel, source`).all(gaFrom, gaTo) as { channel: string; source: string; users: number }[];
    const grouped = new Map<string, number>();
    // Older pulls have no per-site detail yet: fall back to the channel groups alone.
    for (const r of detail.length ? detail : sources.map((x) => ({ channel: x.channel, source: '', users: x.users }))) {
      const name = channelName(r.channel, r.source);
      grouped.set(name, (grouped.get(name) ?? 0) + r.users);
    }
    channels = [...grouped].map(([label, users]) => ({ label, users })).filter((r) => r.users > 0).sort((a, b) => b.users - a.users);
    topSources = (db.prepare(`SELECT source label, SUM(users) users FROM ga_source_detail WHERE date BETWEEN ? AND ? GROUP BY source ORDER BY users DESC LIMIT 8`).all(gaFrom, gaTo) as NamedCount[]);
    landing = (db.prepare(`SELECT page label, SUM(users) users FROM ga_landing WHERE date BETWEEN ? AND ? GROUP BY page ORDER BY users DESC LIMIT 8`).all(gaFrom, gaTo) as NamedCount[]);
  }
  const covered = (table: string, start: string | null) =>
    start != null && (db.prepare(`SELECT COUNT(DISTINCT date) n FROM ${table} WHERE date BETWEEN ? AND ?`).get(shift(start, -days), shift(start, -1)) as { n: number }).n >= days;
  const compare = { search: covered('gsc_daily', gscFrom), visits: covered('ga_daily', gaFrom) };
  const previousDaily: DayPoint[] = [];
  const previousVisits: VisitDay[] = [];
  if (from) {
    const start = shift(from, -days), end = shift(from, -1);
    const hasWhole = db.prepare('SELECT 1 FROM gsc_site_daily WHERE date BETWEEN ? AND ? LIMIT 1').get(start, end) != null;
    const search = new Map((db.prepare(hasWhole
      ? 'SELECT date, clicks, impressions FROM gsc_site_daily WHERE date BETWEEN ? AND ?'
      : 'SELECT date, SUM(clicks) clicks, SUM(impressions) impressions FROM gsc_daily WHERE date BETWEEN ? AND ? GROUP BY date')
      .all(start, end) as { date: string; clicks: number; impressions: number }[]).map((r) => [r.date, r]));
    for (let i = 0; i < days; i++) {
      const date = shift(start, i);
      previousDaily.push({ date, clicks: search.get(date)?.clicks ?? 0, impressions: search.get(date)?.impressions ?? 0, views: null });
    }
  }
  if (gaFrom) {
    const start = shift(gaFrom, -days), end = shift(gaFrom, -1);
    const users = new Map((db.prepare('SELECT date, users FROM ga_site_daily WHERE date BETWEEN ? AND ?').all(start, end) as { date: string; users: number }[]).map((r) => [r.date, r.users]));
    const views = new Map((db.prepare('SELECT date, SUM(views) views FROM ga_daily WHERE date BETWEEN ? AND ? GROUP BY date').all(start, end) as { date: string; views: number }[]).map((r) => [r.date, r.views]));
    for (let i = 0; i < days; i++) {
      const date = shift(start, i);
      previousVisits.push({ date, users: users.get(date) ?? null, views: views.get(date) ?? null });
    }
  }
  return { days, from, to: from ? shift(from, days - 1) : null, now, before, daily, visits, previousDaily, previousVisits, sources, pages, compare, channels, topSources, landing, countries };
}

export interface DeviceSplit {
  /** Search clicks by device (Search Console: mobile, desktop, tablet). Empty when not pulled yet. */
  search: { device: string; clicks: number; impressions: number; position: number | null }[];
  /** Visitors by device and system (Analytics: mobile + Android, desktop + Windows, ...). */
  visits: { device: string; os: string; users: number; sessions: number }[];
}

/** Where clicks and visits come from by device, over the last `days` days each source has. */
export function deviceSplit(days = 30): DeviceSplit {
  const db = getDb();
  const latest = (table: string) => (db.prepare(`SELECT MAX(date) d FROM ${table}`).get() as { d: string | null }).d;
  const start = (table: string) => {
    const last = latest(table);
    return last ? shift(last, -(days - 1)) : null;
  };
  const gscFrom = start('gsc_device');
  const gaFrom = start('ga_device');
  return {
    search: gscFrom
      ? (db.prepare(`SELECT LOWER(device) device, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) / NULLIF(SUM(impressions), 0) position
          FROM gsc_device WHERE date >= ? GROUP BY device ORDER BY clicks DESC`).all(gscFrom) as DeviceSplit['search'])
      : [],
    visits: gaFrom
      ? (db.prepare(`SELECT device, os, SUM(users) users, SUM(sessions) sessions FROM ga_device WHERE date >= ? GROUP BY device, os ORDER BY users DESC LIMIT 15`).all(gaFrom) as DeviceSplit['visits'])
      : [],
  };
}
