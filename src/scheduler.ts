import cron, { ScheduledTask } from 'node-cron';
import { getDb, getSetting, setSetting } from './db';
import { log, pruneLogs } from './log';
import { publishDue } from './publish/runner';
import { pullIfDue } from './analytics/pull';
import { crawlSite } from './research/crawl';
import { closeBrowser } from './research/fetchPage';
import { runAudit } from './agents/seoAudit';
import { openIssues } from './issues';
import { checkSpeed } from './analytics/pagespeed';
import { AGENTS, runAgent } from './agents';
import { BudgetExceeded } from './llm/budget';
import { checkWatched, scanWatchedNews } from './watch';
import { detectMoves, listTracked } from './seo/rankings';
import { checkAllSerps, serpCreds } from './seo/serp';
import { keywordMetrics, refreshCompetitorKeywords } from './seo/keywordData';
import { listCompetitors } from './context/extra';
import { listQuestions, runVisibilityCheck, visibilitySummary } from './geo/visibility';
import { finishJob, runningJob, startJob, updateJob } from './jobs';
import { followUpFixes } from './geo/codefix';
import { currentSite, withSite } from './site';
import { listSites, siteUrl } from './sites';
import { googleConnected } from './analytics/google';
import { profileComplete } from './context/profile';
import { llmProblem } from './llm/settings';

export interface TaskDef {
  id: string;
  label: string;
  /** Which part of the Timetable page it is listed under. */
  group: 'agents' | 'checks' | 'paid';
  /** A short note under the name: what it costs, where the data comes from. */
  note?: string;
  /** Default timetable (cron, local time). Minutes are off :00/:30 on purpose. */
  cron: string;
  /** Spends money (AI or DataForSEO) — such tasks start switched off. */
  costsMoney: boolean;
  /** Plumbing that must keep running (publishing, tidying): always on, not listed on the Timetable page. */
  system?: boolean;
  /** Agents only: the number of drafts per run can be set. */
  perRun?: boolean;
  /** Starts switched off even though it is free (e.g. a check that takes hours). */
  offByDefault?: boolean;
  /** What is missing before this task can do anything, in a few words; null when it is ready. Such runs are skipped without a record. */
  needs?(): string | null;
  /** Logged on success: what was done, in a few words. Return null to log nothing (quiet tasks). */
  run(progress: (m: string) => void): Promise<string | null>;
}

export interface TaskSetting {
  enabled: boolean;
  cron: string;
  /** Agents only: drafts per run. */
  limit?: number;
}

const site = () => siteUrl();
const noSite = () => (site() ? null : 'your website');
const noAi = () => (llmProblem() ? 'an AI connection' : null);
const watched = () => listCompetitors().filter((c) => c.watch);

/** Agents start one after another from 08:17 on weekdays, after the morning checks, so their drafts don't all land at once. */
const agentCron = (i: number) => `${17 + 6 * i} 8 * * 1-5`;

