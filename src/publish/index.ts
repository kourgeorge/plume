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

/** Hebrew, Arabic and other right-to-left text: the page should read that way too. */
const RTL_CHARS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

/** A whole web page for one draft: title, search snippet and simple readable styling, ready to upload or paste anywhere. */
export function pageHtml(draft: Pick<Draft, 'title' | 'body' | 'meta'>): string {
  const dir = RTL_CHARS.test(draft.title + draft.body.slice(0, 400)) ? 'rtl' : 'ltr';
  const desc = draft.meta.metaDescription ? `\n<meta name="description" content="${escapeHtml(String(draft.meta.metaDescription))}">` : '';
  return `<!doctype html>
<html dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(draft.title)}</title>${desc}
<style>
  body { margin: 0; background: #fff; color: #1a1919; font: 17px/1.7 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px 80px; }
  h1, h2, h3 { line-height: 1.25; letter-spacing: -.01em; }
  h1 { font-size: 2.1em; margin: 0 0 .6em; } h2 { font-size: 1.45em; margin: 1.8em 0 .5em; } h3 { font-size: 1.15em; margin: 1.5em 0 .4em; }
  a { color: #00705f; } img { max-width: 100%; height: auto; }
  blockquote { margin: 1.2em 0; padding: .2em 1em; border-inline-start: 3px solid #d8d2c4; color: #4b4740; }
  table { border-collapse: collapse; width: 100%; margin: 1.2em 0; font-size: .92em; } th, td { border: 1px solid #e4ddcd; padding: 8px 10px; text-align: start; } th { background: #faf8f4; }
  code { background: #f3f0ec; padding: .1em .35em; border-radius: 4px; font-size: .9em; } pre { background: #f3f0ec; padding: 14px; border-radius: 8px; overflow-x: auto; } pre code { background: none; padding: 0; }
  @media (prefers-color-scheme: dark) { body { background: #161413; color: #f3efea; } a { color: #3cc4a8; } blockquote { color: #c9c2b5; border-color: #4a443e; } th { background: #201e1d; } th, td { border-color: #3d3833; } code, pre { background: #282523; } }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(draft.title)}</h1>
${toHtml(stripTitle(draft.body))}
</main>
</body>
</html>
`;
}

/** Writes HTML + Markdown to the site's exports folder. Used for Framer (no write API) and for every dry run. Download them from the draft page. */
export const exportFiles: Publisher = {
  id: 'export',
  label: 'Save as files (Framer / copy-paste)',
  needs: [],
  configured: () => true,
  async publish(draft) {
    const dir = path.join(siteDir(), 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${draft.id}-${draft.meta.slug ?? 'item'}`);
    fs.writeFileSync(`${base}.md`, draft.body);
    fs.writeFileSync(`${base}.html`, pageHtml(draft));
    // No address: a file:// link can't be opened from the dashboard, so the draft page offers downloads instead.
    return { url: null, externalId: null, dryRun: false };
  },
};

export const PUBLISHERS: Publisher[] = [wordpress, webflow, wix, sanity, hubspot, github, ...SOCIAL_PUBLISHERS, emailPublisher, exportFiles];

export function getPublisher(id: string): Publisher | undefined {
  return PUBLISHERS.find((p) => p.id === id);
}

/** Which kinds of draft each destination takes. File export takes anything. */
const SOCIAL_KINDS = ['social_post', 'x_post', 'x_thread', 'linkedin_post', 'facebook_post'];
const REDDIT_KINDS = ['reddit_reply', 'reddit_post'];
const SOCIAL_TARGETS = ['x', 'linkedin', 'facebook', 'facebook_reel', 'instagram', 'reddit', 'email'];
/** Kinds with their own short list: an outreach email goes to one person; a video script is posted as a Reel, using the video the owner filmed and uploaded. */
const PRIVATE_KINDS: Record<string, string[]> = { outreach_email: ['email', 'export'], outreach_message: ['export'], video_script: ['facebook_reel', 'instagram', 'export'] };
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
        ? 'a Reel'
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
