import { getDb, getSetting, setSetting } from './db';
import type { Issue } from './agents/seoAudit';
import { fixesByIssue, FixState } from './geo/codefix';
import { withId } from './issueId';

/**
 * Problems found by the agents that look for them, kept between scans like drafts.
 *
 * A scan never wipes the list. It updates each problem it finds again, adds new ones, and marks "no longer
 * found" only on problems it was in a position to find this time: the same checks, on the pages it looked at.
 * A page or check a scan skipped keeps its problems as they were.
 *
 * Where a problem stands (`state`):
 *   open      waiting for a decision, or a fix is under way
 *   fixed     the owner marked it fixed (or a merged pull request was confirmed on the live page)
 *   gone      a later scan that covered it didn't find it any more
 *   wont-fix  the owner turned it down; later scans don't bring it back
 * A fixed or gone problem that a later scan finds again is open again, with a line in its history.
 */
export type IssueState = 'open' | 'fixed' | 'gone' | 'wont-fix';

/** The five steps shared with drafts: waiting, accepted, resolved, rejected, failed. */
export type IssueStatus = 'draft' | 'approved' | 'published' | 'failed' | 'rejected';

export interface TrackedIssue extends Issue {
  /** Which agent found it: the site check, the compliance check or the security scan. */
  agent: string;
  state: IssueState;
  status: IssueStatus;
  /** The pull request, when there is one. */
  fix: FixState | null;
  firstSeen: string;
  lastSeen: string;
  /** When it was fixed, stopped being found, or turned down. */
  closedAt: string | null;
  /** Set when it was marked fixed. */
  fixedAt: string | null;
}

/** What one scan looked at, so it only closes problems it could have found. */
export interface ScanCoverage {
  agent: string;
  at: string;
  /**
   * Could this scan have found that problem (this kind of check, on that address)? A check that was skipped,
   * or a page it didn't look at, can't say a problem is gone.
   */
  covers: (check: string, url: string) => boolean;
}

const now = () => new Date().toISOString();

function logEvent(id: string, from: IssueState | null, to: IssueState, note: string | null, at = now()): void {
  getDb().prepare('INSERT INTO issue_events (issue_id, at, from_state, to_state, note) VALUES (?, ?, ?, ?, ?)').run(id, at, from, to, note);
}

function setState(id: string, from: IssueState, to: IssueState, at: string, note: string | null): void {
  getDb().prepare('UPDATE issues SET state = ?, closed_at = ? WHERE id = ?').run(to, to === 'open' ? null : at, id);
  logEvent(id, from, to, note, at);
}

/**
 * Record what a scan found. Problems found again are updated (their details can change, e.g. a new word
 * count); new ones are added; open ones it covered but didn't find are marked gone.
 */
