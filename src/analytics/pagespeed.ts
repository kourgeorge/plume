import { getSetting, setSetting } from '../db';

/** Google's PageSpeed Insights (runs Lighthouse for us). Works without a key; PAGESPEED_API_KEY raises the rate limit. */
export const PSI_URL = { base: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' };

export type Strategy = 'mobile' | 'desktop';
export type Rating = 'good' | 'needs-work' | 'poor';

export interface Vital {
  id: 'lcp' | 'fcp' | 'tbt' | 'cls';
  label: string;
  value: number;      // ms, or unitless for CLS
  display: string;    // "19.8s", "499ms", "0.051"
  target: string;     // "aim under 2.5s"
  rating: Rating;
}

export interface Opportunity {
  id: string;
  title: string;
  savingsMs: number;
  description: string;
}

export interface SpeedReport {
  url: string;
  strategy: Strategy;
  at: string;
  scores: { performance: number; accessibility: number; bestPractices: number; seo: number };
  vitals: Vital[];
  opportunities: Opportunity[];
  /** One sentence on the worst problem, or null if everything passes. */
  headline: string | null;
}

// Google's published Core Web Vitals thresholds: [good up to, poor above].
const LIMITS: Record<Vital['id'], { label: string; good: number; poor: number; unit: 'ms' | '' }> = {
  lcp: { label: 'Main content loads (LCP)', good: 2500, poor: 4000, unit: 'ms' },
  fcp: { label: 'First paint (FCP)', good: 1800, poor: 3000, unit: 'ms' },
  tbt: { label: 'Page blocked (TBT)', good: 200, poor: 600, unit: 'ms' },
  cls: { label: 'Layout shift (CLS)', good: 0.1, poor: 0.25, unit: '' },
};
const AUDIT_IDS: Record<Vital['id'], string> = {
  lcp: 'largest-contentful-paint',
  fcp: 'first-contentful-paint',
  tbt: 'total-blocking-time',
  cls: 'cumulative-layout-shift',
};

export function formatValue(id: Vital['id'], v: number): string {
  if (id === 'cls') return v.toFixed(3);
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

export function rate(id: Vital['id'], v: number): Rating {
  const l = LIMITS[id];
  return v <= l.good ? 'good' : v > l.poor ? 'poor' : 'needs-work';
}

/** Turn the raw PageSpeed response into what the panel and the SEO agent need. */
export function parseReport(raw: any, strategy: Strategy, at = new Date()): SpeedReport {
  const lh = raw?.lighthouseResult;
  if (!lh) throw new Error(raw?.error?.message ?? 'PageSpeed returned no Lighthouse result');
  const score = (k: string) => Math.round((lh.categories?.[k]?.score ?? 0) * 100);
  const vitals: Vital[] = (Object.keys(LIMITS) as Vital['id'][]).map((id) => {
    const v = Number(lh.audits?.[AUDIT_IDS[id]]?.numericValue ?? 0);
    const l = LIMITS[id];
    return {
      id,
      label: l.label,
      value: v,
      display: formatValue(id, v),
      target: rate(id, v) === 'good' ? 'passing' : `aim under ${formatValue(id, l.good)}`,
      rating: rate(id, v),
    };
  });
  const opportunities: Opportunity[] = Object.entries<any>(lh.audits ?? {})
    .filter(([, a]) => a?.details?.type === 'opportunity' && (a.details.overallSavingsMs ?? 0) > 100 && (a.score ?? 1) < 0.9)
    .map(([id, a]) => ({ id, title: a.title, savingsMs: Math.round(a.details.overallSavingsMs), description: stripLinks(a.description ?? '') }))
    .sort((a, b) => b.savingsMs - a.savingsMs)
    .slice(0, 6);
  return {
    url: lh.finalDisplayedUrl ?? lh.finalUrl ?? raw.id,
    strategy,
    at: at.toISOString(),
    scores: { performance: score('performance'), accessibility: score('accessibility'), bestPractices: score('best-practices'), seo: score('seo') },
    vitals,
    opportunities,
    headline: headline(vitals, strategy),
  };
}

function stripLinks(md: string): string {
  return md.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/** Plain English about the worst measurement, ranked by how far past Google's "poor" line it is. */
export function headline(vitals: Vital[], strategy: Strategy): string | null {
  const bad = vitals.filter((v) => v.rating !== 'good').sort((a, b) => b.value / LIMITS[b.id].poor - a.value / LIMITS[a.id].poor)[0];
  if (!bad) return null;
  const where = strategy === 'mobile' ? 'On phones, your' : 'On computers, your';
  const poorLine = formatValue(bad.id, LIMITS[bad.id].poor);
  const verdict = bad.rating === 'poor' ? `Google counts anything over ${poorLine} as poor.` : `Google wants it under ${formatValue(bad.id, LIMITS[bad.id].good)}.`;
  switch (bad.id) {
    case 'lcp': return `${where} pages take ${bad.display} to show their main content. ${verdict}`;
    case 'fcp': return `${where} pages stay blank for ${bad.display} before anything appears. ${verdict}`;
    case 'tbt': return `${where} pages freeze for ${bad.display} while scripts run, so taps and clicks lag. ${verdict}`;
    case 'cls': return `${where} pages jump around while loading (layout shift ${bad.display}). ${verdict}`;
  }
}

export async function runPageSpeed(url: string, strategy: Strategy, env = process.env): Promise<SpeedReport> {
  const q = new URLSearchParams({ url, strategy });
  for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) q.append('category', c);
  if (env.PAGESPEED_API_KEY) q.set('key', env.PAGESPEED_API_KEY);
  const res = await fetch(`${PSI_URL.base}?${q}`, { signal: AbortSignal.timeout(120_000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PageSpeed ${res.status}: ${data.error?.message ?? res.statusText}`);
  return parseReport(data, strategy);
}

export interface SpeedState { mobile: SpeedReport | null; desktop: SpeedReport | null }

export async function checkSpeed(url: string): Promise<SpeedState> {
  const [mobile, desktop] = await Promise.all([runPageSpeed(url, 'mobile'), runPageSpeed(url, 'desktop')]);
  const state = { mobile, desktop };
  setSetting('pagespeed', state);
  return state;
}

export function lastSpeed(): SpeedState {
  return getSetting<SpeedState>('pagespeed', { mobile: null, desktop: null });
}

/** The worst speed problem as a site-check fix, with Google's top suggestions as the steps. */
export function speedIssue(r: SpeedReport): import('../agents/seoAudit').Issue | null {
  const bad = r.vitals.filter((v) => v.rating !== 'good').sort((a, b) => b.value / LIMITS[b.id].poor - a.value / LIMITS[a.id].poor)[0];
  if (!bad || !r.headline) return null;
  const steps = r.opportunities.length
    ? r.opportunities.slice(0, 4).map((o) => `${o.title} (could save about ${formatValue('lcp', o.savingsMs)}): ${o.description}`)
    : ['Run the page through PageSpeed Insights and work through the "Opportunities" list from the top.'];
  steps.push('After changing the site, click "Check speed" again to confirm the improvement.');
  return {
    id: `speed:${r.strategy}:${bad.id}`,
    check: 'page-speed',
    severity: bad.rating === 'poor' ? 'critical' : 'medium',
    area: 'performance',
    url: r.url,
    title: `${bad.label}: ${bad.display} on ${r.strategy} (${bad.target})`,
    why: `${r.headline} Slow pages rank lower and lose visitors before they see anything.`,
    steps,
  };
}
