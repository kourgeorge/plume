import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { loadLlmSettings } from './llm/settings';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
export const PROFILE_DIR = path.join(DATA_DIR, 'profile');
export const PORT = Number(process.env.PORT ?? 4410);

fs.mkdirSync(PROFILE_DIR, { recursive: true });

/** Where model calls go and with which credential: a Claude Code settings file if CLAUDE_SETTINGS_FILE is set. */
export const LLM = loadLlmSettings();

/** Which model does which kind of work. Research needs judgment; drafting needs speed; scoring is bulk. */
export const MODELS = {
  research: process.env.PLUME_MODEL_RESEARCH ?? LLM.ANTHROPIC_DEFAULT_OPUS_MODEL ?? LLM.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
  draft: process.env.PLUME_MODEL_DRAFT ?? LLM.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-5-5',
  score: process.env.PLUME_MODEL_SCORE ?? LLM.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? LLM.ANTHROPIC_SMALL_FAST_MODEL ?? 'claude-haiku-5-5',
};

/** Older models reject the effort setting; they get none. */
export function supportsEffort(model: string): boolean {
  return !/(haiku|sonnet|opus)-4-5|claude-3/.test(model);
}

/** USD per million tokens: [input, output, cache read]. Cache writes bill at 1.25x input. */
export const PRICES: Record<string, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
};

/** Price for a model name as a proxy may spell it ("anthropic/claude-sonnet-5-5", "claude-sonnet-5-5@2026…"). */
export function priceFor(model: string): [number, number, number] {
  const known = Object.keys(PRICES).find((k) => model.includes(k));
  if (known) return PRICES[known];
  if (/haiku/i.test(model)) return PRICES['claude-haiku-5-5'];
  if (/sonnet/i.test(model)) return PRICES['claude-sonnet-5-5'];
  return PRICES['claude-opus-5-5'];
}
