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

/** Days kept per pull. Search Console data lags ~2 days, so its window ends 2 days ago. */
export const PULL_DAYS = 30;

/** Last 30 days of date × query × page rows. Re-pulling replaces those days (late data fills in). */
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
  return rows.length;
}

/** GA4 dates come as YYYYMMDD. */
export function gaDate(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;
}

export async function pullAnalytics(property: string, today = new Date()): Promise<number> {
  type Row = { dimensionValues: { value: string }[]; metricValues: { value: string }[] };
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 10000) {
    const r = await googleApi<{ rows?: Row[] }>(`${GOOGLE.gaData}/properties/${property}:runReport`, {
      dateRanges: [{ startDate: `${PULL_DAYS}daysAgo`, endDate: 'yesterday' }],
      dimensions: [{ name: 'date' }, { name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'engagementRate' }, { name: 'averageSessionDuration' }],
      limit: 10000,
      offset,
    });
    rows.push(...(r.rows ?? []));
    if ((r.rows ?? []).length < 10000) break;
  }
  const db = getDb();
  const ins = db.prepare('INSERT OR REPLACE INTO ga_daily VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM ga_daily WHERE date BETWEEN ? AND ?').run(daysAgo(PULL_DAYS, today), daysAgo(1, today));
    for (const row of rows) {
      const [views, sessions, eng, secs] = row.metricValues.map((m) => Number(m.value));
      ins.run(gaDate(row.dimensionValues[0].value), row.dimensionValues[1].value, views, sessions, eng, secs);
    }
  })();
  return rows.length;
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
