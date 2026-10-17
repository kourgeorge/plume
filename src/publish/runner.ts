import { dueDrafts, getDraft, listDrafts, moveDraft, Draft } from '../queue';
import { getPublisher, publishDraft } from './index';
import { siteEnv } from '../integrations';
import { emailDailyLimit, emailsSentToday } from '../outreach/email';

let busy = false;

/** Publish one approved draft to its target. Failures land in the inbox with the reason, never thrown away. */
export async function publishOne(id: number, env: NodeJS.ProcessEnv = siteEnv()): Promise<Draft> {
  const d = getDraft(id);
  if (!d) throw new Error(`no draft ${id}`);
  if (d.status !== 'approved') throw new Error(`draft ${id} is ${d.status}, not approved`);
  try {
    const r = await publishDraft(d, d.target ?? 'export', env);
    return moveDraft(id, 'published', {
      publishedUrl: r.url ?? undefined,
      externalId: r.externalId ?? undefined,
      dryRun: r.dryRun,
      note: r.dryRun ? `dry run: ${d.target} has no credentials; saved files instead` : `published to ${d.target}`,
    });
  } catch (err: any) {
    return moveDraft(id, 'failed', { error: String(err?.message ?? err) });
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
 * Approved Reddit posts and outreach emails over their daily limits stay approved and go out on a later
 * day — they don't fail. Dry runs (no credentials) don't count against the limits.
 */
export async function publishDue(env: NodeJS.ProcessEnv = siteEnv(), now = new Date()): Promise<number> {
  if (busy) return 0;
  busy = true;
  try {
    const left: Record<string, number> = {
      reddit: redditDailyLimit(env) - redditPostedToday(now),
      email: emailDailyLimit(env) - emailsSentToday(now),
    };
    let sent = 0;
    for (const d of dueDrafts(now)) {
      const capped = d.target && d.target in left && getPublisher(d.target)!.configured(env) ? d.target : null;
      if (capped && left[capped] <= 0) continue;
      const after = await publishOne(d.id, env);
      if (capped && after.status === 'published') left[capped]--;
      sent++;
    }
    return sent;
  } finally {
    busy = false;
  }
}
