import Anthropic from '@anthropic-ai/sdk';
import { LLM, priceFor, supportsEffort } from '../config';
import { parseHeaders, viaProxy } from './settings';
import { LOCAL_TOOLS, localSearchAvailable, runLocalTool } from './search';
import { checkBudget } from './budget';
import { log } from '../log';
import { getDb } from '../db';

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Exactly one credential, from one place: the settings file when given, else the environment.
  return (client ??= new Anthropic({
    baseURL: LLM.ANTHROPIC_BASE_URL ?? null,
    apiKey: LLM.ANTHROPIC_AUTH_TOKEN ? null : (LLM.ANTHROPIC_API_KEY ?? null),
    authToken: LLM.ANTHROPIC_AUTH_TOKEN ?? null,
    defaultHeaders: parseHeaders(LLM.ANTHROPIC_CUSTOM_HEADERS),
  }));
}

/** Server-side refusal fallback is an Anthropic API feature; gateways generally don't forward it. */
const FALLBACKS = process.env.PLUME_FALLBACKS ? process.env.PLUME_FALLBACKS === '1' : !viaProxy(LLM);

export interface AskOptions {
  /** Short label stored with the usage row, e.g. "research:product". */
  purpose: string;
  model: string;
  system: Anthropic.Beta.BetaTextBlockParam[] | string;
  prompt: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Let the model search the web, up to this many searches. 0 = off. See `searchMode`. */
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

export type SearchMode = 'server' | 'local' | 'off';

/**
 * How web search works for this setup:
 * - server: Anthropic runs it (direct API only — gateways tested so far drop or break it);
 * - local: Plume runs it via Tavily and hands results to the model as tool results;
 * - off: no search; the model is told so, so it can't pass memory off as research.
 */
export function searchMode(env = process.env): SearchMode {
  const forced = env.PLUME_SEARCH as SearchMode | undefined;
  if (forced === 'server' || forced === 'local' || forced === 'off') return forced;
  if (!viaProxy(LLM)) return 'server';
  return localSearchAvailable(env) ? 'local' : 'off';
}

const NO_SEARCH_NOTE =
  'Note: web search is not available in this setup. Work from the material provided and what you already know, ' +
  'and mark anything about competitors, prices or recent events that you could not check as "(unverified)".';

/**
 * One model call. Streams (long outputs), uses web search the way this setup allows,
 * retries on refusal via server-side fallback when available, and records tokens and cost for every call.
 */
export async function ask(opts: AskOptions): Promise<AskResult> {
  const mode = opts.webSearches ? searchMode() : 'off';
  const fallbackOk = FALLBACKS && !/haiku/i.test(opts.model);
  const prompt = opts.webSearches && mode === 'off' ? `${opts.prompt}\n\n${NO_SEARCH_NOTE}` : opts.prompt;
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
  const sources: string[] = [];

  if (mode !== 'local') {
    const tools: Anthropic.Beta.BetaToolUnion[] = mode === 'server' ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: opts.webSearches }] : [];
    const msg = await callOnce(opts, messages, tools, fallbackOk);
    for (const block of msg.content) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) if (!sources.includes(r.url)) sources.push(r.url);
      }
    }
    return finish(opts, msg, sources);
  }

  // Local search: run the tool loop ourselves. Searches are capped; page reads are capped at twice that.
  const maxSearches = opts.webSearches ?? 0;
  let searches = 0;
  let reads = 0;
  for (let round = 0; ; round++) {
    const last = round >= maxSearches * 3 + 1;
    const msg = await callOnce(opts, messages, LOCAL_TOOLS, fallbackOk, last);
    if (msg.stop_reason !== 'tool_use' || last) return finish(opts, msg, sources);
    messages.push({ role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    const results = await Promise.all(
      calls.map(async (c): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
        const over = c.name === 'web_search' ? ++searches > maxSearches : c.name === 'read_page' ? ++reads > maxSearches * 2 : false;
        const r = over ? { content: `limit reached for ${c.name}; finish with what you have`, isError: true } : await runLocalTool(c.name, c.input, sources);
        return { type: 'tool_result', tool_use_id: c.id, content: r.content, is_error: r.isError };
      }),
    );
    messages.push({ role: 'user', content: results });
  }
}

function finish(opts: AskOptions, msg: Anthropic.Beta.BetaMessage, sources: string[]): AskResult {
  if (msg.stop_reason === 'refusal') {
    throw new Error(`model declined (${msg.stop_details?.category ?? 'no category'}) for ${opts.purpose}`);
  }
  const text = msg.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, sources, stopReason: msg.stop_reason };
}

/** Replies cut off mid-stream by a gateway or a flaky network. Worth another try; anything else isn't. */
export function isCutOff(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError && !(err instanceof Anthropic.APIConnectionTimeoutError)) return true;
  if (err instanceof Anthropic.APIError) return err.status === undefined && /overloaded|terminated/i.test(err.message);
  const msg = String((err as any)?.message ?? '') + ' ' + String((err as any)?.cause?.code ?? (err as any)?.cause?.message ?? '');
  return /terminated|other side closed|socket hang up|ECONNRESET|UND_ERR_SOCKET|premature close/i.test(msg);
}

export const RETRY_DELAYS_MS = [2000, 6000];
let sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Tests replace the pause so they don't wait. */
export function setSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}

async function callOnce(
  opts: AskOptions,
  messages: Anthropic.Beta.BetaMessageParam[],
  tools: Anthropic.Beta.BetaToolUnion[],
  fallbackOk: boolean,
  noMoreTools = false,
): Promise<Anthropic.Beta.BetaMessage> {
  for (let attempt = 0; ; attempt++) {
    checkBudget(opts.purpose);
    try {
      return await callStream(opts, messages, tools, fallbackOk, noMoreTools);
    } catch (err) {
      if (!isCutOff(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
      log('warn', 'llm', `${opts.purpose}: reply was cut off (${String((err as any)?.message ?? err).slice(0, 80)}); trying again in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function callStream(
  opts: AskOptions,
  messages: Anthropic.Beta.BetaMessageParam[],
  tools: Anthropic.Beta.BetaToolUnion[],
  fallbackOk: boolean,
  noMoreTools = false,
): Promise<Anthropic.Beta.BetaMessage> {
  const stream = anthropic().beta.messages.stream({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 32000,
    system: opts.system,
    messages,
    output_config: {
      ...(supportsEffort(opts.model) ? { effort: opts.effort ?? 'medium' } : {}),
      ...(opts.schema ? { format: { type: 'json_schema' as const, schema: opts.schema } } : {}),
    },
    cache_control: { type: 'ephemeral' },
    ...(tools.length ? { tools, ...(noMoreTools ? { tool_choice: { type: 'none' as const } } : {}) } : {}),
    ...(fallbackOk ? { fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] } : {}),
  });
  const msg = await stream.finalMessage();
  recordUsage(opts.purpose, msg);
  return msg;
}

/** Like `ask`, but the answer is JSON matching `schema`, parsed. */
export async function askJson<T>(opts: AskOptions & { schema: Record<string, unknown> }): Promise<T & { _sources: string[] }> {
  const res = await ask(opts);
  if (res.stopReason === 'max_tokens') throw new Error(`answer was cut off for ${opts.purpose}; raise maxTokens`);
  try {
    return { ...(JSON.parse(res.text) as T), _sources: res.sources };
  } catch {
    throw new Error(`${opts.model} answered in prose instead of JSON for ${opts.purpose} — it (or the gateway) ignores structured output; pick another model in .env`);
  }
}

export function costOf(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number; searches: number }): number {
  const [inP, outP, readP] = priceFor(model);
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
