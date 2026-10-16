import fs from 'fs';
import path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { PROFILE_DIR } from '../config';
import { performanceNotes } from '../analytics/results';
import { languageRule } from './language';
import { feedbackNote } from '../feedback';
import { extraContext } from './extra';

/** The five documents every agent reads before writing anything. Order is fixed so the cached prefix stays stable. */
export const PROFILE_DOCS = [
  { id: 'product', title: 'Product', brief: 'What the product is, who it is for, the problems it solves, features, pricing, proof points.' },
  { id: 'strategy', title: 'Marketing strategy', brief: 'Positioning, ideal customer profiles, the main channels to win on and why, 90-day goals.' },
  { id: 'competitors', title: 'Competitors', brief: 'Main competitors, how each positions itself, their strengths and gaps, where we can win.' },
  { id: 'voice', title: 'Brand voice', brief: 'Tone, vocabulary to use and avoid, sentence style, examples of on-brand and off-brand lines.' },
  { id: 'content-plan', title: 'Content plan', brief: 'Content pillars, priority topics and keywords, formats per channel, a first month of ideas.' },
] as const;

export type ProfileDocId = (typeof PROFILE_DOCS)[number]['id'];

export function isProfileDocId(id: string): id is ProfileDocId {
  return PROFILE_DOCS.some((d) => d.id === id);
}

export function docPath(id: ProfileDocId, dir = PROFILE_DIR): string {
  return path.join(dir, `${id}.md`);
}

export function readDoc(id: ProfileDocId, dir = PROFILE_DIR): string | null {
  const p = docPath(id, dir);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

export function writeDoc(id: ProfileDocId, body: string, dir = PROFILE_DIR): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(docPath(id, dir), body.endsWith('\n') ? body : body + '\n');
}

export function profileComplete(dir = PROFILE_DIR): boolean {
  return PROFILE_DOCS.every((d) => readDoc(d.id, dir) !== null);
}

function safeExtra(): string | null {
  try {
    return extraContext();
  } catch {
    return null;
  }
}

/** Results notes, or none if analytics isn't set up (or its tables are empty). */
function safeNotes(): string | null {
  try {
    return performanceNotes();
  } catch {
    return null;
  }
}

/**
 * System-prompt blocks for any agent: its own role first, then all five docs in one cached block.
 * Docs are never shortened — an agent working from a clipped voice guide drifts off-brand.
 */
export function agentSystem(
  role: string,
  dir = PROFILE_DIR,
  notes: string | null = safeNotes(),
  /** When given, the agent also sees drafts the user recently turned down. */
  agent?: string,
): Anthropic.Beta.BetaTextBlockParam[] {
  const rejected = agent ? feedbackNote(agent) : null;
  const extra = safeExtra();
  const docs = PROFILE_DOCS.map((d) => `<doc id="${d.id}" title="${d.title}">\n${readDoc(d.id, dir) ?? '(not written yet)'}\n</doc>`).join('\n\n');
  return [
    {
      type: 'text',
      text:
        'Below is the business profile. Read all of it before you write anything, and keep every piece of work consistent with it — ' +
        'especially the brand voice. If the profile does not support a claim, do not make the claim.\n\n' +
        docs,
      cache_control: { type: 'ephemeral' },
    },
    // After the cached docs: these change more often, so they must not sit inside the cached prefix.
    ...(extra ? [{ type: 'text' as const, text: `<more-context>\n${extra}\n</more-context>` }] : []),
    ...(notes ? [{ type: 'text' as const, text: `<results>\n${notes}\n</results>` }] : []),
    { type: 'text', text: [role, languageRule(), rejected].filter(Boolean).join('\n\n') },
  ];
}
