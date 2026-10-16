import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';

/**
 * Where model calls go and with which key. Two sources, first wins:
 * 1. saved from the AI connection screen (data/tokens/llm.json, readable only by this user);
 * 2. .env: LLM_BASE_URL + LLM_API_KEY (a LiteLLM or other gateway), or ANTHROPIC_API_KEY (direct).
 * Read on every use, so a change on the screen applies without a restart.
 */
export interface LlmModels {
  research: string;
  draft: string;
  score: string;
}

export interface LlmConfig {
  /** Gateway address, e.g. https://litellm.mycompany.com. Empty = Anthropic directly. */
  baseUrl: string;
  apiKey: string;
  /** Extra request headers, one "Name: value" per line (some gateways want a team or project header). */
  headers: string;
  models: LlmModels;
  source: 'saved' | 'environment' | 'none';
}

export const DEFAULT_MODELS: LlmModels = { research: 'claude-opus-5-5', draft: 'claude-sonnet-5-5', score: 'claude-haiku-5-5' };

const file = () => path.join(DATA_DIR, 'tokens', 'llm.json');

let cached: LlmConfig | null = null;

function fromEnv(env: NodeJS.ProcessEnv): LlmConfig {
  const baseUrl = env.LLM_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? '';
  const apiKey = env.LLM_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? '';
  return {
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    apiKey: apiKey.trim(),
    headers: env.LLM_HEADERS ?? '',
    models: {
      research: env.PLUME_MODEL_RESEARCH || DEFAULT_MODELS.research,
      draft: env.PLUME_MODEL_DRAFT || DEFAULT_MODELS.draft,
      score: env.PLUME_MODEL_SCORE || DEFAULT_MODELS.score,
    },
    source: apiKey ? 'environment' : 'none',
  };
}

export function getLlmConfig(env = process.env): LlmConfig {
  if (cached) return cached;
  const base = fromEnv(env);
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (saved?.apiKey) {
      cached = {
        baseUrl: String(saved.baseUrl ?? '').trim().replace(/\/+$/, ''),
        apiKey: String(saved.apiKey),
        headers: String(saved.headers ?? ''),
        models: { ...base.models, ...pickModels(saved.models) },
        source: 'saved',
      };
      return cached;
    }
  } catch {
    /* nothing saved yet */
  }
  cached = base;
  return cached;
}

function pickModels(m: any): Partial<LlmModels> {
  const out: Partial<LlmModels> = {};
  for (const k of ['research', 'draft', 'score'] as const) if (typeof m?.[k] === 'string' && m[k].trim()) out[k] = m[k].trim();
  return out;
}

/**
 * Save from the screen. An empty key keeps the one already saved (the screen never shows it back),
 * so changing only the address or a model name doesn't require re-typing the key.
 */
export function saveLlmConfig(input: { baseUrl?: string; apiKey?: string; headers?: string; models?: Partial<LlmModels> }): LlmConfig {
  const current = getLlmConfig();
  const baseUrl = (input.baseUrl ?? current.baseUrl).trim().replace(/\/+$/, '');
  if (baseUrl) {
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new Error(`"${baseUrl}" is not a web address — it should look like https://litellm.example.com`);
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('the base URL must start with http:// or https://');
  }
  const apiKey = (input.apiKey ?? '').trim() || (current.source === 'saved' ? current.apiKey : '');
  if (!apiKey) throw new Error('enter the API key');
  const headers = input.headers ?? current.headers;
  parseHeaders(headers, true);
  const models = { ...current.models, ...pickModels(input.models) };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ baseUrl, apiKey, headers, models }, null, 2), { mode: 0o600 });
  fs.chmodSync(file(), 0o600);
  cached = null;
  return getLlmConfig();
}

/** Forget the saved connection; .env (if any) applies again. */
export function clearLlmConfig(): void {
  fs.rmSync(file(), { force: true });
  cached = null;
}

/** For tests and after editing .env by hand. */
export function reloadLlmConfig(): void {
  cached = null;
}

/** "Name: value" lines → header object. With `strict`, a malformed line is an error instead of being skipped. */
export function parseHeaders(raw?: string, strict = false): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (raw ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i <= 0 || !/^[A-Za-z0-9-]+$/.test(line.slice(0, i).trim())) {
      if (strict) throw new Error(`"${line.trim()}" is not a header — write one per line as Name: value`);
      continue;
    }
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** True when calls go through a gateway rather than to Anthropic directly. */
export function viaProxy(c: Pick<LlmConfig, 'baseUrl'> = getLlmConfig()): boolean {
  return !!c.baseUrl && !/^https:\/\/api\.anthropic\.com\/?$/.test(c.baseUrl);
}

/** Why AI can't be used right now, or null when it can. */
export function llmProblem(c = getLlmConfig()): string | null {
  return c.apiKey ? null : 'no AI connection yet — add your LiteLLM base URL and key under "AI connection" on the website list';
}

/** Safe to show: where calls go, which models, and the last 4 characters of the key — never the key. */
export function describeLlm(c = getLlmConfig()) {
  return {
    endpoint: c.baseUrl || 'https://api.anthropic.com',
    viaProxy: viaProxy(c),
    keyHint: c.apiKey ? `…${c.apiKey.slice(-4)}` : null,
    headerNames: Object.keys(parseHeaders(c.headers)),
    models: c.models,
    source: c.source,
    error: llmProblem(c),
  };
}