/** Every timed thing Plume does. Agents are added from the agent list, so new agents get a timetable for free. */
export function taskDefs(): TaskDef[] {
  return [
    {
      id: 'publish',
      label: 'Publish approved posts when their time comes',
      group: 'checks',
      system: true,
      cron: '* * * * *',
      costsMoney: false,
      run: async () => {
        const n = await publishDue();
        return n ? `published ${n} item(s)` : null;
      },
    },
    {
      id: 'fix-follow-up',
      label: 'Check merged fix pull requests on the live site',
      group: 'checks',
      system: true,
      cron: '23 * * * *',
      costsMoney: false,
      run: async () => {
        const r = await followUpFixes();
        if (!r.checked) return null;
        return `checked ${r.checked} pull request(s)${r.verified.length ? `, ${r.verified.length} confirmed fixed` : ''}${r.closed ? `, ${r.closed} closed without merging` : ''}`;
      },
    },
    {
      id: 'cleanup',
      label: 'Tidy old logs',
      group: 'checks',
      system: true,
      cron: '53 3 * * *',
      costsMoney: false,
      run: async () => (pruneLogs(), null),
    },
    {
      id: 'compliance-all-pages',
      label: 'Privacy and accessibility check on every page',
      group: 'checks',
      note: 'Opens every page in Chrome; can take hours on a big site. The Compliance agent already checks one page of each kind.',
      cron: '23 2 * * 0',
      costsMoney: false,
      offByDefault: true,
      needs: noSite,
      run: async (progress) => {
        try {
          const { runComplianceScan } = require('./compliance/scan') as typeof import('./compliance/scan');
          const r = await runComplianceScan(site()!, progress, { allPages: true });
          return `checked ${r.pagesChecked} pages: ${r.counts.critical} serious, ${r.counts.warnings} other problem(s)`;
        } finally {
          await closeBrowser();
        }
      },
    },
    {
      id: 'site-check',
      label: 'Re-read the site and run the site check',
      group: 'checks',
      note: 'Puts the problems it finds on the Dashboard.',
      cron: '47 5 * * *',
      costsMoney: false,
      needs: noSite,
      run: async (progress) => {
        try {
          progress('Reading the site');
          const pages = await crawlSite(site()!);
          progress('Running the site check');
          const audit = await runAudit(site()!);
          return `read ${pages.length} pages, score ${audit.score}, ${openIssues('site-check').length} problems waiting on the Dashboard`;
        } finally {
          await closeBrowser();
        }
      },
    },
    {
      id: 'google',
      label: 'Get Search Console and Analytics data',
      group: 'checks',
      note: 'Also flags tracked searches that moved 3 or more places.',
      cron: '7 6 * * *',
      costsMoney: false,
      needs: () => (googleConnected() ? null : 'Google connected'),
      run: async () => {
        await pullIfDue();
        const moved = listTracked().length ? detectMoves() : 0;
        return `checked for new Google data${moved ? `; ${moved} tracked search(es) moved 3 or more places` : ''}`;
      },
    },
    {
      id: 'speed',
      label: 'Check page speed (mobile and desktop)',
      group: 'checks',
      cron: '17 6 * * *',
      costsMoney: false,
      needs: noSite,
      run: async () => {
        const s = await checkSpeed(site()!);
        return `mobile ${s.mobile?.scores.performance}, desktop ${s.desktop?.scores.performance}`;
      },
    },
    {
      id: 'competitor-watch',
      label: 'Check watched competitors for changes',
      group: 'checks',
      note: 'New pages, headline, description and prices.',
      cron: '37 6 * * 1',
      costsMoney: false,
      needs: () => (watched().some((c) => c.url) ? null : 'a watched competitor'),
      run: async () => {
        try {
          const r = await checkWatched();
          return `checked ${r.checked}, ${r.withChanges} changed${r.failed.length ? `, couldn't read ${r.failed.join(', ')}` : ''}`;
        } finally {
          await closeBrowser();
        }
      },
    },
    {
      id: 'competitor-news',
      label: 'Search news and LinkedIn/X posts for watched competitors',
      group: 'paid',
      note: 'Uses AI with web search.',
      cron: '47 6 * * 1',
      costsMoney: true,
      needs: () => noAi() ?? (watched().length ? null : 'a watched competitor'),
      run: async () => {
        const r = await scanWatchedNews();
        return `scanned ${r.scanned}, ${r.withNews} with news${r.suggested ? `, ${r.suggested} new competitor(s) suggested` : ''}${r.failed.length ? `, failed for ${r.failed.join(', ')}` : ''}`;
      },
    },
    {
      id: 'serp',
      label: 'Look up who outranks you on Google',
      group: 'paid',
      note: 'DataForSEO, about $0.002 per tracked search.',
      cron: '43 7 * * 1',
      costsMoney: true,
      needs: () => (!serpCreds() ? 'DataForSEO connected' : listTracked().length ? null : 'a tracked search'),
      run: async () => {
        const r = await checkAllSerps();
        if (r.failed) throw new Error(`checked ${r.checked}, then stopped: ${r.failed}`);
        return `checked ${r.checked} search(es) for $${r.cost.toFixed(3)}`;
      },
    },
    {
      id: 'ai-visibility',
      label: 'Ask Claude, GPT and Gemini your customer questions and see who they recommend',
      group: 'paid',
      note: 'About $0.01 per question per assistant.',
      cron: '53 7 * * 1',
      costsMoney: true,
      needs: () => noAi() ?? (listQuestions().length ? null : 'customer questions to ask'),
      run: async () => {
        await runVisibilityCheck();
        const s = visibilitySummary();
        return s ? `named in ${s.overall.mentioned} of ${s.overall.answered} answers ($${s.cost.toFixed(3)})` : 'done';
      },
    },
    {
      id: 'keyword-data',
      label: 'Get monthly searches and difficulty, and what competitors rank for',
      group: 'paid',
      note: 'DataForSEO, about $0.03 per competitor. Runs on the 1st of each month.',
      cron: '13 8 1 * *',
      costsMoney: true,
      needs: () => (!serpCreds() ? 'DataForSEO connected' : listTracked().length || listCompetitors().some((c) => c.url) ? null : 'a tracked search or a competitor website'),
      run: async () => {
        const m = listTracked().length ? await keywordMetrics(listTracked().map((t) => t.keyword)) : { cost: 0 };
        if (!listCompetitors().some((c) => c.url)) return `search numbers updated for $${m.cost.toFixed(3)}; no competitor websites to check`;
        const r = await refreshCompetitorKeywords();
        if (r.failed) throw new Error(`checked ${r.checked} competitor(s), then stopped: ${r.failed}`);
        return `${r.keywords} competitor search(es) from ${r.checked} competitor(s), $${(m.cost + r.cost).toFixed(3)} in all`;
      },
    },
    ...AGENTS.map<TaskDef>((a, i) => ({
      id: `agent:${a.id}`,
      label: `${a.label} agent`,
      group: 'agents',
      note: a.description,
      cron: agentCron(i),
      costsMoney: true,
      perRun: true,
      needs: () => noAi() ?? (profileComplete() ? null : 'the business profile finished'),
      run: async (progress) => {
        const n = await runAgent(a.id, taskSetting(`agent:${a.id}`).limit ?? 1, progress);
        return `wrote ${n} draft(s)`;
      },
    })),
  ];
}

