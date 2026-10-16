import cron, { ScheduledTask } from 'node-cron';
import { getDb, getSetting, setSetting } from './db';
import { log, pruneLogs } from './log';
import { publishDue } from './publish/runner';
import { pullIfDue } from './analytics/pull';
import { crawlSite } from './research/crawl';
import { closeBrowser } from './research/fetchPage';
import { dailyFixes, runAudit } from './agents/seoAudit';
import { checkSpeed } from './analytics/pagespeed';
import { AGENTS, runAgent } from './agents';
import { BudgetExceeded } from './llm/budget';
import { finishJob, startJob } from './jobs';

export interface TaskDef {
  id: string;
  label: string;
  /** Default timetable (cron, local time). Minutes are off :00/:30 on purpose. */
  cron: string;
  /** Spends AI budget — such tasks start switched off. */
  costsMoney: boolean;
  /** Logged on success: what was done, in a few words. Return null to log nothing (quiet tasks). */
  run(): Promise<string | null>;
}

export interface TaskSetting {
  enabled: boolean;
  cron: string;
  /** Agents only: drafts per run. */
  limit?: number;
}

const site = () => getSetting<string | null>('siteUrl', null);

/** Every timed thing Plume does. Agents are added from the agent list, so new agents get a timetable for free. */
export function taskDefs(): TaskDef[] {
  return [
    {
      id: 'publish',
      label: 'Publish scheduled posts',
      cron: '* * * * *',
      costsMoney: false,
      run: async () => {
        const n = await publishDue();
        return n ? `published ${n} item(s)` : null;
      },
    },
    {
      id: 'google',
      label: 'Get Search Console and Analytics data',
      cron: '7 6 * * *',
      costsMoney: false,
      run: async () => {
        await pullIfDue();
        return 'checked for new Google data';
      },
    },
    {
      id: 'site-check',
      label: 'Re-read the site and run the site check',
      cron: '47 5 * * *',
      costsMoney: false,
      run: async () => {
        const url = site();
        if (!url) return 'skipped: no site yet';
        try {
          const pages = await crawlSite(url);
          const audit = await runAudit(url);
          const today = dailyFixes(audit);
          return `read ${pages.length} pages, score ${audit.score}, today's fixes: ${today.map((i) => i.title).join('; ') || 'none'}`;
        } finally {
          await closeBrowser();
        }
      },
    },
    {
      id: 'speed',
      label: 'Check page speed (mobile and desktop)',
      cron: '17 6 * * *',
      costsMoney: false,
      run: async () => {
        const url = site();
        if (!url) return 'skipped: no site yet';
        const s = await checkSpeed(url);
        return `mobile ${s.mobile?.scores.performance}, desktop ${s.desktop?.scores.performance}`;
      },
    },
    {
      id: 'cleanup',
      label: 'Tidy old logs',
      cron: '53 3 * * *',
      costsMoney: false,
      run: async () => (pruneLogs(), null),
    },
    ...AGENTS.map<TaskDef>((a) => ({
      id: `agent:${a.id}`,
      label: `${a.label} agent: find work and draft`,
      cron: '13 7 * * 1-5',
      costsMoney: true,
      run: async () => {
        const n = await runAgent(a.id, taskSetting(`agent:${a.id}`).limit ?? 1);
        return `wrote ${n} draft(s)`;
      },
    })),
  ];
}

export function taskSetting(id: string): TaskSetting {
  const def = taskDefs().find((t) => t.id === id);
  const saved: Partial<TaskSetting> | undefined = getSetting<Record<string, Partial<TaskSetting>>>('tasks', {})[id];
  return { enabled: !def?.costsMoney, cron: def?.cron ?? '', limit: 1, ...saved };
}

export function updateTask(id: string, patch: Partial<TaskSetting>): TaskSetting {
  if (!taskDefs().some((t) => t.id === id)) throw new Error(`no task ${id}`);
  if (patch.cron !== undefined && !cron.validate(patch.cron)) throw new Error(`"${patch.cron}" is not a valid timetable`);
  if (patch.limit !== undefined && !(Number.isInteger(patch.limit) && patch.limit >= 1 && patch.limit <= 10)) throw new Error('drafts per run must be 1–10');
  const all = getSetting<Record<string, TaskSetting>>('tasks', {});
  all[id] = { ...taskSetting(id), ...patch };
  setSetting('tasks', all);
  reschedule();
  return all[id];
}

const running = new Set<string>();

/** Run one task now: never twice at once, always recorded, errors logged rather than thrown. */
export async function runTask(id: string): Promise<{ status: 'done' | 'failed' | 'skipped'; message: string }> {
  const def = taskDefs().find((t) => t.id === id);
  if (!def) throw new Error(`no task ${id}`);
  if (running.has(id)) return { status: 'skipped', message: 'already running' };
  running.add(id);
  const quiet = id === 'publish';
  const jobId = quiet ? null : startJob(`task:${id}`, def.label);
  const runId = quiet ? null : Number(getDb().prepare(`INSERT INTO task_runs (task, started_at, status) VALUES (?, ?, 'running')`).run(id, new Date().toISOString()).lastInsertRowid);
  const end = (status: 'done' | 'failed' | 'skipped', message: string) => {
    if (runId) getDb().prepare('UPDATE task_runs SET status = ?, message = ?, finished_at = ? WHERE id = ?').run(status, message, new Date().toISOString(), runId);
    if (jobId) finishJob(jobId, status === 'failed' ? message : undefined);
    return { status, message };
  };
  try {
    const msg = await def.run();
    if (msg) log('info', id, msg);
    return end('done', msg ?? '');
  } catch (err: any) {
    const message = String(err?.message ?? err);
    // Out of budget is expected, not a fault: say so once per run, as a warning.
    log(err instanceof BudgetExceeded ? 'warn' : 'error', id, message);
    return end(err instanceof BudgetExceeded ? 'skipped' : 'failed', message);
  } finally {
    running.delete(id);
  }
}

let scheduled: ScheduledTask[] = [];

export function startScheduler(): void {
  reschedule();
  log('info', 'scheduler', `started: ${scheduled.length} timed task(s) on`);
}

function reschedule(): void {
  for (const t of scheduled) t.stop();
  scheduled = [];
  for (const def of taskDefs()) {
    const s = taskSetting(def.id);
    if (!s.enabled) continue;
    scheduled.push(cron.schedule(s.cron, () => void runTask(def.id), { name: def.id }));
  }
}

export function stopScheduler(): void {
  for (const t of scheduled) t.stop();
  scheduled = [];
}

/** For the Logs page: each task, its timetable, next run, and last result. */
export function taskOverview() {
  const lastRun = getDb().prepare('SELECT started_at, finished_at, status, message FROM task_runs WHERE task = ? ORDER BY id DESC LIMIT 1');
  return taskDefs().map((d) => {
    const s = taskSetting(d.id);
    const next = s.enabled ? scheduled.find((t) => (t as any).name === d.id)?.getNextRun() ?? null : null;
    return { id: d.id, label: d.label, costsMoney: d.costsMoney, ...s, running: running.has(d.id), next: next?.toISOString() ?? null, last: lastRun.get(d.id) ?? null };
  });
}
