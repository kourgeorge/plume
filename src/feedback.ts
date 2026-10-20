import { getDb } from './db';
import { lineDiff } from './diff';
import type { Draft } from './queue';

type Verdict = 'rejected' | 'approved';

interface Row {
  verdict: Verdict;
  title: string;
  reason: string | null;
  kind: string | null;
  keyword: string | null;
  why: string | null;
  edits: string | null;
}

/** At most this many changed lines are kept per approved draft: enough to show the user's taste, not the whole post. */
const MAX_EDIT_LINES = 8;

/** The lines the user removed or added before approving, or null when the agent's text went out as written. */
export function userEdits(original: string, final: string): string | null {
  if (original.trim() === final.trim()) return null;
  const changed = lineDiff(original, final, 0).filter((l) => (l.t === 'add' || l.t === 'del') && l.line.trim());
  if (!changed.length) return null;
  const lines = changed.slice(0, MAX_EDIT_LINES).map((l) => `${l.t === 'del' ? '-' : '+'} ${l.line.trim().slice(0, 200)}`);
  if (changed.length > MAX_EDIT_LINES) lines.push(`(${changed.length - MAX_EDIT_LINES} more changed lines)`);
  return lines.join('\n');
}

/** Remember what the user decided about a draft, so its agent does more of the good and less of the bad. */
export function recordFeedback(d: Draft, verdict: Verdict, reason: string | null = null): void {
  const keyword = typeof d.meta.keyword === 'string' ? d.meta.keyword : null;
  const why = typeof d.meta.reason === 'string' ? d.meta.reason : null;
  const edits = verdict === 'approved' ? userEdits(d.originalBody, d.body) : null;
  getDb()
    .prepare('INSERT INTO feedback (at, agent, title, reason, verdict, draft_id, kind, keyword, why, edits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), d.agent, d.title, reason?.trim() || null, verdict, d.id, d.kind, keyword, why, edits);
}

function describe(r: Row): string {
  const about = [r.kind, r.keyword ? `keyword "${r.keyword}"` : null].filter(Boolean).join(', ');
  return `- "${r.title}"${about ? ` (${about})` : ''}`;
}

/** The agent's recent rejections and approvals, newest first, as a note for its prompt. Null when there are none. */
export function feedbackNote(agent: string, limit = 15): string | null {
  const recent = (verdict: Verdict, n: number) =>
    getDb().prepare('SELECT * FROM feedback WHERE agent = ? AND verdict = ? ORDER BY id DESC LIMIT ?').all(agent, verdict, n) as Row[];
  const rejected = recent('rejected', limit);
  const approved = recent('approved', Math.ceil(limit / 2));
  const parts: string[] = [];
  if (rejected.length) {
    parts.push(
      [
        'The user turned down these recent drafts of yours. Avoid repeating the topic or the problem:',
        ...rejected.map((r) => `${describe(r)}: ${r.reason ?? '(no reason given)'}${r.why ? `\n  You had written it because: ${r.why}` : ''}`),
      ].join('\n'),
    );
  }
  if (approved.length) {
    parts.push(
      [
        'The user approved these recent drafts of yours. This is the kind of work they want; do not copy them, but keep the same direction:',
        ...approved.map((r) => `${describe(r)}${r.edits ? `\n  Before approving, the user changed (- your line, + theirs):\n${r.edits.replace(/^/gm, '    ')}` : ''}`),
      ].join('\n'),
    );
  }
  return parts.length ? parts.join('\n\n') : null;
}

/** A reason given after the fact (a Telegram reply to "why?"): fills in the draft's latest rejection. False when there is none. */
export function addReason(draftId: number, reason: string): boolean {
  const r = getDb()
    .prepare(`UPDATE feedback SET reason = ? WHERE id = (SELECT id FROM feedback WHERE draft_id = ? AND verdict = 'rejected' ORDER BY id DESC LIMIT 1)`)
    .run(reason.trim(), draftId);
  return r.changes > 0;
}