export function taskSetting(id: string): TaskSetting {
  const def = taskDefs().find((t) => t.id === id);
  // Plumbing can't be switched off or retimed: a stray click would quietly stop publishing.
  if (def?.system) return { enabled: true, cron: def.cron };
  const saved: Partial<TaskSetting> | undefined = getSetting<Record<string, Partial<TaskSetting>>>('tasks', {})[id];
  return { enabled: !def?.costsMoney && !def?.offByDefault, cron: def?.cron ?? '', ...(def?.perRun ? { limit: 1 } : {}), ...saved };
}

export function updateTask(id: string, patch: Partial<TaskSetting>): TaskSetting {
  const def = taskDefs().find((t) => t.id === id);
  if (!def) throw new Error(`no task ${id}`);
  if (def.system) throw new Error(`"${def.label}" always runs and can't be changed`);
  if (patch.cron !== undefined && !cron.validate(patch.cron)) throw new Error(`"${patch.cron}" is not a valid timetable`);
  if (patch.limit !== undefined && !def.perRun) throw new Error(`"${def.label}" has no drafts per run`);
  if (patch.limit !== undefined && !(Number.isInteger(patch.limit) && patch.limit >= 1 && patch.limit <= 10)) throw new Error('drafts per run must be 1–10');
  const all = getSetting<Record<string, TaskSetting>>('tasks', {});
  all[id] = { ...taskSetting(id), ...patch };
  setSetting('tasks', all);
  reschedule();
  return all[id];
}

/** Running tasks, as "site|task": the same task may run for two sites at once, but never twice for one. */
const running = new Set<string>();
const runKey = (id: string) => `${currentSite()}|${id}`;

/**
 * Run one task now: never twice at once, always recorded, errors logged rather than thrown.
 * A task that isn't ready (no site, nothing to check) is skipped and leaves no record, so the
 * log isn't filled with "skipped" every day.
 */
