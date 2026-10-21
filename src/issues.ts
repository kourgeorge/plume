import { getSetting, setSetting } from './db';
import { AuditResult, Issue, fixedAt, pinnedIssues } from './agents/seoAudit';
import { fixesByIssue, FixState } from './geo/codefix';
import { lastCompliance } from './compliance/scan';

/**
 * Problems found by the agents that look for them, in the same five steps as a draft:
 * waiting (to decide on), accepted (a fix is on its way), resolved (fixed), rejected (won't fix), failed.
 * Drafts finish by being published; problems finish by being fixed.
 */
export type IssueStatus = 'draft' | 'approved' | 'published' | 'failed' | 'rejected';

export interface TrackedIssue extends Issue {
  /** Which agent found it: the site check, the compliance check or the security scan. */
  agent: string;
  status: IssueStatus;
  /** The pull request, when there is one. */
  fix: FixState | null;
  fixedAt: string | null;
}

/** Problems turned down with "Won't fix", and when. A later check doesn't bring them back. */
export function wontFix(): Record<string, string> {
  return getSetting<Record<string, string>>('wontFixIssues', {});
}

/** Turn a problem down, or (with `on` false) put it back in the waiting list. */
export function setWontFix(id: string, on: boolean, at = new Date()): void {
  const { [id]: _, ...rest } = wontFix();
  setSetting('wontFixIssues', on ? { ...rest, [id]: at.toISOString() } : rest);
}

/**
 * Every problem any agent has found, with where it stands. A problem marked fixed is resolved until a check
 * that runs after that still finds it; then it is waiting again.
 */
export function trackedIssues(): TrackedIssue[] {
  const sources: { agent: string; result: { issues: Issue[]; at: string } | null }[] = [
    { agent: 'site-check', result: getSetting<AuditResult | null>('lastAudit', null) },
    { agent: 'compliance', result: lastCompliance() },
    { agent: 'red', result: getSetting<AuditResult | null>('lastRedScan', null) },
  ];
  const fixes = fixesByIssue();
  const fixed = fixedAt();
  const declined = wontFix();
  const out = new Map<string, TrackedIssue>();
  const add = (i: Issue, agent: string, foundAt: string | null) => {
    if (out.has(i.id)) return;
    const fix = fixes[i.id] ?? null;
    const isFixed = !!fixed[i.id] && (foundAt === null || fixed[i.id] >= foundAt);
    const status: IssueStatus = declined[i.id]
      ? 'rejected'
      : isFixed
        ? 'published'
        : fix && ['opened', 'merged'].includes(fix.status)
          ? 'approved'
          : fix?.status === 'failed'
            ? 'failed'
            : 'draft';
    out.set(i.id, { ...i, agent, status, fix, fixedAt: isFixed ? fixed[i.id] : null });
  };
  // Sent over by hand (from the speed panel or a scan): they stay until marked fixed.
  for (const i of pinnedIssues()) add(i, i.check === 'page-speed' ? 'site-check' : sources.find((s) => s.result?.issues.some((x) => x.id === i.id))?.agent ?? 'site-check', null);
  for (const s of sources) for (const i of s.result?.issues ?? []) add(i, s.agent, s.result!.at);
  const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return [...out.values()].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export function findTracked(id: string): TrackedIssue | undefined {
  return trackedIssues().find((i) => i.id === id);
}

/** Still needs the owner: waiting to be decided on, or a fix that failed and needs another go. */
export function openIssues(agent?: string): TrackedIssue[] {
  return trackedIssues().filter((i) => (i.status === 'draft' || i.status === 'failed') && (!agent || i.agent === agent));
}
