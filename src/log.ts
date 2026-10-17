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

export interface LogQuery {
  limit?: number;
  source?: string;
  level?: Level;
  /** Only warnings and errors. */
  problems?: boolean;
}

function query(where: string[], args: unknown[], opts: LogQuery) {
  if (opts.source) (where.push('source = ?'), args.push(opts.source));
  if (opts.level) (where.push('level = ?'), args.push(opts.level));
  if (opts.problems) where.push(`level != 'info'`);
  return getGlobalDb()
    .prepare(`SELECT at, site, level, source, message FROM logs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`)
    .all(...args, opts.limit ?? 200) as { at: string; site: string | null; level: Level; source: string; message: string }[];
}

/** What happened on this website, newest first: its own actions only. Plume's own lines are in `systemLogs`. */
export function recentLogs(opts: LogQuery = {}) {
  const site = currentSiteOrNull();
  return site ? query(['site = ?'], [site], opts) : query(['site IS NULL'], [], opts);
}

/**
 * The whole system's log: Plume itself (start-up, AI connection, scheduler) and every website, newest first.
 * `site` narrows it to one website; `site: ''` to Plume's own lines.
 */
export function systemLogs(opts: LogQuery & { site?: string } = {}) {
  if (opts.site === '') return query(['site IS NULL'], [], opts);
  if (opts.site) return query(['site = ?'], [opts.site], opts);
  return query(['1 = 1'], [], opts);
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
