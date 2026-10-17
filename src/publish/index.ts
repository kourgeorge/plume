import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import { siteDir } from '../site';
import { siteEnv } from '../integrations';
import type { Draft } from '../queue';
import { wordpress } from './wordpress';
import { webflow } from './webflow';
import { sanity } from './sanity';
import { wix } from './wix';
import { hubspot } from './hubspot';
import { github } from './github';
import { SOCIAL_PUBLISHERS } from '../social/publishers';
import { emailPublisher } from '../outreach/email';

export interface PublishResult {
  url: string | null;
  externalId: string | null;
  /** True when nothing left this machine because the publisher has no credentials. */
  dryRun: boolean;
}

export interface Publisher {
  id: string;
  label: string;
  /** Names of the .env variables it needs; empty list = always available. */
  needs: string[];
  configured(env?: NodeJS.ProcessEnv): boolean;
  publish(draft: Draft, html: string, env?: NodeJS.ProcessEnv): Promise<PublishResult>;
}

export function toHtml(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

/** Drop a leading "# Title" line: CMSs render the title themselves. */
export function stripTitle(markdown: string): string {
  return markdown.replace(/^\s*#\s+[^\n]*\n+/, '');
}

/** Writes HTML + Markdown to the site's exports folder. Used for Framer (no write API) and for every dry run. */
export const exportFiles: Publisher = {
  id: 'export',
  label: 'Save as files (Framer / copy-paste)',
  needs: [],
  configured: () => true,
  async publish(draft, html) {
    const dir = path.join(siteDir(), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${draft.id}-${draft.meta.slug ?? 'item'}`);
    fs.writeFileSync(`${base}.md`, draft.body);
    fs.writeFileSync(`${base}.html`, `<!doctype html><meta charset="utf-8"><title>${escapeHtml(draft.title)}</title>\n${html}`);
    return { url: `file://${base}.html`, externalId: null, dryRun: false };
  },
};

export const PUBLISHERS: Publisher[] = [wordpress, webflow, wix, sanity, hubspot, github, ...SOCIAL_PUBLISHERS, emailPublisher, exportFiles];

export function getPublisher(id: string): Publisher | undefined {
  return PUBLISHERS.find((p) => p.id === id);
}

/** Which kinds of draft each destination takes. File export takes anything. */
const SOCIAL_KINDS = ['social_post', 'x_post', 'x_thread', 'linkedin_post', 'facebook_post'];
const REDDIT_KINDS = ['reddit_reply', 'reddit_post'];
const SOCIAL_TARGETS = ['x', 'linkedin', 'facebook', 'reddit', 'email'];
/** Not for publishing anywhere: an outreach email goes to one person; a video script is filmed, not posted. */
const PRIVATE_KINDS: Record<string, string[]> = { outreach_email: ['email', 'export'], outreach_message: ['export'], video_script: ['export'] };
export function targetsFor(kind: string): string[] {
  if (PRIVATE_KINDS[kind]) return PRIVATE_KINDS[kind];
  if (REDDIT_KINDS.includes(kind)) return ['reddit', 'export'];
  if (kind === 'x_post' || kind === 'x_thread') return ['x', 'export'];
  if (kind === 'linkedin_post') return ['linkedin', 'export'];
  if (kind === 'facebook_post') return ['facebook', 'export'];
  if (kind === 'social_post') return ['x', 'linkedin', 'facebook', 'export'];
  return PUBLISHERS.map((p) => p.id).filter((id) => !SOCIAL_TARGETS.includes(id));
}

/** Refuse a destination that can't take this kind of draft (an article on X, a reply on WordPress). */
export function checkTarget(kind: string, targetId: string): void {
  if (targetsFor(kind).includes(targetId)) return;
  const label = getPublisher(targetId)?.label ?? targetId;
  const what =
    kind === 'outreach_email' || kind === 'outreach_message'
      ? 'an outreach message'
      : kind === 'video_script'
        ? 'a video script'
        : SOCIAL_KINDS.includes(kind) || REDDIT_KINDS.includes(kind)
          ? 'a social post'
          : 'an article';
  throw new Error(`${label} can't take ${what}. Pick one of: ${targetsFor(kind).map((t) => getPublisher(t)?.label ?? t).join(', ')}.`);
}

/** Publish, or — if the target has no credentials — save the files and say it was a dry run. */
export async function publishDraft(draft: Draft, targetId: string, env: NodeJS.ProcessEnv = siteEnv()): Promise<PublishResult> {
  const pub = getPublisher(targetId);
  if (!pub) throw new Error(`unknown publishing target ${targetId}`);
  checkTarget(draft.kind, targetId);
  const html = toHtml(stripTitle(draft.body));
  if (!pub.configured(env)) {
    const saved = await exportFiles.publish(draft, html, env);
    return { ...saved, dryRun: true };
  }
  return pub.publish(draft, html, env);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
