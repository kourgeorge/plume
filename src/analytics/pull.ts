import { getDb, getSetting, setSetting } from '../db';
import { GOOGLE, googleApi, googleConnected } from './google';

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number, from = new Date()) => day(new Date(from.getTime() - n * 86400e3));

// ---- discovery: which sites / properties this Google account can see ----

export async function listSearchConsoleSites(): Promise<string[]> {
  const r = await googleApi<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(`${GOOGLE.gsc}/sites`);
  return (r.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser').map((s) => s.siteUrl);
}

export async function listAnalyticsProperties(): Promise<{ id: string; name: string }[]> {
  const r = await googleApi<{ accountSummaries?: { propertySummaries?: { property: string; displayName: string }[] }[] }>(
    `${GOOGLE.gaAdmin}/accountSummaries?pageSize=200`,
  );
  return (r.accountSummaries ?? []).flatMap((a) => a.propertySummaries ?? []).map((p) => ({ id: p.property.replace('properties/', ''), name: p.displayName }));
}

/** Pick the Search Console entry that matches the researched site, preferring the whole-domain property. */
export function matchSite(sites: string[], origin: string): string | null {
  const host = new URL(origin).hostname.replace(/^www\./, '');
  return sites.find((s) => s === `sc-domain:${host}`) ?? sites.find((s) => s.startsWith('http') && new URL(s).hostname.replace(/^www\./, '') === host) ?? null;
}

// ---- pulls ----

/** Fetch two 30-day periods so comparisons work from the first refresh. Search Console lags ~2 days. */
export const PULL_DAYS = 60;

/** Last 60 days of date × query × page rows. Re-pulling replaces those days (late data fills in). */
export async function pullSearchConsole(site: string, today = new Date()): Promise<number> {
  type Row = { keys: [string, string, string]; clicks: number; impressions: number; position: number };
  const rows: Row[] = [];
  const startDate = daysAgo(PULL_DAYS + 1, today);
  const endDate = daysAgo(2, today);
  for (let start = 0; ; start += 25000) {
    const r = await googleApi<{ rows?: Row[] }>(`${GOOGLE.gsc}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      startDate,
      endDate,
      dimensions: ['date', 'query', 'page'],
      rowLimit: 25000,
      startRow: start,
    });
    rows.push(...(r.rows ?? []));
    if ((r.rows ?? []).length < 25000) break;
  }
  const db = getDb();
  const ins = db.prepare('INSERT OR REPLACE INTO gsc_daily VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM gsc_daily WHERE date BETWEEN ? AND ?').run(startDate, endDate);
    for (const r of rows) ins.run(r.keys[0], r.keys[1], r.keys[2], r.clicks, r.impressions, r.position);
  })();
  // Whole-site totals and countries come from their own reports: Google leaves rare searches out of the
  // by-search report above, so adding it up undercounts.
  type Small = { rows?: { keys: string[]; clicks: number; impressions: number; position: number }[] };
  const report = (dimensions: string[]) =>
    googleApi<Small>(`${GOOGLE.gsc}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { startDate, endDate, dimensions, rowLimit: 25000 });
  const [totals, countries] = [await report(['date']), await report(['date', 'country'])];
  const insTotal = db.prepare('INSERT OR REPLACE INTO gsc_site_daily VALUES (?, ?, ?, ?)');
  const insCountry = db.prepare('INSERT OR REPLACE INTO gsc_country VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (const t of ['gsc_site_daily', 'gsc_country']) db.prepare(`DELETE FROM ${t} WHERE date BETWEEN ? AND ?`).run(startDate, endDate);
    for (const r of totals.rows ?? []) insTotal.run(r.keys[0], r.clicks, r.impressions, r.position);
    for (const r of countries.rows ?? []) insCountry.run(r.keys[0], r.keys[1], r.clicks, r.impressions);
  })();
  return rows.length;
}

/** GA4 dates come as YYYYMMDD. */
export function gaDate(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;
}

type GaRow = { dimensionValues: { value: string }[]; metricValues: { value: string }[] };

async function gaReport(property: string, dimensions: string[], metrics: string[]): Promise<GaRow[]> {
  const rows: GaRow[] = [];
  for (let offset = 0; ; offset += 10000) {
    const r = await googleApi<{ rows?: GaRow[] }>(`${GOOGLE.gaData}/properties/${property}:runReport`, {
      dateRanges: [{ startDate: `${PULL_DAYS}daysAgo`, endDate: 'yesterday' }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit: 10000,
      offset,
    });
    rows.push(...(r.rows ?? []));
    if ((r.rows ?? []).length < 10000) break;
  }
  return rows;
}

export async function pullAnalytics(property: string, today = new Date()): Promise<number> {
  const pages = await gaReport(property, ['date', 'pagePath'], ['screenPageViews', 'sessions', 'engagementRate', 'averageSessionDuration']);
  const site = await gaReport(property, ['date'], ['totalUsers', 'sessions', 'totalRevenue', 'keyEvents', 'engagedSessions', 'averageSessionDuration', 'newUsers']);
  const sources = await gaReport(property, ['date', 'sessionDefaultChannelGroup'], ['totalUsers', 'sessions']);
  const detail = await gaReport(property, ['date', 'sessionDefaultChannelGroup', 'sessionSource'], ['totalUsers', 'sessions']);
  const landing = await gaReport(property, ['date', 'landingPage'], ['activeUsers', 'sessions']);
  const db = getDb();
  const from = daysAgo(PULL_DAYS, today), to = daysAgo(1, today);
  const nums = (row: GaRow) => row.metricValues.map((m) => Number(m.value));
  db.transaction(() => {
    for (const t of ['ga_daily', 'ga_site_daily', 'ga_sources', 'ga_source_detail', 'ga_landing']) db.prepare(`DELETE FROM ${t} WHERE date BETWEEN ? AND ?`).run(from, to);
    const insPage = db.prepare('INSERT OR REPLACE INTO ga_daily VALUES (?, ?, ?, ?, ?, ?)');
    for (const row of pages) insPage.run(gaDate(row.dimensionValues[0].value), row.dimensionValues[1].value, ...nums(row));
    const insSite = db.prepare('INSERT OR REPLACE INTO ga_site_daily (date, users, sessions, revenue, key_events, engaged_sessions, avg_seconds, new_users) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of site) insSite.run(gaDate(row.dimensionValues[0].value), ...nums(row));
    const insSource = db.prepare('INSERT OR REPLACE INTO ga_sources VALUES (?, ?, ?, ?)');
    for (const row of sources) insSource.run(gaDate(row.dimensionValues[0].value), row.dimensionValues[1].value || 'Unassigned', ...nums(row));
    const insDetail = db.prepare('INSERT OR REPLACE INTO ga_source_detail VALUES (?, ?, ?, ?, ?)');
    for (const row of detail) insDetail.run(gaDate(row.dimensionValues[0].value), row.dimensionValues[1].value || 'Unassigned', row.dimensionValues[2].value || '(not set)', ...nums(row));
    const insLanding = db.prepare('INSERT OR REPLACE INTO ga_landing VALUES (?, ?, ?, ?)');
    for (const row of landing) insLanding.run(gaDate(row.dimensionValues[0].value), row.dimensionValues[1].value || '(not set)', ...nums(row));
  })();
  return pages.length;
}

export interface PullStatus {
  at: string | null;
  searchConsole: { site: string | null; rows: number; error?: string };
  analytics: { property: string | null; rows: number; error?: string };
}

/** Pull both sources. One failing doesn't stop the other; each reports its own error. */
export async function pullAll(today = new Date()): Promise<PullStatus> {
  const site = getSetting<string | null>('gscSite', null);
  const property = getSetting<string | null>('ga4Property', null);
  const status: PullStatus = { at: new Date().toISOString(), searchConsole: { site, rows: 0 }, analytics: { property, rows: 0 } };
  if (site) {
    try {
      status.searchConsole.rows = await pullSearchConsole(site, today);
    } catch (e: any) {
      status.searchConsole.error = e.message;
    }
  }
  if (property) {
    try {
      status.analytics.rows = await pullAnalytics(property, today);
    } catch (e: any) {
      status.analytics.error = e.message;
    }
  }
  setSetting('lastPull', status);
  return status;
}

/** Called on a timer: pull once a day, only when connected and something is selected. */
export async function pullIfDue(): Promise<void> {
  if (!googleConnected()) return;
  const last = getSetting<PullStatus | null>('lastPull', null);
  if (last?.at && Date.now() - new Date(last.at).getTime() < 20 * 3600e3) return;
  if (!getSetting('gscSite', null) && !getSetting('ga4Property', null)) return;
  await pullAll();
}