export function recordScan(found: Issue[], scan: ScanCoverage): void {
  importOldIssues();
  const db = getDb();
  const get = db.prepare('SELECT state, last_seen FROM issues WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO issues (id, agent, check_id, url, severity, area, title, why, steps, snippet, state, first_seen, last_seen)
     VALUES (@id, @agent, @check, @url, @severity, @area, @title, @why, @steps, @snippet, 'open', @at, @at)`,
  );
  const update = db.prepare(
    `UPDATE issues SET agent = @agent, severity = @severity, area = @area, title = @title, why = @why, steps = @steps, snippet = @snippet, last_seen = @at WHERE id = @id`,
  );
  db.transaction(() => {
    const seen = new Set<string>();
    for (const i of found) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      const row = { ...i, agent: scan.agent, steps: JSON.stringify(i.steps ?? []), snippet: i.snippet ?? null, at: scan.at };
      const before = get.get(i.id) as { state: IssueState; last_seen: string } | undefined;
      if (!before) {
        insert.run(row);
        logEvent(i.id, null, 'open', `found by ${scan.agent}`, scan.at);
        continue;
      }
      // An older scan finishing late must not overwrite what a newer one saw.
      if (before.last_seen > scan.at) continue;
      update.run(row);
      if (before.state === 'fixed' || before.state === 'gone')
        setState(i.id, before.state, 'open', scan.at, before.state === 'fixed' ? 'found again after it was marked fixed' : 'found again');
    }
    // Open problems this scan could have found, but didn't: they are gone.
    const open = db.prepare(`SELECT id, check_id, url FROM issues WHERE agent = ? AND state = 'open' AND last_seen <= ?`).all(scan.agent, scan.at) as { id: string; check_id: string; url: string }[];
    for (const o of open) {
      if (seen.has(o.id) || !scan.covers(o.check_id, o.url)) continue;
      setState(o.id, 'open', 'gone', scan.at, 'no longer found');
    }
  })();
}

/** Add or refresh one problem outside a scan (e.g. from a speed report). It stays until it is dealt with. */
export function recordOne(issue: Issue, agent: string, at = now()): void {
  recordScan([issue], { agent, at, covers: () => false });
}

function stateOf(id: string): IssueState | undefined {
  importOldIssues();
  return (getDb().prepare('SELECT state FROM issues WHERE id = ?').get(id) as { state: IssueState } | undefined)?.state;
}

export function markFixed(id: string, at = new Date()): void {
  const s = stateOf(id);
  if (s && s !== 'fixed') setState(id, s, 'fixed', at.toISOString(), 'marked fixed');
}

/** Turn a problem down, or (with `on` false) put it back in the waiting list. */
export function setWontFix(id: string, on: boolean, at = new Date()): void {
  const s = stateOf(id);
  if (!s) return;
  if (on && s !== 'wont-fix') setState(id, s, 'wont-fix', at.toISOString(), "won't fix");
  if (!on && s === 'wont-fix') setState(id, s, 'open', at.toISOString(), 'reopened');
}

export function issueEvents(id: string): { at: string; from_state: string | null; to_state: string; note: string | null }[] {
  return getDb().prepare('SELECT at, from_state, to_state, note FROM issue_events WHERE issue_id = ? ORDER BY id').all(id) as any;
}

function fromRow(r: any, fix: FixState | null): TrackedIssue {
  const state = r.state as IssueState;
  const status: IssueStatus =
    state === 'wont-fix'
      ? 'rejected'
      : state === 'fixed' || state === 'gone'
        ? 'published'
        : fix && ['opened', 'merged'].includes(fix.status)
          ? 'approved'
          : fix?.status === 'failed'
            ? 'failed'
            : 'draft';
  return {
    id: r.id, check: r.check_id, severity: r.severity, area: r.area, url: r.url, title: r.title, why: r.why,
    steps: JSON.parse(r.steps), ...(r.snippet ? { snippet: r.snippet } : {}),
    agent: r.agent, state, status, fix, firstSeen: r.first_seen, lastSeen: r.last_seen, closedAt: r.closed_at,
    fixedAt: state === 'fixed' ? r.closed_at : null,
  };
}

const ORDER = `ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, url, id`;

/** Every problem any agent has found, with where it stands. */
export function trackedIssues(filter: { agent?: string; state?: IssueState } = {}): TrackedIssue[] {
  importOldIssues();
  const where: string[] = [];
  const args: string[] = [];
  if (filter.agent) (where.push('agent = ?'), args.push(filter.agent));
  if (filter.state) (where.push('state = ?'), args.push(filter.state));
  const rows = getDb().prepare(`SELECT * FROM issues ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER}`).all(...args);
  const fixes = fixesByIssue();
  return rows.map((r: any) => fromRow(r, fixes[r.id] ?? null));
}

export function findTracked(id: string): TrackedIssue | undefined {
  importOldIssues();
  const r = getDb().prepare('SELECT * FROM issues WHERE id = ?').get(id) as any;
  return r ? fromRow(r, fixesByIssue()[r.id] ?? null) : undefined;
}

/** Still needs the owner: waiting to be decided on, or a fix that failed and needs another go. */
export function openIssues(agent?: string): TrackedIssue[] {
  return trackedIssues({ agent, state: 'open' }).filter((i) => i.status === 'draft' || i.status === 'failed');
}

/**
 * One-time move from the old storage (each scan's list in settings, plus separate "fixed", "won't fix" and
 * "sent over" lists) into the issues table. Runs once per site, the first time problems are read.
 */
let importing = false;
export function importOldIssues(): void {
  if (importing || getSetting<boolean>('issuesImported', false)) return;
  importing = true;
  try {
    const db = getDb();
    const daily = getSetting<{ day?: string; done?: string[] }>('dailyFixes', {});
    const fixed = getSetting<Record<string, string> | null>('fixedIssues', null) ?? Object.fromEntries((daily.done ?? []).map((id) => [id, `${daily.day || '1970-01-01'}T23:59:59.999Z`]));
    const declined = getSetting<Record<string, string>>('wontFixIssues', {});
    // Old ids were built before addresses were written one way; build them again so they match new scans.
    const renamed = new Map<string, string>();
    const again = (i: Issue): Issue => {
      const check = i.check === 'page-speed' ? `page-speed-${/:(mobile|desktop):/.exec(i.id)?.[1] ?? 'mobile'}` : i.check;
      const n = withId({ ...i, check });
      renamed.set(i.id, n.id);
      return n;
    };
    db.transaction(() => {
      for (const [key, agent] of [['lastAudit', 'site-check'], ['lastCompliance', 'compliance'], ['lastRedScan', 'red']] as const) {
        const r = getSetting<{ issues: Issue[]; at: string } | null>(key, null);
        // The security scan no longer reports the https redirect: the site check does.
        if (r) recordScan(r.issues.filter((i) => !(agent === 'red' && i.check === 'no-https-redirect')).map(again), { agent, at: r.at, covers: () => false });
      }
      for (const i of getSetting<Issue[]>('pinnedIssues', [])) recordOne(again(i), 'site-check', '1970-01-01T00:00:00.000Z');
      const id = (x: string) => renamed.get(x) ?? x;
      for (const [x, at] of Object.entries(fixed)) {
        const r = db.prepare('SELECT state, last_seen FROM issues WHERE id = ?').get(id(x)) as { state: IssueState; last_seen: string } | undefined;
        // Marked fixed, but a scan after that still found it: it stays open.
        if (r && r.state === 'open' && at >= r.last_seen) setState(id(x), r.state, 'fixed', at, 'marked fixed');
      }
      for (const [x, at] of Object.entries(declined)) {
        const r = db.prepare('SELECT state FROM issues WHERE id = ?').get(id(x)) as { state: IssueState } | undefined;
        if (r && r.state !== 'wont-fix') setState(id(x), r.state, 'wont-fix', at, "won't fix");
      }
      // Pull requests and the "what we did" log were kept against the old ids.
      for (const [from, to] of renamed) {
        if (from === to) continue;
        db.prepare('UPDATE code_fixes SET issue_id = ? WHERE issue_id = ?').run(to, from);
        db.prepare(`UPDATE actions SET ref = ? WHERE ref = ? AND kind IN ('fix-done', 'code-pr')`).run(to, from);
      }
      setSetting('issuesImported', true);
    })();
  } finally {
    importing = false;
  }
}
