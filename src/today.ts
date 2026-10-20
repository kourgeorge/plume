import { getSetting, setSetting } from './db';
import { listDrafts, getDraft, moveDraft, Draft } from './queue';
import { AuditResult, Issue, markFixDone, openFixes, pinIssue, pinnedIssues } from './agents/seoAudit';
import { recordFixDone } from './actions';
import { lastSpeed, speedIssue, Strategy } from './analytics/pagespeed';
import { recordFeedback } from './feedback';
import { ChangeCard, dismissChange, openChanges } from './watch';
import { RankAlert, dismissAlert, openAlerts } from './seo/rankings';
import { targetsFor } from './publish';
import { Gap, gapDone, openGaps } from './geo/visibility';
import { PageChangeCard, dismissPageChange, openPageChanges } from './research/pageChanges';
import { GoogleUpdate, updatesNear } from './seo/googleUpdates';

/** One card on the Dashboard. `key` is stable so "Later" survives a refresh. */
export type TodayItem =
  | { key: string; kind: 'draft'; score: number; draft: Omit<Draft, 'body' | 'originalBody'> & { preview: string; words: number; targets: string[] } }
  | { key: string; kind: 'fix'; score: number; fix: Issue }
  | { key: string; kind: 'speed'; score: number; strategy: Strategy; headline: string; performance: number }
  | { key: string; kind: 'watch'; score: number; change: ChangeCard }
  | { key: string; kind: 'rank'; score: number; alert: RankAlert; googleUpdates: GoogleUpdate[] }
  | { key: string; kind: 'page-change'; score: number; change: PageChangeCard }
  | { key: string; kind: 'ai-gap'; score: number; gap: Gap };

const SEVERITY_SCORE = { critical: 100, high: 70, medium: 40, low: 20 } as const;

function todayStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Cards put off with "Later", and when. They stay on the Dashboard, just behind everything else. */
function later(): Record<string, string> {
  return getSetting<Record<string, string>>('laterItems', {});
}

/** Move a card to the back of the list. Nothing leaves the Dashboard until it is dealt with. */
export function skipItem(key: string, now = new Date()): void {
  setSetting('laterItems', { ...later(), [key]: now.toISOString() });
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
 * Everything waiting for the user, best first: critical fixes and serious speed problems, then drafts
 * (those built on real search data first), then smaller fixes. Cards put off with "Later" go to the back,
 * in the order they were put off.
 */
export function todayFeed(now = new Date()): TodayItem[] {
  const items: TodayItem[] = [];

  for (const f of openFixes(getSetting<AuditResult | null>('lastAudit', null))) items.push({ key: `fix:${f.id}`, kind: 'fix', score: SEVERITY_SCORE[f.severity], fix: f });

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

  // A tracked search moved a lot: a drop needs a look sooner than a rise.
  // With a Google update in that week, the drop may be Google's doing rather than the page's.
  for (const a of openAlerts()) items.push({ key: `rank:${a.id}`, kind: 'rank', score: a.to > a.from ? 75 : 45, alert: a, googleUpdates: updatesNear(a.week, 7) });

  // The site's own pages changed since the last read: a page hidden from Google is as urgent as anything here.
  for (const c of openPageChanges()) items.push({ key: `page-change:${c.id}`, kind: 'page-change', score: c.worst === 'critical' ? 95 : c.worst === 'high' ? 65 : 15, change: c });

  // AI assistants recommend someone else for a customer question: a clear content gap. At most three a day.
  for (const g of openGaps().slice(0, 3)) items.push({ key: `ai-gap:${g.runId}:${g.questionId}`, kind: 'ai-gap', score: 55, gap: g });

  // Competitor news: worth a look, but after anything that needs action.
  for (const c of openChanges()) {
    const real = c.changes.some((x) => x.kind !== 'unreachable');
    items.push({ key: `watch:${c.id}`, kind: 'watch', score: real ? 50 : 10, change: c });
  }

  for (const d of listDrafts({ status: 'draft' })) {
    const { body, originalBody, ...rest } = d;
    const fromData = d.meta.source === 'search-console';
    items.push({ key: `draft:${d.id}`, kind: 'draft', score: fromData ? 80 : 60, draft: { ...rest, preview: preview(body), words: body.split(/\s+/).length, targets: targetsFor(d.kind) } });
  }

  const put = later();
  // Forget "Later" marks for cards that are gone, so the list doesn't grow forever.
  if (Object.keys(put).some((k) => !items.some((i) => i.key === k))) setSetting('laterItems', Object.fromEntries(items.filter((i) => put[i.key]).map((i) => [i.key, put[i.key]])));
  return items.sort((a, b) => (put[a.key] ?? '').localeCompare(put[b.key] ?? '') || b.score - a.score || a.key.localeCompare(b.key));
}

/** How many cards are waiting, and how many were dealt with today. */
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
  recordFeedback(d, 'rejected', reason);
  countDone();
}

export function fixDone(id: string): void {
  // Look it up before marking it: a pinned fix leaves the pinned list once done.
  const issue = getSetting<AuditResult | null>('lastAudit', null)?.issues.find((i) => i.id === id) ?? pinnedIssues().find((i) => i.id === id);
  markFixDone(id);
  if (issue) recordFixDone(issue);
  countDone();
}

/** Speed panel → the Dashboard's fixes. Returns the fix, or null when that report has nothing to fix. */
export function sendSpeedToSeo(strategy: Strategy): Issue | null {
  const r = lastSpeed()[strategy];
  const issue = r && speedIssue(r);
  if (!issue) return null;
  pinIssue(issue);
  setSetting('speedHandled', { ...getSetting<Record<string, string>>('speedHandled', {}), [strategy]: r!.at });
  return issue;
}

export function changeSeen(id: number): void {
  dismissChange(id);
  countDone();
}

export function rankAlertSeen(id: number): void {
  dismissAlert(id);
  countDone();
}

export function pageChangeSeen(id: number): void {
  dismissPageChange(id);
  countDone();
}

export function aiGapSeen(runId: number, questionId: number): void {
  gapDone(runId, questionId);
  countDone();
}
