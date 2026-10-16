import { getDb } from './db';

export interface Job {
  id: number;
  kind: string;
  status: 'running' | 'done' | 'failed';
  progress: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export function startJob(kind: string, progress: string): number {
  const r = getDb()
    .prepare(`INSERT INTO jobs (kind, status, progress, started_at) VALUES (?, 'running', ?, ?)`)
    .run(kind, progress, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function updateJob(id: number, progress: string): void {
  getDb().prepare('UPDATE jobs SET progress = ? WHERE id = ?').run(progress, id);
}

export function finishJob(id: number, error?: string): void {
  getDb()
    .prepare('UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?')
    .run(error ? 'failed' : 'done', error ?? null, new Date().toISOString(), id);
}

export function getJob(id: number): Job | undefined {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
}

/** The newest still-running job of this kind, if any (for "working…" on agent folders). */
export function runningJob(kind: string): Job | undefined {
  return getDb().prepare(`SELECT * FROM jobs WHERE kind = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).get(kind) as Job | undefined;
}

/** On startup: anything still marked running was cut off by a restart. */
export function closeStaleJobs(): number {
  return getDb()
    .prepare(`UPDATE jobs SET status = 'failed', error = 'stopped because Plume was restarted', finished_at = ? WHERE status = 'running'`)
    .run(new Date().toISOString()).changes;
}
