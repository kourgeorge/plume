import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';
import { Provider, ProviderId, getProvider, inferProvider, isProviderId } from './providers';

/**
 * Which AI provider model calls go to, and with which key. Two sources, first wins:
 * 1. saved from the AI connection screen (data/tokens/llm.json, readable only by this user);
 * 2. Plume's .env: LLM_PROVIDER (+ LLM_BASE_URL) + LLM_API_KEY, or a provider's own key such as
 *    OPENAI_API_KEY; without LLM_PROVIDER, LLM_BASE_URL means a gateway and ANTHROPIC_API_KEY means Anthropic.
 * Read on every use, so a change on the screen applies without a restart.
 */
export interface LlmModels {
  research: string;
  draft: string;
  score: string;
}

export interface LlmConfig {
  /** Which provider (see providers.ts); decides the wire format and the default address. */
  provider: ProviderId;
  /** Address calls go to, e.g. https://litellm.mycompany.com. Empty = the provider's own address. */
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

/**
 * Only Plume's own variables. ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN are deliberately ignored:
 * other tools (Claude Code among them) set those in the shell for their own gateway, and Plume
 * must not silently pick up someone else's connection.
 */
function fromEnv(env: NodeJS.ProcessEnv): LlmConfig {
  const baseUrl = (env.LLM_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const named = env.LLM_PROVIDER?.trim().toLowerCase();
  if (named && !isProviderId(named)) throw new Error(`LLM_PROVIDER="${named}" in .env is not a provider Plume knows`);
  const provider: ProviderId = named && isProviderId(named) ? named : inferProvider(baseUrl);
  const p = getProvider(provider)!;
  // A provider's own key variable only counts for that provider, so a gateway never gets a direct key.
  const ownKey = p.envKey && (named || !baseUrl) ? env[p.envKey] : undefined;
  const apiKey = (env.LLM_API_KEY ?? ownKey ?? '').trim();
  const models = defaultModels(p);
  return {
    provider,
    baseUrl,
    apiKey,
    headers: env.LLM_HEADERS ?? '',
    models: {
      research: env.PLUME_MODEL_RESEARCH || models.research,
      draft: env.PLUME_MODEL_DRAFT || models.draft,
      score: env.PLUME_MODEL_SCORE || models.score,
    },
    source: apiKey || (named && !p.needsKey) ? 'environment' : 'none',
  };
}

function defaultModels(p: Provider): LlmModels {
  return { ...p.models };
}

export function getLlmConfig(env = process.env): LlmConfig {
  if (cached) return cached;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const baseUrl = String(saved?.baseUrl ?? '').trim().replace(/\/+$/, '');
    const provider: ProviderId = isProviderId(saved?.provider) ? saved.provider : inferProvider(baseUrl);
    if (saved?.apiKey || isProviderId(saved?.provider)) {
      cached = {
        provider,
        baseUrl,
        apiKey: String(saved.apiKey ?? ''),
        headers: String(saved.headers ?? ''),
        models: { ...defaultModels(getProvider(provider)!), ...pickModels(saved.models) },
        source: 'saved',
      };
      return cached;
    }
  } catch {
    /* nothing saved yet */
  }
  cached = fromEnv(env);
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
export function saveLlmConfig(input: { provider?: string; baseUrl?: string; apiKey?: string; headers?: string; models?: Partial<LlmModels> }): LlmConfig {
  const current = getLlmConfig();
  if (input.provider !== undefined && !isProviderId(input.provider)) throw new Error(`"${input.provider}" is not a provider Plume knows`);
  const provider: ProviderId = (input.provider as ProviderId | undefined) ?? (input.baseUrl !== undefined ? inferProvider(input.baseUrl.trim()) : current.provider);
  const p = getProvider(provider)!;
  const switched = provider !== current.provider;
  const baseUrl = p.urlEditable ? (input.baseUrl ?? (switched ? '' : current.baseUrl)).trim().replace(/\/+$/, '') : '';
  if (!baseUrl && !p.baseUrl) throw new Error(`enter the address of your ${p.format === 'anthropic' ? 'gateway' : 'service'}`);
  if (baseUrl) {
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new Error(`"${baseUrl}" is not a web address — it should look like https://litellm.example.com`);
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('the base URL must start with http:// or https://');
  }
  // A key typed for one provider is never sent to another.
  const apiKey = (input.apiKey ?? '').trim() || (current.source === 'saved' && !switched ? current.apiKey : '');
  if (!apiKey && p.needsKey) throw new Error(`enter the API key${p.keyUrl ? ` — get one at ${p.keyUrl}` : ''}`);
  const headers = input.headers ?? (switched ? '' : current.headers);
  parseHeaders(headers, true);
  const models = { ...(switched ? defaultModels(p) : current.models), ...pickModels(input.models) };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ provider, baseUrl, apiKey, headers, models }, null, 2), { mode: 0o600 });
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

/** The provider's details for a connection. */
export function providerOf(c: Pick<LlmConfig, 'provider'> = getLlmConfig()): Provider {
  return getProvider(c.provider) ?? getProvider('anthropic')!;
}

/** True when calls speak OpenAI's format (every provider except Anthropic and Anthropic-style gateways). */
export function openAiFormat(c: Pick<LlmConfig, 'provider'> = getLlmConfig()): boolean {
  return providerOf(c).format === 'openai';
}

/** Where calls actually go: the typed address, else the provider's own. */
export function endpointOf(c: Pick<LlmConfig, 'provider' | 'baseUrl'> = getLlmConfig()): string {
  return c.baseUrl || providerOf(c).baseUrl;
}

/**
 * True unless calls go to Anthropic directly. Anthropic-only extras (its built-in web search,
 * refusal fallbacks) are used only when this is false.
 */
export function viaProxy(c: Pick<LlmConfig, 'baseUrl'> & Partial<Pick<LlmConfig, 'provider'>> = getLlmConfig()): boolean {
  const provider = c.provider ?? inferProvider(c.baseUrl);
  if (provider !== 'anthropic' && provider !== 'gateway') return true;
  return !!c.baseUrl && !/^https:\/\/api\.anthropic\.com\/?$/.test(c.baseUrl);
}

/** Why AI can't be used right now, or null when it can. */
export function llmProblem(c = getLlmConfig()): string | null {
  if (c.source === 'none') return 'no AI connection yet — pick a provider and add your key under "AI connection" on the website list';
  if (!c.apiKey && providerOf(c).needsKey) return `no API key for ${providerOf(c).label} — add it under "AI connection" on the website list`;
  return null;
}

/** Safe to show: where calls go, which models, and the last 4 characters of the key — never the key. */
export function describeLlm(c = getLlmConfig()) {
  const p = providerOf(c);
  return {
    provider: p.id,
    providerLabel: p.label,
    endpoint: endpointOf(c),
    customUrl: c.baseUrl,
    viaProxy: viaProxy(c),
    keyHint: c.apiKey ? `…${c.apiKey.slice(-4)}` : null,
    headerNames: Object.keys(parseHeaders(c.headers)),
    models: c.models,
    source: c.source,
    error: llmProblem(c),
  };
}
