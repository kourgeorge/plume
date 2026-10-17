import fs from 'fs';
import path from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import { profileDir } from '../site';
import { performanceNotes } from '../analytics/results';
import { languageRule } from './language';
import { feedbackNote } from '../feedback';
import { extraContext } from './extra';
import { instructionsNote } from '../agents/instructions';

/**
 * The documents every agent reads before writing anything. Order is fixed so the cached prefix stays stable,
 * and research writes them in this order, so later ones build on earlier ones.
 * `core` ones must exist before agents run; the others came later, so sites researched before them still work.
 */
export const PROFILE_DOCS = [
  { id: 'product', core: true, title: 'Product', brief: 'Overview, who it is for, the problems it solves, key features, pricing, proof points, the main action the site asks visitors to take, and a "Tech signals" section (what the site is built with and connected to).' },
  { id: 'strategy', core: true, title: 'Marketing strategy', brief: 'Positioning, ideal customer profiles, the main channels to win on and why, 90-day goals.' },
  { id: 'competitors', core: true, title: 'Competitors', brief: 'Main competitors, how each positions itself, their strengths and gaps, where we can win.' },
  { id: 'voice', core: true, title: 'Brand voice', brief: 'Tone, vocabulary to use and avoid, sentence style, examples of on-brand and off-brand lines.' },
  { id: 'design', core: false, title: 'Design guide', brief: 'The look of the brand, for anyone making images, social graphics or pages: the colour palette (with hex codes and what each colour is for), fonts for headings and body text, logo use, the style of photos and illustrations, layout habits (spacing, buttons, corners), and do and don\'t examples. Use only the colours and fonts detected on the site; when you suggest something the site does not already use, mark it "(suggestion)".' },
  { id: 'content-strategy', core: false, title: 'Content strategy', brief: 'Why the business publishes and what it should achieve: goals and how to measure them, the audiences and what each needs at each stage (finding us, comparing, buying, staying), the topics we have the right to own, how content leads to the main action, which channels carry which kind of content, how often to publish, and what we will not write about. This is the "why and what"; the content plan that follows is the "when".' },
  { id: 'content-plan', core: true, title: 'Content plan', brief: 'Content pillars, priority topics and keywords, formats per channel, a first month of ideas. Follow the content strategy.' },
] as const;

export type ProfileDocId = (typeof PROFILE_DOCS)[number]['id'];

export function isProfileDocId(id: string): id is ProfileDocId {
  return PROFILE_DOCS.some((d) => d.id === id);
}

export function docPath(id: ProfileDocId, dir = profileDir()): string {
  return path.join(dir, `${id}.md`);
}

export function readDoc(id: ProfileDocId, dir = profileDir()): string | null {
  const p = docPath(id, dir);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

export function writeDoc(id: ProfileDocId, body: string, dir = profileDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(docPath(id, dir), body.endsWith('\n') ? body : body + '\n');
}

/** When the document was last saved (by research or by the user), or null if it doesn't exist. */
export function docWrittenAt(id: ProfileDocId, dir = profileDir()): string | null {
  try {
    return fs.statSync(docPath(id, dir)).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Ready for agents: every core document exists. The newer documents are read when present but never block. */
export function profileComplete(dir = profileDir()): boolean {
  return PROFILE_DOCS.every((d) => !d.core || readDoc(d.id, dir) !== null);
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
 * System-prompt blocks for any agent: its own role first, then all the docs in one cached block.
 * Docs are never shortened — an agent working from a clipped voice guide drifts off-brand.
 */
export function agentSystem(
  role: string,
  dir = profileDir(),
  notes: string | null = safeNotes(),
  /** When given, the agent also sees drafts the user recently turned down. */
  agent?: string,
): Anthropic.Beta.BetaTextBlockParam[] {
  const rejected = agent ? feedbackNote(agent) : null;
  const standing = agent ? instructionsNote(agent) : null;
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
    { type: 'text', text: [role, languageRule(), standing, rejected].filter(Boolean).join('\n\n') },
  ];
}
