import type { Draft } from '../queue';

/** Something worth writing, found by an agent, before any words are written. */
export interface Opportunity {
  title: string;
  keyword?: string;
  /** Why it's worth doing — shown to the user next to the draft. */
  reason: string;
  kind: string;
  [k: string]: unknown;
}

export interface AgentRunOptions {
  /** How many drafts to write this run. */
  limit?: number;
  onProgress?: (msg: string) => void;
}

export interface Agent {
  id: string;
  label: string;
  /** One line for the agents page. */
  description: string;
  findOpportunities(opts: AgentRunOptions): Promise<Opportunity[]>;
  /** Null when, on a closer look, there is nothing worth writing (e.g. a Reddit thread we can't help with). */
  draft(opp: Opportunity): Promise<Draft | null>;
}
