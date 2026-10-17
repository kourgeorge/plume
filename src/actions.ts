import { getDb, getSetting, setSetting } from './db';
import { lastDataDay, pageTotals, pathOf, PageTotals } from './analytics/results';
import type { AuditResult, Issue } from './agents/seoAudit';

/**
 * What was done to the site — a fix marked done, a page published, a document edited, a pull request opened —
 * with its date, so Plume can tell afterwards whether it worked: did the problem go away, and did the page's
 * Google numbers move. The result goes to the owner (Results, Site fixes) and to every agent's prompt.
 */

export type ActionKind = 'fix-done' | 'published' | 'doc-edited' | 'code-pr';

export interface Action {
  id: number;
  at: string;
  kind: ActionKind;
  ref: string;
  url: string | null;
  title: string;
  data: Record<string, unknown>;
}

/** How long before and after an action to compare, and the least "after" that says anything. */
export const WINDOW_DAYS = 28;
export const MIN_DAYS_AFTER = 14;

/** Files that belong to the whole site, not to one page: a fix there is measured on the whole site. */
const SITE_WIDE = ['/robots.txt', '/sitemap.xml', '/llms.txt'];

function fromRow(r: any): Action {
  return { id: r.id, at: r.at, kind: r.kind, ref: r.ref, url: r.url, title: r.title, data: JSON.parse(r.data) };
}

export function recordAction(a: { kind: ActionKind; ref: string; url?: string | null; title: string; data?: Record<string, unknown> }, at = new Date()): void {
  const db = getDb();
  const iso = at.toISOString();
  // Saving a document several times in a day is one edit, not ten.
  if (a.kind === 'doc-edited') {
    const same = db.prepare(`SELECT id FROM actions WHERE kind = 'doc-edited' AND ref = ? AND substr(at, 1, 10) = ?`).get(a.ref, iso.slice(0, 10)) as { id: number } | undefined;
    if (same) return void db.prepare('UPDATE actions SET at = ? WHERE id = ?').run(iso, same.id);
  }
  db.prepare('INSERT INTO actions (at, kind, ref, url, title, data) VALUES (?, ?, ?, ?, ?, ?)').run(iso, a.kind, a.ref, a.url ?? null, a.title, JSON.stringify(a.data ?? {}));
}

/** A site fix the owner marked done. Whole-site files (robots.txt, sitemap) are measured on the whole site. */
export function recordFixDone(issue: Issue, at = new Date()): void {
  const url = SITE_WIDE.includes(pathOf(issue.url)) ? null : issue.url;
  recordAction({ kind: 'fix-done', ref: issue.id, url, title: issue.title, data: { severity: issue.severity, area: issue.area } }, at);
}

/**
 * Pages published live before actions were recorded: add them once from the draft history, so their
 * results show up too. (Fixes marked done before then kept no date, so they can't be added.)
 */
function backfill(): void {
  if (getSetting<boolean>('actionsBackfilled', false)) return;
  const rows = getDb()
    .prepare(
      `SELECT d.id, d.title, d.published_url, d.target, MIN(e.at) at FROM drafts d JOIN draft_events e ON e.draft_id = d.id AND e.to_status = 'published'
       WHERE d.status = 'published' AND d.dry_run = 0 AND d.published_url LIKE 'http%' GROUP BY d.id`,
    )
    .all() as { id: number; title: string; published_url: string; target: string; at: string }[];
  const has = getDb().prepare(`SELECT 1 FROM actions WHERE kind = 'published' AND ref = ?`);
  for (const r of rows) if (!has.get(String(r.id))) recordAction({ kind: 'published', ref: String(r.id), url: r.published_url, title: r.title, data: { target: r.target } }, new Date(r.at));
  setSetting('actionsBackfilled', true);
}

export function listActions(limit = 100): Action[] {
  backfill();
  return getDb().prepare('SELECT * FROM actions ORDER BY at DESC, id DESC LIMIT ?').all(limit).map(fromRow);
}

// ---------------------------------------------------------------- site check history

export interface AuditPoint { day: string; at: string; score: number; critical: number; warnings: number; passed: number }

/** Keep one row per day; called by every site check. */
export function saveAuditHistory(a: AuditResult): void {
  getDb()
    .prepare(
      `INSERT INTO audit_history (day, at, score, critical, warnings, passed, issue_ids) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET at = excluded.at, score = excluded.score, critical = excluded.critical,
       warnings = excluded.warnings, passed = excluded.passed, issue_ids = excluded.issue_ids`,
    )
    .run(a.at.slice(0, 10), a.at, a.score, a.counts.critical, a.counts.warnings, a.counts.passed, JSON.stringify(a.issues.map((i) => i.id)));
}

