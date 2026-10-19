import { MODELS } from '../config';
import { agentSystem } from '../context/profile';
import { askJson, searchMode } from '../llm/client';
import { localSearchAvailable, tavilySearch } from '../llm/search';
import { log } from '../log';
import { extractPage } from '../research/crawl';
import { fetchHttp } from '../research/fetchPage';
import { siteUrl } from '../sites';
import { SerpResult, checkSerp, latestSerp, serpCreds } from './serp';

/**
 * A short plan written before an article: what kind of page Google shows for the search, what the pages already
 * on top cover, and what they all miss. The writer gets it in its prompt, so the draft fills the gap instead of
 * repeating the top results. Works without DataForSEO: a plain web search finds the pages instead.
 * Method from claude-seo's content-brief skill (MIT).
 */

export interface Competitor {
  url: string;
  position: number;
  title: string;
  words: number;
  headings: string[];
}

export interface Brief {
  keyword: string;
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  /** What Google shows on top, e.g. "step-by-step guides" or "comparison lists". */
  pageType: string;
  /** Word count to aim for: about what the top pages have, not more for its own sake. */
  targetWords: number;
  covered: string[];
  gaps: string[];
  outline: string[];
  angle: string;
  competitors: Competitor[];
  /** Where the competitor list came from, so the draft can say how solid the plan is. */
  from: ResultsFrom;
}

/** Sites that rank for everything and aren't a business's real competition. */
const NOT_COMPETITORS = [
  'wikipedia.org', 'youtube.com', 'reddit.com', 'quora.com', 'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com',
  'pinterest.com', 'tiktok.com', 'medium.com', 'amazon.', 'ebay.', 'etsy.com', 'yelp.com', 'tripadvisor.', 'trustpilot.com',
  'google.com', 'bing.com', 'yahoo.com', 'britannica.com', 'dictionary.com', 'merriam-webster.com', 'indeed.com', 'glassdoor.',
];

export function isCompetitor(r: { url: string; domain: string }, ownSite: string | null): boolean {
  const d = r.domain.toLowerCase().replace(/^www\./, '');
  if (ownSite && d === new URL(ownSite).hostname.replace(/^www\./, '')) return false;
  if (NOT_COMPETITORS.some((x) => (x.endsWith('.') ? d.startsWith(x) || d.includes(`.${x}`) : d === x || d.endsWith(`.${x}`)))) return false;
  if (/\.(gov|edu|mil)(\.[a-z]{2})?$|\.gov\.|\.ac\.[a-z]{2}$/.test(d)) return false;
  return true;
}

export type ResultsFrom = 'google' | 'web-search' | 'none';

const FIND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'title'],
        properties: { url: { type: 'string' }, title: { type: 'string' } },
      },
    },
  },
};

const asResults = (hits: { url: string; title: string }[]): SerpResult[] =>
  hits
    .filter((h) => /^https?:\/\//.test(h.url))
    .map((h, i) => ({ position: i + 1, url: h.url, domain: new URL(h.url).hostname, title: h.title }));

/**
 * The pages on top for the search, from the best source this setup has:
 * 1. Google's own results through DataForSEO (a saved lookup up to a month old, or a new one);
 * 2. otherwise a web search: Tavily directly (no AI cost), or the AI's own search tool;
 * 3. nothing, when there is no way to search — the plan is then written without competitors.
 * A source that fails falls through to the next, so a DataForSEO account out of money doesn't stop the plan.
 */
export async function topResults(keyword: string, agent = 'seo', env = process.env): Promise<{ results: SerpResult[]; from: ResultsFrom }> {
  const saved = latestSerp(keyword);
  if (saved && Date.now() - new Date(saved.at).getTime() < 31 * 86400e3) return { results: saved.results, from: 'google' };
  if (serpCreds()) {
    try {
      return { results: (await checkSerp(keyword)).results, from: 'google' };
    } catch (err: any) {
      log('warn', 'brief', `couldn't look up Google results for "${keyword}", using web search instead: ${err?.message ?? err}`);
    }
  }
  try {
    if (localSearchAvailable(env)) {
      const results = asResults(await tavilySearch(keyword, env, 10));
      if (results.length) return { results, from: 'web-search' };
    } else if (searchMode(env) === 'server') {
      const found = await askJson<{ results: { url: string; title: string }[] }>({
        purpose: `${agent}:brief-search`,
        model: MODELS.score,
        effort: 'low',
        maxTokens: 2000,
        webSearches: 2,
        system: 'You find web pages. Report only addresses the search actually returned; never make one up.',
        schema: FIND_SCHEMA,
        prompt: `Search the web for "${keyword}" and list the top 8 results in the order the search returned them (address and page title). Leave out ads.`,
      });
      // Only addresses the search really returned: a made-up one would be read as a competitor.
      const real = new Set(found._sources);
      const results = asResults(found.results.filter((r) => real.has(r.url)));
      if (results.length) return { results, from: 'web-search' };
    }
  } catch (err: any) {
    log('warn', 'brief', `web search for "${keyword}" failed, planning without competitors: ${err?.message ?? err}`);
  }
  return { results: [], from: 'none' };
}

/** Open the top competitor pages (free: plain page reads) and keep their headings and length. */
export async function readCompetitors(results: SerpResult[], max = 4, fetchFn: typeof fetch = fetch): Promise<Competitor[]> {
  const picks = results.filter((r) => isCompetitor(r, siteUrl())).slice(0, max);
  const read = await Promise.all(
    picks.map(async (r) => {
      const f = await fetchHttp(r.url, fetchFn);
      if (!f.ok) return null;
      const { page } = extractPage(f.url, f.status, f.html);
      return { url: r.url, position: r.position, title: page.title || r.title, words: page.wordCount, headings: page.headings.filter((h) => h.level <= 3).map((h) => `${'  '.repeat(h.level - 1)}${h.text}`).slice(0, 30) };
    }),
  );
  return read.filter((c): c is Competitor => !!c && c.words > 100);
}

const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'pageType', 'targetWords', 'covered', 'gaps', 'outline', 'angle'],
  properties: {
    intent: { type: 'string', enum: ['informational', 'commercial', 'transactional', 'navigational'] },
    pageType: { type: 'string', description: 'The kind of page Google rewards for this search, e.g. "step-by-step guide", "comparison list", "service page with prices".' },
    targetWords: { type: 'integer', description: 'About the length of the top pages. Never more than needed.' },
    covered: { type: 'array', items: { type: 'string' }, description: 'What every top page covers, so ours must too. Short phrases.' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'What the top pages miss, cover thinly or get out of date, and this business can add from what it knows.' },
    outline: { type: 'array', items: { type: 'string' }, description: 'Section headings for our page, in order, phrased the way people ask.' },
    angle: { type: 'string', description: 'One or two sentences: what makes our page more useful than the ones on top.' },
  },
};

