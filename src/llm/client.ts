import Anthropic from '@anthropic-ai/sdk';
import { PRICES } from '../config';
import { getDb } from '../db';

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  return (client ??= new Anthropic());
}

export interface AskOptions {
  /** Short label stored with the usage row, e.g. "research:product". */
  purpose: string;
  model: string;
  system: Anthropic.Beta.BetaTextBlockParam[] | string;
  prompt: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Let the model search the web (Anthropic runs the search). 0 = off. */
  webSearches?: number;
  maxTokens?: number;
  /** JSON schema the answer must follow (structured output). Use `askJson` to get it parsed. */
  schema?: Record<string, unknown>;
}

export interface AskResult {
  text: string;
  /** URLs the model read through web search, in the order it found them. */
  sources: string[];
  stopReason: string | null;
}

/**
 * One model call. Streams (long outputs), retries on refusal via server-side fallback,
 * and records tokens and cost for every call.
 */
export async function ask(opts: AskOptions): Promise<AskResult> {
  const tools: Anthropic.Beta.BetaToolUnion[] = opts.webSearches
    ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: opts.webSearches }]
    : [];
  const fallbackOk = !opts.model.startsWith('claude-haiku');

  const stream = anthropic().beta.messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 32000,
    system: opts.system,
    messages: [{ role: 'user', content: opts.prompt }],
    output_config: {
      effort: opts.effort ?? 'medium',
      ...(opts.schema ? { format: { type: 'json_schema' as const, schema: opts.schema } } : {}),
    },
    cache_control: { type: 'ephemeral' },
    ...(tools.length ? { tools } : {}),
    ...(fallbackOk ? { fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] } : {}),
  });
  const msg = await stream.finalMessage();

  recordUsage(opts.purpose, msg);

  if (msg.stop_reason === 'refusal') {
    throw new Error(`model declined (${msg.stop_details?.category ?? 'no category'}) for ${opts.purpose}`);
  }

  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const sources: string[] = [];
  for (const block of msg.content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (!sources.includes(r.url)) sources.push(r.url);
    }
  }
  return { text, sources, stopReason: msg.stop_reason };
}

/** Like `ask`, but the answer is JSON matching `schema`, parsed. */
export async function askJson<T>(opts: AskOptions & { schema: Record<string, unknown> }): Promise<T & { _sources: string[] }> {
  const res = await ask(opts);
  if (res.stopReason === 'max_tokens') throw new Error(`answer was cut off for ${opts.purpose}; raise maxTokens`);
  return { ...(JSON.parse(res.text) as T), _sources: res.sources };
}

export function costOf(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number; searches: number }): number {
  const [inP, outP, readP] = PRICES[model] ?? PRICES['claude-opus-5-5'];
  const tokens = (u.input * inP + u.output * outP + u.cacheRead * readP + u.cacheWrite * inP * 1.25) / 1e6;
  return tokens + u.searches * 0.01; // web search is $10 per 1,000 searches
}

function recordUsage(purpose: string, msg: Anthropic.Beta.BetaMessage): void {
  const u = msg.usage;
  const row = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    searches: u.server_tool_use?.web_search_requests ?? 0,
  };
  getDb()
    .prepare(
      `INSERT INTO llm_calls (at, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, cost_usd, stop_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(new Date().toISOString(), purpose, msg.model, row.input, row.output, row.cacheRead, row.cacheWrite, row.searches, costOf(msg.model, row), msg.stop_reason);
}
