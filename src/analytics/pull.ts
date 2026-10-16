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

/** Last 28 days of query × page rows. Search Console data lags ~2 days, so the window ends 2 days ago. */
export async function pullSearchConsole(site: string, today = new Date()): Promise<number> {
  const rows: { keys: [string, string]; clicks: number; impressions: number; ctr: number; position: number }[] = [];
  for (let start = 0; ; start += 25000) {
    const r = await googleApi<{ rows?: typeof rows }>(`${GOOGLE.gsc}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      startDate: daysAgo(30, today),
      endDate: daysAgo(2, today),
      dimensions: ['query', 'page'],
      rowLimit: 25000,
      startRow: start,
    });
    rows.push(...(r.rows ?? []));
    if ((r.rows ?? []).length < 25000) break;
  }
  const on = day(today);
  const db = getDb();
  const ins = db.prepare('INSERT OR REPLACE INTO gsc_rows VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM gsc_rows WHERE pulled_on = ?').run(on);
    for (const r of rows) ins.run(on, r.keys[0], r.keys[1], r.clicks, r.impressions, r.ctr, r.position);
  })();
  return rows.length;
}

export async function pullAnalytics(property: string, today = new Date()): Promise<number> {
  const r = await googleApi<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
    `${GOOGLE.gaData}/properties/${property}:runReport`,
    {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }, { name: 'engagementRate' }, { name: 'averageSessionDuration' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 1000,
    },
  );
  const on = day(today);
  const db = getDb();
  const ins = db.prepare('INSERT OR REPLACE INTO ga_pages VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM ga_pages WHERE pulled_on = ?').run(on);
    for (const row of r.rows ?? []) {
      const [views, sessions, eng, secs] = row.metricValues.map((m) => Number(m.value));
      ins.run(on, row.dimensionValues[0].value, views, sessions, eng, secs);
    }
  })();
  return (r.rows ?? []).length;
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
