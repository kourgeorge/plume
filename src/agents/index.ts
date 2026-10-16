import { finishJob, startJob, updateJob } from '../jobs';
import { profileComplete } from '../context/profile';
import { seoAgent } from './seo';
import { writerAgent } from './writer';
import type { Agent } from './types';

export const AGENTS: Agent[] = [seoAgent, writerAgent];

export function getAgent(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}

/** Find opportunities, then draft each one. Runs in the background; returns the job id. */
export function startAgentRun(id: string, limit?: number): number {
  const agent = getAgent(id);
  if (!agent) throw new Error(`no agent ${id}`);
  if (!profileComplete()) throw new Error('finish the business profile first — every agent works from it');
  const jobId = startJob(`agent:${id}`, `${agent.label}: starting`);
  (async () => {
    const opps = await agent.findOpportunities({ limit, onProgress: (m) => updateJob(jobId, `${agent.label}: ${m}`) });
    if (!opps.length) return finishJob(jobId);
    for (const [i, opp] of opps.entries()) {
      updateJob(jobId, `${agent.label}: writing ${i + 1} of ${opps.length} — ${opp.title}`);
      await agent.draft(opp);
    }
    finishJob(jobId);
  })().catch((err) => finishJob(jobId, String(err?.message ?? err)));
  return jobId;
}
