import { dueDrafts, getDraft, moveDraft, Draft } from '../queue';
import { publishDraft } from './index';

let busy = false;

/** Publish one approved draft to its target. Failures land in the inbox with the reason, never thrown away. */
export async function publishOne(id: number, env = process.env): Promise<Draft> {
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

/** Publish everything that is approved and due. Called every minute. */
export async function publishDue(env = process.env): Promise<number> {
  if (busy) return 0;
  busy = true;
  try {
    const due = dueDrafts();
    for (const d of due) await publishOne(d.id, env);
    return due.length;
  } finally {
    busy = false;
  }
}
