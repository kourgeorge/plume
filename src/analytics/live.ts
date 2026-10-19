import { getSetting } from '../db';
import { currentSite } from '../site';
import { GOOGLE, googleApi, googleConnected } from './google';

/**
 * Who is on the site in the last hour, from GA4's realtime report. Standard properties only keep
 * 30 minutes (GA4 360 keeps 60), so when
 * Google refuses the hour, everything falls back to 30.
 */
const LIVE_FALLBACK_MINUTES = 30;
export const LIVE_MINUTES = 60;
export const LIVE_BREAKDOWNS = { page: 'unifiedScreenName', country: 'country', device: 'deviceCategory' } as const;
export type LiveBreakdown = keyof typeof LIVE_BREAKDOWNS;

export interface LiveNow {
  /** Why there are no numbers: not connected, no property picked, or Google refused. */
  missing?: 'google' | 'property' | 'error';
  error?: string;
  /** Active users over `minutes`, matching the chart and table. */
  now: number;
  /** Active users over `minutes` (an hour, or 30 minutes when the property only keeps that). */
  total: number;
  /** How far back `total`, `perMinute` and `rows` go. */
  minutes: number;
  /** Active users per minute, oldest first (index 0 = `minutes - 1` minutes ago). */
  perMinute: number[];
  rows: { label: string; users: number }[];
  at: string;
}

type Row = { dimensionValues?: { value: string }[]; metricValues: { value: string }[] };
const realtime = (property: string, body: object) =>
  googleApi<{ rows?: Row[] }>(`${GOOGLE.gaData}/properties/${property}:runRealtimeReport`, { metrics: [{ name: 'activeUsers' }], ...body });
const count = (r: { rows?: Row[] }) => Number(r.rows?.[0]?.metricValues[0].value ?? 0);

// Realtime calls have their own Google quota; the top bar asks every minute, so answers are reused briefly.
const cache = new Map<string, { at: number; value: LiveNow }>();
const CACHE_MS = 45_000;

export async function liveNow(by: LiveBreakdown = 'page'): Promise<LiveNow> {
  const empty = (missing: LiveNow['missing'], error?: string): LiveNow => ({ missing, error, now: 0, total: 0, minutes: LIVE_MINUTES, perMinute: [], rows: [], at: new Date().toISOString() });
  if (!googleConnected()) return empty('google');
  const property = getSetting<string | null>('ga4Property', null);
  if (!property) return empty('property');
  const key = `${currentSite()}|${property}|${by}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const last = (start: number) => ({ minuteRanges: [{ startMinutesAgo: start, endMinutesAgo: 0 }] });
  const fetchWindow = (span: number) =>
    Promise.all([
      realtime(property, last(span - 1)),
      realtime(property, { ...last(span - 1), dimensions: [{ name: 'minutesAgo' }], limit: 100 }),
      realtime(property, { ...last(span - 1), dimensions: [{ name: LIVE_BREAKDOWNS[by] }], limit: 8 }),
    ]);
  try {
    let span = LIVE_MINUTES;
    let answers;
    try {
      answers = await fetchWindow(span);
    } catch {
      // Not a GA4 360 property: Google only keeps the last 30 minutes.
      span = LIVE_FALLBACK_MINUTES;
      answers = await fetchWindow(span);
    }
    const [whole, minutes, split] = answers;
    const perMinute = new Array(span).fill(0);
    for (const r of minutes.rows ?? []) {
      const ago = Number(r.dimensionValues?.[0].value);
      if (ago >= 0 && ago < span) perMinute[span - 1 - ago] = Number(r.metricValues[0].value);
    }
    const rows = (split.rows ?? [])
      .map((r) => ({ label: r.dimensionValues?.[0].value || '(not set)', users: Number(r.metricValues[0].value) }))
      .sort((a, b) => b.users - a.users);
    const total = count(whole);
    const value: LiveNow = { now: total, total, minutes: span, perMinute, rows, at: new Date().toISOString() };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e: any) {
    return empty('error', e.message);
  }
}
