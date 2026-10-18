import { finishJob, runningJob, startJob, updateJob } from '../jobs';
import { profileComplete } from '../context/profile';
import { seoAgent } from './seo';
import { writerAgent } from './writer';
import { redditAgent, socialAgent } from '../social/agents';
import { influencerAgent } from '../outreach/creators';
import { linksAgent } from '../outreach/links';
import { videoAgent } from '../video/agent';
import { log } from '../log';
import type { Agent } from './types';

export const AGENTS: Agent[] = [seoAgent, writerAgent, socialAgent, redditAgent, influencerAgent, linksAgent, videoAgent];

export function getAgent(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Find opportunities, then draft each one. Resolves with how many drafts were written. */
export async function runAgent(id: string, limit?: number, onProgress: (m: string) => void = () => {}): Promise<number> {
  const agent = getAgent(id);
  if (!agent) throw new Error(`no agent ${id}`);
  if (!profileComplete()) throw new Error('finish the business profile first — every agent works from it');
  const opps = await agent.findOpportunities({ limit, onProgress: (m) => onProgress(`${agent.label}: ${m}`) });
  // One draft going wrong shouldn't throw away the others; the run fails only if none were written.
  let written = 0;
  let lastError: unknown = null;
  for (const [i, opp] of opps.entries()) {
    onProgress(`${agent.label}: writing ${i + 1} of ${opps.length} — ${opp.title}`);
    try {
      if (await agent.draft(opp)) written++;
    } catch (err: any) {
      lastError = err;
      log('error', id, `couldn't write "${opp.title}": ${String(err?.message ?? err)}`);
    }
  }
  if (!written && lastError) throw lastError;
  return written;
}

/**
 * Same, in the background for the web UI; returns the job id. Setup problems are reported at once.
 * Different agents run side by side; the same agent twice at once would draft the same ideas, so a
 * second start just returns the run already going.
 */
export function startAgentRun(id: string, limit?: number): number {
  const agent = getAgent(id);
  if (!agent) throw new Error(`no agent ${id}`);
  if (!profileComplete()) throw new Error('finish the business profile first — every agent works from it');
  const already = runningJob(`agent:${id}`);
  if (already) return already.id;
  const jobId = startJob(`agent:${id}`, `${agent.label}: starting`);
  runAgent(id, limit, (m) => updateJob(jobId, m))
    .then(() => finishJob(jobId))
    .catch((err) => finishJob(jobId, String(err?.message ?? err)));
  return jobId;
}

/** Start several agents at once, each in its own background job. Returns the job id for each agent started. */
export function startAgentRuns(ids: string[] = AGENTS.map((a) => a.id)): { id: string; jobId: number }[] {
  if (!profileComplete()) throw new Error('finish the business profile first — every agent works from it');
  return ids.filter((id) => getAgent(id)).map((id) => ({ id, jobId: startAgentRun(id) }));
}
