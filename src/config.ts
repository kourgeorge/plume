import 'dotenv/config';
import fs from 'fs';
import path from 'path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
export const PORT = Number(process.env.PORT ?? 4410);

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * Which model does which kind of work. Research needs judgment; drafting needs speed; scoring is bulk.
 * Read live from the AI connection settings, so a change on the screen applies to the next call.
 */
export const MODELS = {
  get research() {
    return require('./llm/settings').getLlmConfig().models.research as string;
  },
  get draft() {
    return require('./llm/settings').getLlmConfig().models.draft as string;
  },
  get score() {
    return require('./llm/settings').getLlmConfig().models.score as string;
  },
};

/** Older models reject the effort setting; they get none. */
export function supportsEffort(model: string): boolean {
  return !/(haiku|sonnet|opus)-4-5|claude-3/.test(model);
}

/**
 * USD per million tokens: [input, output, cache read]. Cache writes bill at 1.25x input.
 * Other providers' prices are list prices at the time of writing; they only feed the monthly limit.
 */
export const PRICES: Record<string, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-haiku-4-5': [1, 5, 0.1],
  'gpt-5-nano': [0.05, 0.4, 0.005],
  'gpt-5-mini': [0.25, 2, 0.025],
  'gpt-5': [1.25, 10, 0.125],
  'gpt-4.1': [2, 8, 0.5],
  'gpt-4o-mini': [0.15, 0.6, 0.075],
  'gpt-4o': [2.5, 10, 1.25],
  'gpt-oss-120b': [0.15, 0.6, 0.15],
  'gpt-oss-20b': [0.075, 0.3, 0.075],
  'gemini-2.5-pro': [1.25, 10, 0.31],
  'gemini-2.5-flash-lite': [0.1, 0.4, 0.025],
  'gemini-2.5-flash': [0.3, 2.5, 0.075],
  'deepseek-chat': [0.27, 1.1, 0.07],
  'deepseek-reasoner': [0.55, 2.19, 0.14],
  'mistral-large': [2, 6, 2],
  'mistral-medium': [0.4, 2, 0.4],
  'mistral-small': [0.1, 0.3, 0.1],
  'grok-4': [3, 15, 0.75],
  'grok-3-mini': [0.3, 0.5, 0.075],
  'sonar-pro': [3, 15, 3],
  sonar: [1, 1, 1],
  llama: [0.6, 0.8, 0.6],
};

// Longest first, so "gpt-5-mini" is found before "gpt-5".
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/** Price for a model name as a proxy may spell it ("anthropic/claude-sonnet-5-5", "claude-sonnet-5-5@2026…"). */
export function priceFor(model: string): [number, number, number] {
  const known = PRICE_KEYS.find((k) => model.toLowerCase().includes(k));
  if (known) return PRICES[known];
  if (/haiku/i.test(model)) return PRICES['claude-haiku-5-5'];
  if (/sonnet/i.test(model)) return PRICES['claude-sonnet-5-5'];
  // Unknown model: count it at the dearest price, so the monthly limit errs on the safe side.
  return PRICES['claude-opus-5-5'];
}
