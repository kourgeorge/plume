import { dueDrafts, getDraft, listDrafts, moveDraft, Draft } from '../queue';
import { getPublisher, publishDraft } from './index';
import { siteEnv } from '../integrations';
import { recordAction } from '../actions';
import { emailDailyLimit, emailsSentToday } from '../outreach/email';
import { currentSite } from '../site';

let busy = false;
/** Drafts being published right now (site + id), so the Approve button and the minute timer never send one twice. */
const inFlight = new Set<string>();

/** How many more posts each limited target may send today, or Infinity when it has no limit (or no login, so it's a dry run). */
function leftToday(target: string | null, env: NodeJS.ProcessEnv, now: Date): number {
  if (!target || !getPublisher(target)?.configured(env)) return Infinity;
  if (target === 'reddit') return redditDailyLimit(env) - redditPostedToday(now);
  if (target === 'email') return emailDailyLimit(env) - emailsSentToday(now);
  return Infinity;
}

/**
 * Publish one approved draft to its target. Failures land in the inbox with the reason, never thrown away.
 * Reddit posts and emails over today's limit stay approved and go out on a later day.
 */
export async function publishOne(id: number, env: NodeJS.ProcessEnv = siteEnv(), now = new Date()): Promise<Draft> {
  const d = getDraft(id);
  if (!d) throw new Error(`no draft ${id}`);
  if (d.status !== 'approved') throw new Error(`draft ${id} is ${d.status}, not approved`);
  const key = `${currentSite()}:${id}`;
  if (inFlight.has(key)) throw new Error(`draft ${id} is already being published`);
  if (leftToday(d.target, env, now) <= 0) return d;
  inFlight.add(key);
  try {
    const r = await publishDraft(d, d.target ?? 'export', env);
    // Only a live page can be measured later; file exports and dry runs are not on the site.
    if (!r.dryRun && r.url?.startsWith('http')) recordAction({ kind: 'published', ref: String(id), url: r.url, title: d.title, data: { target: d.target } });
    return moveDraft(id, 'published', {
      publishedUrl: r.url ?? undefined,
      externalId: r.externalId ?? undefined,
      dryRun: r.dryRun,
      note: r.dryRun ? `dry run: ${d.target} has no credentials; saved files instead` : `published to ${d.target}`,
    });
  } catch (err: any) {
    return moveDraft(id, 'failed', { error: String(err?.message ?? err) });
  } finally {
    inFlight.delete(key);
  }
}

/** How many Reddit posts may go out per day. Subreddits ban accounts that post a lot, so the default is small. */
export function redditDailyLimit(env: NodeJS.ProcessEnv = siteEnv()): number {
  const n = Number(env.REDDIT_DAILY_LIMIT);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 2;
}

/** Reddit posts actually sent (not dry runs) since midnight UTC. */
export function redditPostedToday(now = new Date()): number {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  return listDrafts({ status: 'published' }).filter((d) => d.target === 'reddit' && !d.dryRun && d.updatedAt >= since).length;
}

/**
 * Publish everything that is approved and due. Called every minute.
 * Drafts over a daily limit stay approved (see `publishOne`); drafts already being published are skipped.
 */
export async function publishDue(env: NodeJS.ProcessEnv = siteEnv(), now = new Date()): Promise<number> {
  if (busy) return 0;
  busy = true;
  try {
    let sent = 0;
    for (const d of dueDrafts(now)) {
      // The list goes stale while we wait on each send: skip anything published, moved or started elsewhere since.
      if (inFlight.has(`${currentSite()}:${d.id}`) || getDraft(d.id)?.status !== 'approved') continue;
      const after = await publishOne(d.id, env, now);
      if (after.status !== 'approved') sent++;
    }
    return sent;
  } finally {
    busy = false;
  }
}
