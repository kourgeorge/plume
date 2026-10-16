import { getSetting, setSetting } from './db';
import { listDrafts, getDraft, moveDraft, Draft } from './queue';
import { AuditResult, Issue, dailyFixes, markFixDone, pinIssue } from './agents/seoAudit';
import { lastSpeed, speedIssue, Strategy } from './analytics/pagespeed';
import { recordFeedback } from './feedback';

/** One card in the Today feed. `key` is stable so skips survive a refresh. */
export type TodayItem =
  | { key: string; kind: 'draft'; score: number; draft: Omit<Draft, 'body' | 'originalBody'> & { preview: string; words: number } }
  | { key: string; kind: 'fix'; score: number; fix: Issue }
  | { key: string; kind: 'speed'; score: number; strategy: Strategy; headline: string; performance: number };

const SEVERITY_SCORE = { critical: 100, high: 70, medium: 40, low: 20 } as const;

function todayStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Keys skipped today. A new day starts with a clean slate. */
function skipped(now: Date): Set<string> {
  const s = getSetting<{ day: string; keys: string[] }>('todaySkips', { day: '', keys: [] });
  return new Set(s.day === todayStr(now) ? s.keys : []);
}

export function skipItem(key: string, now = new Date()): void {
  const keys = [...skipped(now), key];
  setSetting('todaySkips', { day: todayStr(now), keys });
}

/** First words of a draft for the card, without Markdown symbols. */
export function preview(markdown: string, words = 45): string {
  const text = markdown
    .replace(/^#.*$/m, '')
    .replace(/[#*_>`\[\]]|\(https?:[^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = text.split(' ');
  return parts.length > words ? `${parts.slice(0, words).join(' ')}…` : text;
}

/**
 * Everything waiting for the user today, best first:
 * critical fixes and serious speed problems, then drafts (those built on real search data first), then smaller fixes.
 */
export function todayFeed(now = new Date()): TodayItem[] {
  const skip = skipped(now);
  const items: TodayItem[] = [];

  const audit = getSetting<AuditResult | null>('lastAudit', null);
  const fixes = audit ? dailyFixes(audit, 2, todayStr(now)) : [];
  for (const f of fixes) items.push({ key: `fix:${f.id}`, kind: 'fix', score: SEVERITY_SCORE[f.severity], fix: f });

  const speed = lastSpeed();
  const handled = getSetting<Record<string, string>>('speedHandled', {});
  for (const strategy of ['mobile', 'desktop'] as const) {
    const r = speed[strategy];
    const issue = r && speedIssue(r);
    // One card per speed report: once sent to the SEO agent (it becomes a fix) it doesn't come back.
    // A later report that is still slow does.
    if (r?.headline && issue && issue.severity === 'critical' && handled[strategy] !== r.at)
      items.push({ key: `speed:${strategy}`, kind: 'speed', score: strategy === 'mobile' ? 90 : 85, strategy, headline: r.headline, performance: r.scores.performance });
  }

  for (const d of listDrafts({ status: 'draft' })) {
    const { body, originalBody, ...rest } = d;
    const fromData = d.meta.source === 'search-console';
    items.push({ key: `draft:${d.id}`, kind: 'draft', score: fromData ? 80 : 60, draft: { ...rest, preview: preview(body), words: body.split(/\s+/).length } });
  }

  return items.filter((i) => !skip.has(i.key)).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** Count of what's left, for the header ("3 of 7 done today"). */
export function todayProgress(now = new Date()): { left: number; doneToday: number } {
  const done = getSetting<{ day: string; n: number }>('todayDone', { day: '', n: 0 });
  return { left: todayFeed(now).length, doneToday: done.day === todayStr(now) ? done.n : 0 };
}

export function countDone(now = new Date()): void {
  const done = getSetting<{ day: string; n: number }>('todayDone', { day: '', n: 0 });
  setSetting('todayDone', { day: todayStr(now), n: (done.day === todayStr(now) ? done.n : 0) + 1 });
}

/** "Not useful": reject the draft and remember why, so its agent learns. */
export function notUseful(draftId: number, reason: string | null): void {
  const d = getDraft(draftId);
  if (!d) throw new Error(`no draft ${draftId}`);
  moveDraft(draftId, 'rejected', { note: reason ? `not useful: ${reason}` : 'not useful' });
  recordFeedback(d.agent, d.title, reason);
  countDone();
}

export function fixDone(id: string): void {
  markFixDone(id);
  countDone();
}

/** Speed panel → today's fixes. Returns the fix, or null when that report has nothing to fix. */
export function sendSpeedToSeo(strategy: Strategy): Issue | null {
  const r = lastSpeed()[strategy];
  const issue = r && speedIssue(r);
  if (!issue) return null;
  pinIssue(issue);
  setSetting('speedHandled', { ...getSetting<Record<string, string>>('speedHandled', {}), [strategy]: r!.at });
  return issue;
}