/** Oldest first, for a score line. */
export function auditHistory(limit = 30): AuditPoint[] {
  return (getDb().prepare('SELECT day, at, score, critical, warnings, passed FROM audit_history ORDER BY day DESC LIMIT ?').all(limit) as AuditPoint[]).reverse();
}

// ---------------------------------------------------------------- results

export interface ActionResult extends Action {
  /** fix-done only: does the first site check after it still find the problem? */
  problem: 'gone' | 'still there' | 'not checked yet' | null;
  /** Google numbers for the page (or the whole site) before and after; null = nothing to compare. */
  before: PageTotals | null;
  after: PageTotals | null;
  /** How many days of data the "after" covers. */
  daysAfter: number;
  /** Fewer than MIN_DAYS_AFTER days of data since: too soon to judge. */
  tooEarly: boolean;
}

const shift = (day: string, days: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86400e3).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400e3);

function problemAfter(a: Action): ActionResult['problem'] {
  if (a.kind !== 'fix-done') return null;
  const next = getDb().prepare('SELECT issue_ids FROM audit_history WHERE at > ? ORDER BY at LIMIT 1').get(a.at) as { issue_ids: string } | undefined;
  if (!next) return 'not checked yet';
  return (JSON.parse(next.issue_ids) as string[]).includes(a.ref) ? 'still there' : 'gone';
}

/**
 * Each action with what happened afterwards. The "before" is as long as the "after" (up to 28 days each),
 * so a page measured 20 days after a fix is compared with the 20 days before it. Published pages are new,
 * so they have no "before".
 */
export function actionResults(limit = 50): ActionResult[] {
  const last = lastDataDay('gsc_daily') ?? lastDataDay('ga_daily');
  return listActions(limit).map((a) => {
    const day = a.at.slice(0, 10);
    const base = { ...a, problem: problemAfter(a), before: null, after: null, daysAfter: 0, tooEarly: true };
    // Document edits change what agents write, not a page: there is nothing to measure on the site.
    if (a.kind === 'doc-edited' || !last) return base;
    const daysAfter = Math.max(0, daysBetween(day, last));
    const len = Math.min(WINDOW_DAYS, daysAfter);
    const path = a.url ? pathOf(a.url) : null;
    const after = len ? pageTotals(path, shift(day, 1), shift(day, len)) : null;
    const before = a.kind === 'published' || !len ? null : pageTotals(path, shift(day, -len), shift(day, -1));
    return { ...base, before, after, daysAfter, tooEarly: daysAfter < MIN_DAYS_AFTER };
  });
}

// ---------------------------------------------------------------- for agents

const WHAT: Record<ActionKind, string> = { 'fix-done': 'Fixed', published: 'Published', 'doc-edited': 'The owner edited', 'code-pr': 'Opened a code fix for' };

const round = (n: number | null) => (n === null ? '—' : n.toFixed(1));

export function describeResult(r: ActionResult): string {
  const where = r.url ? ` on ${pathOf(r.url)}` : r.kind === 'doc-edited' ? '' : ' (whole site)';
  const parts = [`${WHAT[r.kind]} "${r.title}"${where} on ${r.at.slice(0, 10)}.`];
  if (r.problem === 'gone') parts.push('The site check no longer finds the problem.');
  if (r.problem === 'still there') parts.push('The site check still finds the problem.');
  if (r.kind !== 'doc-edited') {
    if (r.tooEarly) parts.push('Too early to tell.');
    else if (r.after && r.before) {
      parts.push(`Over ${Math.min(WINDOW_DAYS, r.daysAfter)} days before vs after: clicks ${r.before.clicks} → ${r.after.clicks}, impressions ${r.before.impressions} → ${r.after.impressions}, position ${round(r.before.position)} → ${round(r.after.position)}${r.after.views !== null && r.before.views !== null ? `, views ${r.before.views} → ${r.after.views}` : ''}.`);
    } else if (r.after) parts.push(`Since then: ${r.after.clicks} clicks, ${r.after.impressions} impressions${r.after.position !== null ? `, position ${round(r.after.position)}` : ''}${r.after.views !== null ? `, ${r.after.views} views` : ''}.`);
  }
  return `- ${parts.join(' ')}`;
}

/** The note every agent gets: what was done lately and what happened. Null when nothing was recorded yet. */
export function actionsNote(limit = 12): string | null {
  const rows = actionResults(limit);
  if (!rows.length) return null;
  return [
    'What was done on the site lately and what happened afterwards (newest first):',
    ...rows.map(describeResult),
    'Do more of what moved the numbers. Do not propose fixes or pages that are already done.',
  ].join('\n');
}
