import type Anthropic from '@anthropic-ai/sdk';
import { LlmConfig, endpointOf, parseHeaders, providerOf } from './settings';

/**
 * Plume's agents are written against Anthropic's message format. This turns one such request into an
 * OpenAI Chat Completions call (the format OpenAI, Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter,
 * Ollama and most others accept) and turns the answer back, so no agent needs to know the difference.
 * Anthropic-only settings (effort, prompt caching, fallbacks, its server-side tools) are dropped.
 */

type Params = {
  model: string;
  max_tokens: number;
  system?: Anthropic.Beta.BetaTextBlockParam[] | string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools?: Anthropic.Beta.BetaToolUnion[];
  noMoreTools?: boolean;
  schema?: Record<string, unknown>;
  effort?: string;
};

/** A refused call, shaped like the Anthropic SDK's errors so the same explanations apply. */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly error: any,
    message: string,
  ) {
    super(message);
  }
}

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b: any) => (b?.type === 'text' ? b.text : '')).join('')
      : '';

/** Anthropic messages → OpenAI messages. Tool results become `tool` messages; server-side blocks are dropped. */
export function toOpenAiMessages(system: Params['system'], messages: Anthropic.Beta.BetaMessageParam[], schema?: Record<string, unknown>): any[] {
  const out: any[] = [];
  let sys = textOf(system);
  // Some providers only offer "any JSON"; saying what shape is wanted makes those answers usable too.
  if (schema) sys = `${sys ? `${sys}\n\n` : ''}Answer with a single JSON object only, no other text. It must follow this JSON schema:\n${JSON.stringify(schema)}`;
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as any[];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: 'assistant', content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results must come straight after the assistant turn that asked for them.
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const content = textOf(b.content);
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${content}` : content });
      }
    }
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

/** Only tools Plume runs itself can be offered; Anthropic's server tools (its web search) have no equivalent. */
export function toOpenAiTools(tools: Anthropic.Beta.BetaToolUnion[] = []): any[] {
  return tools
    .filter((t: any) => t.input_schema)
    .map((t: any) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema } }));
}

type Attempt = { json: 'schema' | 'object'; maxTokens: number | null; tools: boolean };

const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };

/** An OpenAI answer → the Anthropic message shape the rest of Plume reads. */
export function fromOpenAi(model: string, text: string, calls: { id: string; name: string; arguments: string }[], finish: string | null, usage: any): Anthropic.Beta.BetaMessage {
  const content: any[] = [];
  if (text) content.push({ type: 'text', text, citations: null });
  for (const c of calls) {
    let input: unknown = {};
    try {
      input = c.arguments ? JSON.parse(c.arguments) : {};
    } catch {
      /* the model wrote broken arguments; the tool sees none and says so */
    }
    content.push({ type: 'tool_use', id: c.id || `call_${content.length}`, name: c.name, input });
  }
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: (calls.length ? 'tool_use' : (STOP[finish ?? 'stop'] ?? 'end_turn')) as any,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
      output_tokens: usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  } as any;
}

/** How each provider wants the answer-length limit and the shape of a structured answer. */
function body(cfg: LlmConfig, p: Params, attempt: Attempt): any {
  const provider = providerOf(cfg);
  const tools = p.noMoreTools || !attempt.tools ? [] : toOpenAiTools(p.tools);
  const b: any = { model: p.model, messages: toOpenAiMessages(p.system, p.messages, p.schema), stream: true, stream_options: { include_usage: true } };
  // OpenAI's newer models refuse max_tokens; everyone else knows only max_tokens.
  if (attempt.maxTokens) b[provider.id === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = attempt.maxTokens;
  if (tools.length) b.tools = tools;
  if (p.schema) b.response_format = attempt.json === 'schema' ? { type: 'json_schema', json_schema: { name: 'answer', schema: p.schema } } : { type: 'json_object' };
  if (p.effort && provider.id === 'openai' && /^(gpt-5|o\d)/.test(p.model)) b.reasoning_effort = { low: 'low', medium: 'medium' }[p.effort] ?? 'high';
  return b;
}

/**
 * One call. Streams, so a long answer is fine as long as it keeps arriving; `onChunk` is called for each
 * piece (the caller's silence timer). A provider that rejects the structured-answer shape or the length
 * limit is asked again with what it does accept.
 */
export async function openAiCall(cfg: LlmConfig, p: Params, opts: { signal?: AbortSignal; onChunk?: () => void; timeoutMs?: number } = {}): Promise<Anthropic.Beta.BetaMessage> {
  const attempt: Attempt = { json: 'schema', maxTokens: p.max_tokens, tools: true };
  for (let tries = 0; ; tries++) {
    try {
      return await once(cfg, p, attempt, opts);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.status !== 400 || tries >= 4) throw err;
      const msg = err.message;
      // A model without tool use can still answer; it just can't search or act.
      if (attempt.tools && p.tools?.length && /\btools?\b|function.?call/i.test(msg)) attempt.tools = false;
      else if (p.schema && attempt.json === 'schema' && /response_format|json_schema|schema/i.test(msg)) attempt.json = 'object';
      else if (attempt.maxTokens && /max_tokens|max_completion_tokens|maximum.*tokens|tokens.*(limit|maximum)/i.test(msg)) attempt.maxTokens = attempt.maxTokens > 8192 ? 8192 : null;
      else throw err;
    }
  }
}

async function once(cfg: LlmConfig, p: Params, attempt: Attempt, opts: { signal?: AbortSignal; onChunk?: () => void; timeoutMs?: number }): Promise<Anthropic.Beta.BetaMessage> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...parseHeaders(cfg.headers) };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (providerOf(cfg).id === 'openrouter') Object.assign(headers, { 'HTTP-Referer': 'https://github.com/georgekour/plume', 'X-Title': 'Plume' });
  const signals = [opts.signal, opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined].filter(Boolean) as AbortSignal[];
  let res: Response;
  for (let retry = 0; ; retry++) {
    res = await fetch(`${endpointOf(cfg)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body(cfg, p, attempt)), signal: signals.length ? AbortSignal.any(signals) : undefined });
    // Busy or rate-limited: a short wait usually clears it, the way Anthropic's own client retries.
    if ((res.status === 429 || res.status >= 500) && retry < 2) {
      const wait = Math.min(20, Number(res.headers.get('retry-after')) || 2 * (retry + 1));
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const raw = await res.text();
    let data: any = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    const e = Array.isArray(data) ? data[0]?.error : data?.error;
    const message = String(e?.message ?? e ?? data?.message ?? data?.detail ?? (raw.slice(0, 300) || res.statusText));
    throw new ProviderError(res.status, { error: { message } }, `${res.status} ${message}`);
  }
  let text = '';
  let finish: string | null = null;
  let usage: any = null;
  let model = p.model;
  const calls: { id: string; name: string; arguments: string }[] = [];
  const handle = (chunk: any) => {
    if (chunk.error) throw new ProviderError(500, { error: chunk.error }, `the provider stopped mid-answer: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? choice.message ?? {};
      if (typeof d.content === 'string') text += d.content;
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  };
  // A provider may ignore `stream` and send the whole answer at once.
  if (!/event-stream/.test(res.headers.get('content-type') ?? '')) {
    handle(await res.json());
  } else {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      opts.onChunk?.();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        handle(JSON.parse(data));
      }
    }
  }
  return fromOpenAi(model, text, calls.filter(Boolean), finish, usage);
}
