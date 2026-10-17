import { getDb, getGlobalDb } from './db';
import { currentSiteOrNull } from './site';

export type Level = 'info' | 'warn' | 'error';

/** Everything worth knowing later goes here, and to the terminal. Shown on the Logs page. */
export function log(level: Level, source: string, message: string): void {
  try {
    getGlobalDb().prepare('INSERT INTO logs (at, site, level, source, message) VALUES (?, ?, ?, ?, ?)').run(new Date().toISOString(), currentSiteOrNull(), level, source, message);
  } catch {
    /* logging must never break the thing being logged */
  }
  const site = currentSiteOrNull();
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[${site ? `${site} ` : ''}${source}] ${message}`);
}

/**
 * This site's log lines, newest first. Plume's own lines (starting up, the scheduler) are about no site, so
 * they only show here when they are warnings or errors every site should see, like "AI is off".
 */
export function recentLogs(opts: { limit?: number; source?: string; level?: Level } = {}) {
  const site = currentSiteOrNull();
  const where: string[] = [site ? `(site = ? OR (site IS NULL AND level != 'info'))` : 'site IS NULL'];
  const args: unknown[] = site ? [site] : [];
  if (opts.source) (where.push('source = ?'), args.push(opts.source));
  if (opts.level) (where.push('level = ?'), args.push(opts.level));
  return getGlobalDb()
    .prepare(`SELECT at, site, level, source, message FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...args, opts.limit ?? 200);
}

/** Keep the log from growing forever: drop entries older than 60 days. */
export function pruneLogs(days = 60): void {
  const cutoff = new Date(Date.now() - days * 86400e3).toISOString();
  getGlobalDb().prepare('DELETE FROM logs WHERE at < ?').run(cutoff);
  if (currentSiteOrNull()) {
    getDb().prepare('DELETE FROM task_runs WHERE started_at < ?').run(cutoff);
    // Finished jobs only matter for "working…" and a progress page; keep a month.
    const jobCutoff = new Date(Date.now() - 30 * 86400e3).toISOString();
    getDb().prepare(`DELETE FROM jobs WHERE status != 'running' AND started_at < ?`).run(jobCutoff);
  }
}
