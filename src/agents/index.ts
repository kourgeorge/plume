import { finishJob, startJob, updateJob } from '../jobs';
import { profileComplete } from '../context/profile';
import { seoAgent } from './seo';
import { writerAgent } from './writer';
import type { Agent } from './types';

export const AGENTS: Agent[] = [seoAgent, writerAgent];

export function getAgent(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Find opportunities, then draft each one. Resolves with how many drafts were written. */
export async function runAgent(id: string, limit?: number, onProgress: (m: string) => void = () => {}): Promise<number> {
  const agent = getAgent(id);
  if (!agent) throw new Error(`no agent ${id}`);
  if (!profileComplete()) throw new Error('finish the business profile first — every agent works from it');
  const opps = await agent.findOpportunities({ limit, onProgress: (m) => onProgress(`${agent.label}: ${m}`) });
  for (const [i, opp] of opps.entries()) {
    onProgress(`${agent.label}: writing ${i + 1} of ${opps.length} — ${opp.title}`);
    await agent.draft(opp);
  }
  return opps.length;
}

/** Same, in the background for the web UI; returns the job id. Setup problems are reported at once. */
export function startAgentRun(id: string, limit?: number): number {
  const agent = getAgent(id);
  if (!agent) throw new Error(`no agent ${id}`);
  if (!profileComplete()) throw new Error('finish the business profile first — every agent works from it');
  const jobId = startJob(`agent:${id}`, `${agent.label}: starting`);
  runAgent(id, limit, (m) => updateJob(jobId, m))
    .then(() => finishJob(jobId))
    .catch((err) => finishJob(jobId, String(err?.message ?? err)));
  return jobId;
}
