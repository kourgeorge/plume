import { getDb } from './db';

/** "Not useful" on a draft: remembered so the agent stops repeating it. */
export function recordFeedback(agent: string, title: string, reason: string | null): void {
  getDb().prepare('INSERT INTO feedback (at, agent, title, reason) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), agent, title, reason?.trim() || null);
}

/** The agent's recent rejections, newest first, as a note for its prompt. Null when there are none. */
export function feedbackNote(agent: string, limit = 15): string | null {
  const rows = getDb().prepare('SELECT title, reason FROM feedback WHERE agent = ? ORDER BY id DESC LIMIT ?').all(agent, limit) as { title: string; reason: string | null }[];
  if (!rows.length) return null;
  return [
    'The user turned down these recent drafts of yours. Avoid repeating the topic or the problem:',
    ...rows.map((r) => `- "${r.title}"${r.reason ? `: ${r.reason}` : ' (no reason given)'}`),
  ].join('\n');
}
