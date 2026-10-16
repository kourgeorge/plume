import { getSetting, setSetting } from '../db';

/** Standing instructions per agent, set by the user for this site ("no hashtags", "always end with a question"). */
const KEY = 'agentInstructions';
export const MAX_INSTRUCTIONS = 4000;

export function agentInstructions(agent: string): string {
  return getSetting<Record<string, string>>(KEY, {})[agent] ?? '';
}

export function setAgentInstructions(agent: string, text: string): string {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length > MAX_INSTRUCTIONS) throw new Error(`keep instructions under ${MAX_INSTRUCTIONS.toLocaleString()} characters (now ${clean.length.toLocaleString()})`);
  const all = getSetting<Record<string, string>>(KEY, {});
  if (clean) all[agent] = clean;
  else delete all[agent];
  setSetting(KEY, all);
  return clean;
}

/** The note an agent's prompt gets, or null when the user set none. */
export function instructionsNote(agent: string): string | null {
  const t = agentInstructions(agent);
  return t ? `Standing instructions from the owner for your work. Follow them; they override the brand voice document where the two disagree:\n${t}` : null;
}
