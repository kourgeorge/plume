import { MODELS } from '../config';
import { getDb } from '../db';
import { agentSystem } from '../context/profile';
import { askJson } from '../llm/client';
import { createDraft, usedKeywords } from '../queue';
import { topQueries } from '../analytics/results';
import type { Agent, Opportunity } from './types';

const SEO_ROLE = `You are the SEO lead. You find search terms real buyers type that this business could rank for,
and you write pages that deserve to rank: they answer the question fully, in the brand voice, with no filler.
Prefer specific, lower-competition terms over broad ones a small site can't win.`;

const OPP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['opportunities'],
  properties: {
    opportunities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['keyword', 'title', 'kind', 'intent', 'reason'],
        properties: {
          keyword: { type: 'string' },
          title: { type: 'string' },
          kind: { type: 'string', enum: ['blog_post', 'landing_page'] },
          intent: { type: 'string', enum: ['informational', 'commercial', 'transactional'] },
          reason: { type: 'string', description: 'One or two sentences: why this term, and why we can win it.' },
        },
      },
    },
  },
};

export const ARTICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'slug', 'metaDescription', 'body'],
  properties: {
    title: { type: 'string', description: 'Under 60 characters, main keyword near the start.' },
    slug: { type: 'string', description: 'lowercase-words-with-dashes' },
    metaDescription: { type: 'string', description: '120 to 155 characters.' },
    body: { type: 'string', description: 'The full article in Markdown, starting with "# " + title.' },
  },
};

/** Keep only opportunities whose keyword hasn't been covered — by an earlier draft or by an existing page title. */
export function filterNew(opps: Opportunity[], used: Set<string>, existingTitles: string[]): Opportunity[] {
  const titles = existingTitles.map((t) => t.toLowerCase());
  const seen = new Set<string>();
  return opps.filter((o) => {
    const k = (o.keyword ?? '').toLowerCase().trim();
    if (!k || used.has(k) || seen.has(k) || titles.some((t) => t.includes(k))) return false;
    seen.add(k);
    return true;
  });
}

/** Search-console style opportunities: shown often, but ranked on page 2–3. Filled in by step 3 (analytics). */
export function searchConsoleGaps(rows: { query: string; impressions: number; position: number }[], minImpressions = 50): Opportunity[] {
  return rows
    .filter((r) => r.impressions >= minImpressions && r.position >= 8 && r.position <= 30)
    .sort((a, b) => b.impressions - a.impressions)
    .map((r) => ({
      keyword: r.query,
      title: r.query,
      kind: 'blog_post',
      reason: `Google already shows you for "${r.query}" (${r.impressions} times, average position ${r.position.toFixed(1)}). A focused page could move it onto page one.`,
      source: 'search-console',
      impressions: r.impressions,
      position: r.position,
    }));
}

/**
 * How to write so AI assistants (ChatGPT, Claude, Perplexity, Google's AI answers) can quote the page.
 * They lift single passages, not whole articles, so each section has to stand on its own.
 * Written as instructions rather than checked by word patterns, so it works in any language.
 */
export const QUOTABLE_RULES = `Write so that both people and AI assistants can quote you:
- Start with the answer. The first two or three sentences under the title say plainly what the reader came to find out; the rest explains.
- Use headings phrased the way people ask (for example "How long does it take to pass the theory test?"), and answer each one in the first sentence under it.
- Make each section stand on its own, about 130–170 words: name the subject instead of saying "it" or "this", so a passage quoted alone still makes sense.
- Be specific. Give numbers, prices, steps, times and names, and say where a fact comes from ("according to the Ministry of Transport…"). Never invent a figure or a source; leave a claim out rather than guess.
- Show first-hand experience where the profile supports it: what the business sees with its own customers, a real example, a common mistake.
- Use a numbered list for steps and a table for comparisons.
- End with a short summary of the key points.`;

function sitePages(): { url: string; title: string }[] {
  return getDb().prepare('SELECT url, title FROM pages WHERE status < 400').all() as { url: string; title: string }[];
}

export async function writeArticle(agent: string, opp: Opportunity, role: string, extra = '') {
  const pages = sitePages();
  const art = await askJson<{ title: string; slug: string; metaDescription: string; body: string }>({
    purpose: `${agent}:draft`,
    model: MODELS.draft,
    effort: 'high',
    maxTokens: 32000,
    webSearches: 4,
    system: agentSystem(role, undefined, undefined, agent),
    schema: ARTICLE_SCHEMA,
    prompt:
      `Write a ${opp.kind === 'landing_page' ? 'landing page' : 'blog post'} targeting "${opp.keyword ?? opp.title}".\n` +
      `Working title: ${opp.title}\nWhy: ${opp.reason}\n${extra}\n` +
      `${QUOTABLE_RULES}\n\n` +
      `Link to 2–4 of our own pages where it genuinely helps the reader (use these exact URLs):\n` +
      pages.map((p) => `- ${p.title}: ${p.url}`).join('\n') +
      `\nCheck facts about the topic with web search. Use only claims about our product that the profile supports.`,
  });
  return createDraft({
    agent,
    kind: opp.kind,
    title: art.title,
    body: art.body,
    meta: { slug: art.slug, metaDescription: art.metaDescription, keyword: opp.keyword, reason: opp.reason, sources: art._sources },
  });
}

export const seoAgent: Agent = {
  id: 'seo',
  label: 'SEO',
  description: 'Finds search terms you can win and drafts posts and landing pages for them. Also runs the daily site check.',
  async findOpportunities({ limit = 3, onProgress }) {
    // Real data first: terms Google already shows us for, just not on page one.
    const fromData = filterNew(searchConsoleGaps(topQueries(500)), usedKeywords(), sitePages().map((p) => p.title));
    if (fromData.length >= limit) return fromData.slice(0, limit);
    onProgress?.('Looking for search terms you could rank for');
    const res = await askJson<{ opportunities: Opportunity[] }>({
      purpose: 'seo:opportunities',
      model: MODELS.research,
      effort: 'high',
      webSearches: 10,
      system: agentSystem(SEO_ROLE, undefined, undefined, 'seo'),
      schema: OPP_SCHEMA,
      prompt:
        `Find ${limit * 3} keyword opportunities. Look at what competitors rank for that we have no page about, ` +
        `and at questions buyers ask before buying. Our existing pages:\n` +
        sitePages().map((p) => `- ${p.title} (${p.url})`).join('\n'),
    });
    const used = new Set([...usedKeywords(), ...fromData.map((o) => o.keyword!.toLowerCase())]);
    return [...fromData, ...filterNew(res.opportunities, used, sitePages().map((p) => p.title))].slice(0, limit);
  },
  draft: (opp) => writeArticle('seo', opp, SEO_ROLE),
};