export async function runTask(id: string): Promise<{ status: 'done' | 'failed' | 'skipped'; message: string }> {
  const def = taskDefs().find((t) => t.id === id);
  if (!def) throw new Error(`no task ${id}`);
  const missing = def.needs?.();
  if (missing) return { status: 'skipped', message: `needs ${missing}` };
  const key = runKey(id);
  // Agents also run from the Run button and the chat; those runs hold an "agent:<id>" job, so check that too.
  if (running.has(key) || (id.startsWith('agent:') && runningJob(id))) return { status: 'skipped', message: 'already running' };
  running.add(key);
  let jobId: number | null = null;
  let runId: number | null = null;
  const end = (status: 'done' | 'failed' | 'skipped', message: string) => {
    if (runId) getDb().prepare('UPDATE task_runs SET status = ?, message = ?, finished_at = ? WHERE id = ?').run(status, message, new Date().toISOString(), runId);
    if (jobId) finishJob(jobId, status === 'failed' ? message : undefined);
    return { status, message };
  };
  try {
    // Plumbing runs often: no job card or run row each time; it still logs when it did something.
    if (!def.system) {
      // Agent runs share the job name used by the Run button, so the agent's folder shows "working…".
      jobId = startJob(id.startsWith('agent:') ? id : `task:${id}`, def.label);
      runId = Number(getDb().prepare(`INSERT INTO task_runs (task, started_at, status) VALUES (?, ?, 'running')`).run(id, new Date().toISOString()).lastInsertRowid);
    }
    const msg = await def.run((m) => jobId && updateJob(jobId, m));
    if (msg) log('info', id, msg);
    return end('done', msg ?? '');
  } catch (err: any) {
    const message = String(err?.message ?? err);
    // Out of budget is expected, not a fault: say so once per run, as a warning.
    log(err instanceof BudgetExceeded ? 'warn' : 'error', id, message);
    try {
      return end(err instanceof BudgetExceeded ? 'skipped' : 'failed', message);
    } catch {
      return { status: 'failed', message };
    }
  } finally {
    running.delete(key);
  }
}

let scheduled: ScheduledTask[] = [];

export function startScheduler(): void {
  reschedule();
  log('info', 'scheduler', `started: ${scheduled.length} timed task(s) on across ${listSites().length} site(s)`);
}

/** One timer per site per switched-on task; each run happens inside its own site. */
export function reschedule(): void {
  for (const t of scheduled) t.stop();
  scheduled = [];
  for (const site of listSites()) {
    withSite(site.slug, () => {
      for (const def of taskDefs()) {
        const s = taskSetting(def.id);
        if (!s.enabled) continue;
        const tick = () => withSite(site.slug, () => runTask(def.id)).catch((err) => log('error', def.id, String(err?.message ?? err)));
        scheduled.push(cron.schedule(s.cron, () => void tick(), { name: `${site.slug}|${def.id}` }));
      }
    });
  }
}

export function stopScheduler(): void {
  for (const t of scheduled) t.stop();
  scheduled = [];
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** A timetable in plain words ("weekdays at 07:13"), or null when it is too unusual to say simply. */
export function describeCron(expr: string): string | null {
  const m = expr.trim().split(/\s+/);
  if (m.join(' ') === '* * * * *') return 'every minute';
  if (m.length !== 5 || !/^\d+$/.test(m[0]) || m[3] !== '*') return null;
  if (m[1] === '*' && m[2] === '*' && m[4] === '*') return `every hour at :${m[0].padStart(2, '0')}`;
  if (!/^\d+$/.test(m[1])) return null;
  const at = `at ${m[1].padStart(2, '0')}:${m[0].padStart(2, '0')}`;
  const [dom, dow] = [m[2], m[4]];
  if (dom === '*' && dow === '*') return `every day ${at}`;
  if (dom === '*' && dow === '1-5') return `weekdays ${at}`;
  if (dom === '*' && /^[0-7]$/.test(dow)) return `every ${DAYS[Number(dow) % 7]} ${at}`;
  if (/^\d+$/.test(dom) && dow === '*') return `on day ${dom} of each month ${at}`;
  return null;
}

/** For the Timetable page: each task the owner can change, its timetable, next run, and last result. Plumbing is left out. */
export function taskOverview() {
  const lastRun = getDb().prepare('SELECT started_at, finished_at, status, message FROM task_runs WHERE task = ? ORDER BY id DESC LIMIT 1');
  return taskDefs()
    .filter((d) => !d.system)
    .map((d) => {
      const s = taskSetting(d.id);
      const next = s.enabled ? scheduled.find((t) => (t as any).name === runKey(d.id))?.getNextRun() ?? null : null;
      const isRunning = running.has(runKey(d.id)) || (d.id.startsWith('agent:') && !!runningJob(d.id));
      return {
        id: d.id,
        label: d.label,
        group: d.group,
        note: d.note ?? null,
        costsMoney: d.costsMoney,
        perRun: !!d.perRun,
        ...s,
        when: describeCron(s.cron),
        needs: d.needs?.() ?? null,
        running: isRunning,
        next: next?.toISOString() ?? null,
        last: lastRun.get(d.id) ?? null,
      };
    });
}