/**
 * Plan the article. Without Google results (no DataForSEO login, nothing saved) the AI looks at the search
 * itself with a few web searches. Returns null when planning fails, so the writer can still go ahead.
 */
export async function writeBrief(agent: string, keyword: string, kind: string): Promise<Brief | null> {
  try {
    const top = await topResults(keyword, agent);
    const competitors = await readCompetitors(top.results);
    const from: ResultsFrom = competitors.length ? top.from : 'none';
    const seen = competitors.length
      ? `The pages ${from === 'google' ? 'Google ranks' : 'a web search shows'} on top for "${keyword}" right now (read just now):\n` +
        competitors.map((c) => `#${c.position} ${c.title} — ${c.url} — ${c.words} words\n${c.headings.join('\n')}`).join('\n\n')
      : `The pages on top for "${keyword}" couldn't be read. Plan from what this kind of search usually needs, and keep "covered" and "gaps" to what you are confident of.`;
    const b = await askJson<Omit<Brief, 'keyword' | 'competitors' | 'from'>>({
      purpose: `${agent}:brief`,
      model: MODELS.research,
      effort: 'medium',
      maxTokens: 4000,
      webSearches: 0,
      system: agentSystem('You are the SEO lead planning a page before it is written. You are concrete and brief.', undefined, undefined, agent),
      schema: BRIEF_SCHEMA,
      prompt:
        `Plan a ${kind === 'landing_page' ? 'landing page' : 'blog post'} that should rank for "${keyword}".\n\n${seen}\n\n` +
        `Say what kind of page Google rewards here: if the top results are all one type (guides, lists, product pages), ours must be that type too. ` +
        `List what they all cover, then what they miss that this business can genuinely add — first-hand experience, local detail, current prices, a clearer answer. ` +
        `Leave out gaps the business can't fill honestly from its profile.`,
    });
    return { keyword, ...b, targetWords: Math.max(300, Math.min(4000, Math.round(b.targetWords))), competitors, from };
  } catch (err: any) {
    log('warn', 'brief', `couldn't plan "${keyword}", writing without a plan: ${err?.message ?? err}`);
    return null;
  }
}

/** The brief as instructions for the writer. */
export function briefPrompt(b: Brief): string {
  return [
    b.from === 'none' ? `Plan for this page (no competitor pages could be read, so treat it as a starting point):` : `Plan for this page (from the pages ranking on top now):`,
    `- Searcher wants: ${b.intent}. Google rewards: ${b.pageType}. Aim for about ${b.targetWords} words.`,
    b.covered.length ? `- Must cover, like the top pages: ${b.covered.join('; ')}.` : '',
    b.gaps.length ? `- Where we beat them: ${b.gaps.join('; ')}.` : '',
    `- Angle: ${b.angle}`,
    b.outline.length ? `- Suggested sections:\n${b.outline.map((h) => `  - ${h}`).join('\n')}` : '',
    `Follow the plan unless the profile says otherwise. Don't copy the competitors' wording.`,
  ]
    .filter(Boolean)
    .join('\n');
}
