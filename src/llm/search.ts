import * as cheerio from 'cheerio';
import type Anthropic from '@anthropic-ai/sdk';
import { fetchPublic } from '../research/safeUrl';

/**
 * Web search that Plume runs itself, for gateways that don't forward Anthropic's server-side
 * search (they either reject it or, worse, silently drop it and the model answers from memory).
 */
export const LOCAL_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs and short extracts. Use read_page to read a result in full.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: { query: { type: 'string', description: 'What to search for' } },
    },
  },
  {
    name: 'read_page',
    description: 'Read the text of a web page (for example a competitor page found with web_search).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', description: 'Full http(s) URL' } },
    },
  },
];

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export function localSearchAvailable(env = process.env): boolean {
  return !!env.TAVILY_API_KEY;
}

export async function tavilySearch(query: string, env = process.env, limit = 6): Promise<SearchHit[]> {
  const res = await fetch(env.TAVILY_API_URL ?? 'https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query, max_results: limit, search_depth: 'basic' }),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`search failed (${res.status}): ${data.detail ?? data.error ?? res.statusText}`);
  return (data.results ?? []).slice(0, limit).map((r: any) => ({ title: r.title ?? '', url: r.url, snippet: r.content ?? '' }));
}

const PAGE_LIMIT = 30_000;

export async function readPage(url: string): Promise<string> {
  // Never let a model-chosen URL (or a redirect from it) reach this machine or the local network.
  const res = await fetchPublic(url, { headers: { 'user-agent': 'PlumeBot/0.1 (+local marketing assistant)' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`page returned ${res.status}`);
  const $ = cheerio.load(await res.text());
  $('script, style, noscript, svg').remove();
  const text = `${$('title').text().trim()}\n\n${$('body').text().replace(/\s+/g, ' ').trim()}`;
  return text.length > PAGE_LIMIT ? `${text.slice(0, PAGE_LIMIT)}\n\n(page cut at ${PAGE_LIMIT.toLocaleString()} characters)` : text;
}

/** Run one tool call from the model. Errors go back to the model as text, so it can try something else. */
export async function runLocalTool(name: string, input: any, sources: string[], env = process.env): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === 'web_search') {
      const hits = await tavilySearch(String(input?.query ?? ''), env);
      for (const h of hits) if (!sources.includes(h.url)) sources.push(h.url);
      return { content: JSON.stringify(hits), isError: false };
    }
    if (name === 'read_page') {
      const url = String(input?.url ?? '');
      const text = await readPage(url);
      if (!sources.includes(url)) sources.push(url);
      return { content: text, isError: false };
    }
    return { content: `unknown tool ${name}`, isError: true };
  } catch (err: any) {
    return { content: String(err?.message ?? err), isError: true };
  }
}
