import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import { DATA_DIR } from '../config';
import type { Draft } from '../queue';
import { wordpress } from './wordpress';
import { webflow } from './webflow';

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

/** Writes HTML + Markdown to data/exports. Used for Framer (no write API) and for every dry run. */
export const exportFiles: Publisher = {
  id: 'export',
  label: 'Save as files (Framer / copy-paste)',
  needs: [],
  configured: () => true,
  async publish(draft, html) {
    const dir = path.join(DATA_DIR, 'exports');
    fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, `${draft.id}-${draft.meta.slug ?? 'item'}`);
    fs.writeFileSync(`${base}.md`, draft.body);
    fs.writeFileSync(`${base}.html`, `<!doctype html><meta charset="utf-8"><title>${escapeHtml(draft.title)}</title>\n${html}`);
    return { url: `file://${base}.html`, externalId: null, dryRun: false };
  },
};

export const PUBLISHERS: Publisher[] = [wordpress, webflow, exportFiles];

export function getPublisher(id: string): Publisher | undefined {
  return PUBLISHERS.find((p) => p.id === id);
}

/** Publish, or — if the target has no credentials — save the files and say it was a dry run. */
export async function publishDraft(draft: Draft, targetId: string, env = process.env): Promise<PublishResult> {
  const pub = getPublisher(targetId);
  if (!pub) throw new Error(`unknown publishing target ${targetId}`);
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
