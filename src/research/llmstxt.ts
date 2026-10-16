import { getDb } from '../db';
import { siteUrl } from '../sites';
import { readDoc } from '../context/profile';

/**
 * llms.txt (llmstxt.org): a short Markdown map of the site for AI assistants.
 * Built from the pages Plume read — no AI call, so it never claims anything the site doesn't.
 */
export function buildLlmsTxt(summary?: string): string | null {
  const site = siteUrl();
  const pages = getDb()
    .prepare(`SELECT url, title, meta_description, h1 FROM pages WHERE status < 400 AND title != '' ORDER BY length(url), url`)
    .all() as { url: string; title: string; meta_description: string; h1: string }[];
  if (!site || !pages.length) return null;
  const home = pages.find((p) => new URL(p.url).pathname === '/') ?? pages[0];
  const name = home.title.split(/\s[|–—-]\s/)[0].trim() || new URL(site).hostname;
  const blurb = (summary ?? firstParagraph(readDoc('product')) ?? home.meta_description ?? '').replace(/\s+/g, ' ').trim();

  const groups = new Map<string, typeof pages>();
  for (const p of pages) {
    const seg = new URL(p.url).pathname.split('/').filter(Boolean)[0] ?? '';
    const key = seg && pages.filter((x) => new URL(x.url).pathname.startsWith(`/${seg}/`)).length >= 3 ? seg : '';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const line = (p: (typeof pages)[number]) => `- [${(p.h1 || p.title).replace(/[\[\]]/g, '')}](${p.url})${p.meta_description ? `: ${p.meta_description.replace(/\s+/g, ' ')}` : ''}`;
  const out = [`# ${name}`, ''];
  if (blurb) out.push(`> ${blurb}`, '');
  out.push('## Main pages', '', ...(groups.get('') ?? []).map(line));
  for (const [key, ps] of groups) {
    if (!key) continue;
    out.push('', `## ${key.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase())}`, '', ...ps.map(line));
  }
  return out.join('\n') + '\n';
}

function firstParagraph(md: string | null): string | null {
  if (!md) return null;
  return md.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !/^[#\-|>*]/.test(p) && p.length > 60)?.replace(/[*_`]|\[([^\]]+)\]\([^)]+\)/g, '$1') ?? null;
}
