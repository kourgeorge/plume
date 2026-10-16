import fs from 'fs';
import os from 'os';

/**
 * Model access can come from a Claude Code settings file (its "env" block), e.g. one that points
 * at a LiteLLM proxy. Only the connection and model-name keys are taken, and they stay in this
 * object — they are not copied into process.env, so a direct ANTHROPIC_API_KEY in the shell
 * can't leak to the proxy (or the proxy key to Anthropic).
 */
const KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
] as const;

export type LlmSettings = Partial<Record<(typeof KEYS)[number], string>> & { source: string };

export function loadLlmSettings(env = process.env): LlmSettings {
  const file = env.CLAUDE_SETTINGS_FILE?.replace(/^~(?=\/)/, os.homedir());
  if (!file) {
    const s: LlmSettings = { source: 'environment' };
    for (const k of KEYS) if (env[k]) s[k] = env[k];
    return s;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err: any) {
    throw new Error(`could not read CLAUDE_SETTINGS_FILE (${file}): ${err.code ?? err.message}`);
  }
  const block = parsed?.env ?? {};
  const s: LlmSettings = { source: file };
  for (const k of KEYS) if (typeof block[k] === 'string' && block[k]) s[k] = block[k];
  if (!s.ANTHROPIC_AUTH_TOKEN && !s.ANTHROPIC_API_KEY) throw new Error(`${file} has no ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in its "env" block`);
  return s;
}

/** "Name: value" lines (Claude Code's format) → header object. */
export function parseHeaders(raw?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** True when calls go somewhere other than Anthropic directly (LiteLLM or another gateway). */
export function viaProxy(s: LlmSettings): boolean {
  return !!s.ANTHROPIC_BASE_URL && !/^https:\/\/api\.anthropic\.com\/?$/.test(s.ANTHROPIC_BASE_URL);
}

/** Safe-to-show summary: where calls go and which models, never the key. */
export function describe(s: LlmSettings): { source: string; endpoint: string; auth: string } {
  return {
    source: s.source,
    endpoint: s.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    auth: s.ANTHROPIC_AUTH_TOKEN ? 'bearer token' : s.ANTHROPIC_API_KEY ? 'API key' : 'none',
  };
}
