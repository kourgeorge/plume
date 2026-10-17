import Anthropic from '@anthropic-ai/sdk';
import { priceFor, supportsEffort } from '../config';
import { LlmConfig, getLlmConfig, llmProblem, parseHeaders, viaProxy } from './settings';
import { LOCAL_TOOLS, localSearchAvailable, runLocalTool } from './search';
import { checkBudget } from './budget';
import { log } from '../log';
import { getGlobalDb } from '../db';
import { currentSiteOrNull } from '../site';

let client: { cfg: LlmConfig; sdk: Anthropic } | null = null;

/**
 * One client per connection setting: rebuilt when the AI connection is changed on the screen.
 * Gateways (LiteLLM) take the key as a Bearer token; Anthropic directly takes it as x-api-key.
 */
export function clientFor(cfg: LlmConfig): Anthropic {
  const proxy = viaProxy(cfg);
  return new Anthropic({
    baseURL: cfg.baseUrl || null,
    apiKey: proxy ? null : cfg.apiKey,
    authToken: proxy ? cfg.apiKey : null,
    defaultHeaders: parseHeaders(cfg.headers),
  });
}

function anthropic(): Anthropic {
  const cfg = getLlmConfig();
  if (client?.cfg !== cfg) client = { cfg, sdk: clientFor(cfg) };
  return client.sdk;
}

/** Server-side refusal fallback is an Anthropic API feature; gateways generally don't forward it. */
const fallbacksOn = () => (process.env.PLUME_FALLBACKS ? process.env.PLUME_FALLBACKS === '1' : !viaProxy());

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
  if (!viaProxy()) return 'server';
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
  const fallbackOk = fallbacksOn() && !/haiku/i.test(opts.model);
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

/** Web search for a conversation: Anthropic's own when going direct, Plume's (Tavily) through a gateway, else none. */
export function chatSearchTools(): { tools: Anthropic.Beta.BetaToolUnion[]; local: boolean } {
  const mode = searchMode();
  if (mode === 'server') return { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }], local: false };
  if (mode === 'local') return { tools: LOCAL_TOOLS, local: true };
  return { tools: [], local: false };
}

export { runLocalTool };

/**
 * One model call in a conversation the caller keeps. `messages` must only ever grow between calls
 * (newer models reject edited history), so callers append replies exactly as returned.
 */
export async function converse(opts: {
  purpose: string;
  model: string;
  system: Anthropic.Beta.BetaTextBlockParam[];
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
  maxTokens?: number;
  effort?: AskOptions['effort'];
  noMoreTools?: boolean;
}): Promise<Anthropic.Beta.BetaMessage> {
  return callOnce(
    { purpose: opts.purpose, model: opts.model, system: opts.system, prompt: '', maxTokens: opts.maxTokens ?? 16000, effort: opts.effort ?? 'medium' },
    opts.messages,
    opts.tools,
    fallbacksOn() && !/haiku/i.test(opts.model),
    opts.noMoreTools,
  );
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
  const problem = llmProblem();
  if (problem) throw new Error(problem);
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
  getGlobalDb()
    .prepare(
      `INSERT INTO llm_calls (at, site, purpose, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, web_searches, cost_usd, stop_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(new Date().toISOString(), currentSiteOrNull(), purpose, msg.model, row.input, row.output, row.cacheRead, row.cacheWrite, row.searches, costOf(msg.model, row), msg.stop_reason);
}

export interface ModelCheck {
  role: 'research' | 'draft' | 'score';
  model: string;
  ok: boolean;
  /** Plain English: "works", "your gateway doesn't allow this model", "wrong key", ... */
  message: string;
  json: boolean | null;
}

/** Explain a failed call in words a person can act on. */
export function explainCallError(err: any): string {
  const status = err?.status;
  const raw = String(err?.error?.error?.message ?? err?.message ?? err);
  if (status === 401 || /invalid.*(key|token|jwt)|unauthori[sz]ed|authentication/i.test(raw)) return 'the key was refused — check it, and that it belongs to this gateway';
  if (status === 403 && /not allowed to access model|model/i.test(raw)) return "your gateway doesn't allow this model for your key — pick one it offers";
  if (status === 404 || /model.*not found|no such model|invalid model/i.test(raw)) return 'this model name is unknown to the gateway';
  if (status === 429) return 'the gateway is rate-limiting you — wait a minute and try again';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'the gateway did not answer in time';
  if (err instanceof Anthropic.APIConnectionError) return `could not reach the gateway (${String((err.cause as any)?.message ?? raw).slice(0, 120)})`;
  return raw.slice(0, 200);
}

/**
 * Check each model the connection uses: a two-word reply, then a tiny JSON answer (agents need JSON).
 * Uses the given settings directly, so a connection can be tested before it is saved.
 */
export async function testConnection(cfg: LlmConfig): Promise<{ ok: boolean; problem: string | null; checks: ModelCheck[] }> {
  const problem = llmProblem(cfg);
  if (problem) return { ok: false, problem, checks: [] };
  const sdk = clientFor(cfg);
  const checks: ModelCheck[] = [];
  const roles = ['research', 'draft', 'score'] as const;
  const seen = new Map<string, ModelCheck>();
  for (const role of roles) {
    const model = cfg.models[role];
    const prior = seen.get(model);
    if (prior) {
      checks.push({ ...prior, role });
      continue;
    }
    const check: ModelCheck = { role, model, ok: false, message: '', json: null };
    try {
      const r = await sdk.messages.create({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] }, { timeout: 60_000, maxRetries: 0 });
      check.ok = r.content.some((b) => b.type === 'text');
      check.message = check.ok ? 'works' : 'answered, but with no text';
      try {
        const j = await sdk.messages.create(
          {
            model,
            max_tokens: 200,
            messages: [{ role: 'user', content: 'Is the sky blue on a clear day?' }],
            output_config: { format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['yes'], properties: { yes: { type: 'boolean' } } } } },
          } as any,
          { timeout: 60_000, maxRetries: 0 },
        );
        const text = j.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        JSON.parse(text);
        check.json = true;
      } catch {
        check.json = false;
        check.message = 'works for writing, but ignores structured answers — agents that plan or score need another model';
      }
    } catch (err) {
      check.message = explainCallError(err);
    }
    seen.set(model, check);
    checks.push(check);
  }
  const ok = checks.every((c) => c.ok && c.json !== false);
  log(ok ? 'info' : 'warn', 'llm', `connection test to ${cfg.baseUrl || 'Anthropic'}: ${checks.map((c) => `${c.role} ${c.model} ${c.ok ? (c.json === false ? 'no-json' : 'ok') : 'failed'}`).join(', ')}`);
  return { ok, problem: null, checks };
}
