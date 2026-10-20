import { getDb } from './db';
import { recordFeedback } from './feedback';

export type DraftStatus = 'draft' | 'approved' | 'published' | 'failed' | 'rejected';

export interface DraftMeta {
  slug?: string;
  metaDescription?: string;
  keyword?: string;
  /** Why the agent thinks this is worth doing. Shown in the inbox. */
  reason?: string;
  sources?: string[];
  [k: string]: unknown;
}

export interface Draft {
  id: number;
  agent: string;
  kind: string;
  title: string;
  body: string;
  originalBody: string;
  meta: DraftMeta;
  status: DraftStatus;
  target: string | null;
  scheduledFor: string | null;
  publishedUrl: string | null;
  externalId: string | null;
  dryRun: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Which status changes are allowed. Failed items can be retried; rejected ones can be reopened. */
const TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  draft: ['approved', 'rejected'],
  approved: ['published', 'failed', 'draft'],
  failed: ['approved', 'draft', 'rejected'],
  rejected: ['draft'],
  published: [],
};

export function canMove(from: DraftStatus, to: DraftStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

function fromRow(r: any): Draft {
  return {
    id: r.id,
    agent: r.agent,
    kind: r.kind,
    title: r.title,
    body: r.body,
    originalBody: r.original_body,
    meta: JSON.parse(r.meta),
    status: r.status,
    target: r.target,
    scheduledFor: r.scheduled_for,
    publishedUrl: r.published_url,
    externalId: r.external_id,
    dryRun: !!r.dry_run,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const now = () => new Date().toISOString();

function logEvent(id: number, from: DraftStatus | null, to: DraftStatus, note?: string): void {
  getDb().prepare('INSERT INTO draft_events (draft_id, at, from_status, to_status, note) VALUES (?, ?, ?, ?, ?)').run(id, now(), from, to, note ?? null);
}

export function createDraft(d: { agent: string; kind: string; title: string; body: string; meta: DraftMeta }): Draft {
  const t = now();
  const r = getDb()
    .prepare(
      `INSERT INTO drafts (agent, kind, title, body, original_body, meta, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .run(d.agent, d.kind, d.title, d.body, d.body, JSON.stringify(d.meta), t, t);
  const id = Number(r.lastInsertRowid);
  logEvent(id, null, 'draft', `written by ${d.agent}`);
  return getDraft(id)!;
}

export function getDraft(id: number): Draft | undefined {
  const r = getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  return r ? fromRow(r) : undefined;
}

export function listDrafts(filter: { status?: DraftStatus; agent?: string } = {}): Draft[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.status) (where.push('status = ?'), args.push(filter.status));
  if (filter.agent) (where.push('agent = ?'), args.push(filter.agent));
  const sql = `SELECT * FROM drafts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`;
  return getDb().prepare(sql).all(...args).map(fromRow);
}

/** Edit text or SEO fields. Only before publishing. */
export function editDraft(id: number, patch: { title?: string; body?: string; meta?: DraftMeta }): Draft {
  const d = mustGet(id);
  if (d.status === 'published') throw new Error('already published; edit it on the site instead');
  getDb()
    .prepare('UPDATE drafts SET title = ?, body = ?, meta = ?, updated_at = ? WHERE id = ?')
    .run(patch.title ?? d.title, patch.body ?? d.body, JSON.stringify({ ...d.meta, ...patch.meta }), now(), id);
  return getDraft(id)!;
}

export function moveDraft(
  id: number,
  to: DraftStatus,
  fields: { target?: string; scheduledFor?: string | null; publishedUrl?: string; externalId?: string; dryRun?: boolean; error?: string | null; note?: string } = {},
): Draft {
  const d = mustGet(id);
  if (!canMove(d.status, to)) throw new Error(`cannot move a ${d.status} item to ${to}`);
  getDb()
    .prepare(
      `UPDATE drafts SET status = ?, target = ?, scheduled_for = ?, published_url = ?, external_id = ?, dry_run = ?, error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      to,
      fields.target ?? d.target,
      fields.scheduledFor !== undefined ? fields.scheduledFor : d.scheduledFor,
      fields.publishedUrl ?? d.publishedUrl,
      fields.externalId ?? d.externalId,
      (fields.dryRun ?? d.dryRun) ? 1 : 0,
      fields.error !== undefined ? fields.error : to === 'failed' ? d.error : null,
      now(),
      id,
    );
  logEvent(id, d.status, to, fields.note ?? fields.error ?? undefined);
  const after = getDraft(id)!;
  // A first approval teaches the agent what the user wants; a retry after a failed publish is not a new decision.
  if (d.status === 'draft' && to === 'approved') recordFeedback(after, 'approved');
  return after;
}

/** Approved items whose time has come (or that have no time set). */
export function dueDrafts(at = new Date()): Draft[] {
  return getDb()
    .prepare(`SELECT * FROM drafts WHERE status = 'approved' AND (scheduled_for IS NULL OR scheduled_for <= ?) ORDER BY id`)
    .all(at.toISOString())
    .map(fromRow);
}

export function draftEvents(id: number): { at: string; from_status: string | null; to_status: string; note: string | null }[] {
  return getDb().prepare('SELECT at, from_status, to_status, note FROM draft_events WHERE draft_id = ? ORDER BY id').all(id) as any;
}

/** Keywords already covered by any draft that wasn't rejected — agents skip these. */
export function usedKeywords(): Set<string> {
  const rows = getDb().prepare(`SELECT meta FROM drafts WHERE status != 'rejected'`).all() as { meta: string }[];
  return new Set(rows.map((r) => (JSON.parse(r.meta).keyword ?? '').toLowerCase().trim()).filter(Boolean));
}

/**
 * Throw a draft away for good: no learning, no history. Published ones stay, since they are on the site
 * and the results pages measure them. What the agent learned from earlier decisions is kept.
 */
export function deleteDraft(id: number): void {
  const d = mustGet(id);
  if (d.status === 'published') throw new Error('already published; it stays so its results can be tracked');
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM draft_events WHERE draft_id = ?').run(id);
    db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
  })();
}

function mustGet(id: number): Draft {
  const d = getDraft(id);
  if (!d) throw new Error(`no draft ${id}`);
  return d;
}
