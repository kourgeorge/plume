import { getSetting } from '../db';
import { currentSite } from '../site';
import { GOOGLE, googleApi, googleConnected } from './google';

/**
 * Who is on the site right now, from GA4's realtime report. Standard properties only keep the last
 * 30 minutes, so that is the longest window shown.
 */
export const LIVE_MINUTES = 30;
export const LIVE_BREAKDOWNS = { page: 'unifiedScreenName', country: 'country', device: 'deviceCategory' } as const;
export type LiveBreakdown = keyof typeof LIVE_BREAKDOWNS;

export interface LiveNow {
  /** Why there are no numbers: not connected, no property picked, or Google refused. */
  missing?: 'google' | 'property' | 'error';
  error?: string;
  /** Active users in the last 5 minutes. */
  now: number;
  /** Active users in the last 30 minutes. */
  total: number;
  /** Active users per minute, oldest first (index 0 = 29 minutes ago). */
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
  const empty = (missing: LiveNow['missing'], error?: string): LiveNow => ({ missing, error, now: 0, total: 0, perMinute: [], rows: [], at: new Date().toISOString() });
  if (!googleConnected()) return empty('google');
  const property = getSetting<string | null>('ga4Property', null);
  if (!property) return empty('property');
  const key = `${currentSite()}|${property}|${by}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const last = (start: number) => ({ minuteRanges: [{ startMinutesAgo: start, endMinutesAgo: 0 }] });
    const [five, thirty, minutes, split] = await Promise.all([
      realtime(property, last(4)),
      realtime(property, last(LIVE_MINUTES - 1)),
      realtime(property, { ...last(LIVE_MINUTES - 1), dimensions: [{ name: 'minutesAgo' }], limit: 100 }),
      realtime(property, { ...last(LIVE_MINUTES - 1), dimensions: [{ name: LIVE_BREAKDOWNS[by] }], limit: 8 }),
    ]);
    const perMinute = new Array(LIVE_MINUTES).fill(0);
    for (const r of minutes.rows ?? []) {
      const ago = Number(r.dimensionValues?.[0].value);
      if (ago >= 0 && ago < LIVE_MINUTES) perMinute[LIVE_MINUTES - 1 - ago] = Number(r.metricValues[0].value);
    }
    const rows = (split.rows ?? [])
      .map((r) => ({ label: r.dimensionValues?.[0].value || '(not set)', users: Number(r.metricValues[0].value) }))
      .sort((a, b) => b.users - a.users);
    const value: LiveNow = { now: count(five), total: count(thirty), perMinute, rows, at: new Date().toISOString() };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (e: any) {
    return empty('error', e.message);
  }
}
