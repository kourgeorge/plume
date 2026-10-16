import { getDb } from './db';

export type Level = 'info' | 'warn' | 'error';

/** Everything worth knowing later goes here, and to the terminal. Shown on the Logs page. */
export function log(level: Level, source: string, message: string): void {
  try {
    getDb().prepare('INSERT INTO logs (at, level, source, message) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), level, source, message);
  } catch {
    /* logging must never break the thing being logged */
  }
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${source}] ${message}`);
}

export function recentLogs(opts: { limit?: number; source?: string; level?: Level } = {}) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.source) (where.push('source = ?'), args.push(opts.source));
  if (opts.level) (where.push('level = ?'), args.push(opts.level));
  return getDb()
    .prepare(`SELECT at, level, source, message FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, opts.limit ?? 200);
}

/** Keep the log from growing forever: drop entries older than 60 days. */
export function pruneLogs(days = 60): void {
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
  getDb().prepare('DELETE FROM logs WHERE at < ?').run(cutoff);
  getDb().prepare('DELETE FROM task_runs WHERE started_at < ?').run(cutoff);
}
