import 'dotenv/config';
import fs from 'fs';
import path from 'path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data');
export const PROFILE_DIR = path.join(DATA_DIR, 'profile');
export const PORT = Number(process.env.PORT ?? 4410);

fs.mkdirSync(PROFILE_DIR, { recursive: true });

/** Which model does which kind of work. Research needs judgment; drafting needs speed; scoring is bulk. */
export const MODELS = {
  research: 'claude-opus-5-5',
  draft: 'claude-sonnet-5-5',
  score: 'claude-haiku-5-5',
} as const;

/** USD per million tokens: [input, output, cache read]. Cache writes bill at 1.25x input. */
export const PRICES: Record<string, [number, number, number]> = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
};
