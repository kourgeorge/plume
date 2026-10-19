import type Database from 'better-sqlite3';
import { getDb, getGlobalDb, getGlobalSetting, getSetting, setGlobalSetting, setSetting } from '../db';
import { MODELS } from '../config';
import { askJson, askPlain } from '../llm/client';
import { providerOf } from '../llm/settings';
import { agentSystem } from '../context/profile';
import { listCompetitors } from '../context/extra';
import { getSite, siteUrl } from '../sites';
import { currentSite, currentSiteOrNull } from '../site';
import { log } from '../log';

/**
 * AI visibility: ask the AI assistants people use (Claude, ChatGPT's GPT models, Gemini) the questions a
 * customer would ask, exactly as a member of the public would — no business context — and record whether
 * they name this business, in what position, how they describe it, and who they name instead.
 * These answers come from what each assistant already knows; they don't search the web here.
 */

// Own tables, created on first use, so this feature doesn't touch the shared schema file.
const TABLES = `
CREATE TABLE IF NOT EXISTS ai_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,            -- user | suggested
  added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  engines TEXT NOT NULL,           -- JSON {engine: model}
  status TEXT NOT NULL,            -- running | done | failed
  error TEXT,
  cost REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ai_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  question TEXT NOT NULL,          -- copied, so history survives deleting the question
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  answer TEXT,
  error TEXT,
  mentioned INTEGER,
  position INTEGER,                -- 1 = named first among the businesses it recommends
  sentiment TEXT,                  -- positive | neutral | negative
  competitors TEXT NOT NULL DEFAULT '[]',
  others TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS ai_answers_by_run ON ai_answers (run_id, question_id);
`;
const ready = new WeakSet<Database.Database>();
function db(): Database.Database {
  const d = getDb();
  if (!ready.has(d)) {
    d.exec(TABLES);
    ready.add(d);
  }
  return d;
}

export const MAX_QUESTIONS = 20;

// ---------------------------------------------------------------- engines

export type EngineId = 'claude' | 'gpt' | 'gemini';
export const ENGINES: EngineId[] = ['claude', 'gpt', 'gemini'];
export const ENGINE_LABEL: Record<EngineId, string> = { claude: 'Claude', gpt: 'ChatGPT (GPT)', gemini: 'Gemini' };

/** Names gateways commonly give these models, fastest first. The owner can type their own instead. */
const CANDIDATES: Record<EngineId, string[]> = {
  claude: [],
  gpt: ['azure/gpt-5.6-sol', 'gpt-5.6-sol', 'azure/gpt-6-sol', 'gpt-6-sol', 'azure/gpt-5.5', 'gpt-5.5', 'Azure/gpt-4.1', 'gpt-4.1', 'Azure/gpt-4o', 'gpt-4o'],
  gemini: ['gemini-2.5-flash', 'gcp/gemini-3.6-flash', 'gcp/gemini-3-flash-preview', 'gemini-2.5-pro', 'gcp/gemini-3.1-pro-preview'],
};

/** OpenRouter spells every company's models as company/model. */
const OPENROUTER: Record<EngineId, string[]> = {
  claude: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-sonnet-4.5'],
  gpt: ['openai/gpt-5-mini', 'openai/gpt-5'],
  gemini: ['google/gemini-2.5-flash', 'google/gemini-2.5-pro'],
};

/** Which provider offers each assistant's own models when it is the one connected. */
const OWN_PROVIDER: Record<EngineId, string> = { claude: 'anthropic', gpt: 'openai', gemini: 'gemini' };

/**
 * Model names to try for an assistant on the current AI connection; null = this connection can't reach it.
 * A gateway, OpenRouter or a custom service can offer all three; a single company offers only its own.
 */
function candidatesFor(engine: EngineId): string[] | null {
  const p = providerOf();
  if (p.id === OWN_PROVIDER[engine]) return [MODELS.draft];
  if (p.id === 'gateway') return engine === 'claude' ? [MODELS.draft] : CANDIDATES[engine];
  if (p.id === 'openrouter') return OPENROUTER[engine];
  if (p.id === 'custom') return engine === 'claude' ? null : CANDIDATES[engine];
  return null;
}

export interface EngineState {
  model: string | null;
  status: 'ok' | 'unavailable' | 'unchecked';
  note: string;
  /** Typed by the owner; detection tries only this name. */
  pinned: boolean;
}
type EngineSettings = Record<EngineId, EngineState> & { checkedAt: string | null };

/** Which model answers for each assistant. Shared by all sites, like the AI connection. */
export function engineSettings(): EngineSettings {
  const saved = getGlobalSetting<Partial<EngineSettings>>('aiEngines', {});
  const blank = (): EngineState => ({ model: null, status: 'unchecked', note: '', pinned: false });
  return {
    claude: saved.claude ?? (['anthropic', 'gateway'].includes(providerOf().id) ? { model: MODELS.draft, status: 'ok', note: 'the writing model from the AI connection', pinned: false } : blank()),
    gpt: saved.gpt ?? blank(),
    gemini: saved.gemini ?? blank(),
    checkedAt: saved.checkedAt ?? null,
  };
}

/** The owner types a model name for an assistant (empty = let Plume look for one). */
export function pinEngine(engine: EngineId, model: string): EngineSettings {
  const m = String(model ?? '').trim();
  if (m && !/^[\w./:@-]{2,80}$/.test(m)) throw new Error(`"${m}" doesn't look like a model name`);
  const s = engineSettings();
  s[engine] = m ? { model: m, status: 'unchecked', note: 'typed by you — not checked yet', pinned: true } : { model: null, status: 'unchecked', note: '', pinned: false };
  setGlobalSetting('aiEngines', s);
  return s;
}

/** Find a working model for each assistant through the AI connection. A failed try costs nothing. */
export async function detectEngines(): Promise<EngineSettings> {
  const s = engineSettings();
  for (const engine of ENGINES) {
    const st = s[engine];
    const candidates = candidatesFor(engine);
    if (!candidates && !st.pinned) {
      s[engine] = { model: null, status: 'unavailable', note: `Your AI connection (${providerOf().label}) doesn't offer ${ENGINE_LABEL[engine]}. OpenRouter or a gateway such as LiteLLM can reach all three.`, pinned: false };
      continue;
    }
    const tries = st.pinned && st.model ? [st.model] : candidates!;
    let found: string | null = null;
    let lastError = '';
    for (const model of tries) {
      try {
        await askPlain({ purpose: 'ai-visibility:detect', model, prompt: 'Reply with the single word: ok', maxTokens: 300 });
        found = model;
        break;
      } catch (err: any) {
        lastError = String(err?.message ?? err).slice(0, 160);
      }
    }
    s[engine] = found
      ? { model: found, status: 'ok', note: st.pinned ? 'typed by you — works' : 'found on your AI connection', pinned: st.pinned }
      : { model: st.pinned ? st.model : null, status: 'unavailable', note: st.pinned ? `that model didn't answer: ${lastError}` : `none of the usual names answered on your AI connection${lastError ? ` (${lastError})` : ''}. Type the name your gateway uses.`, pinned: st.pinned };
  }
  s.checkedAt = new Date().toISOString();
  setGlobalSetting('aiEngines', s);
  return s;
}

function activeEngines(): [EngineId, string][] {
  const s = engineSettings();
  return ENGINES.filter((e) => s[e].status === 'ok' && s[e].model).map((e) => [e, s[e].model!]);
}

// ---------------------------------------------------------------- questions

export interface Question {
  id: number;
  question: string;
  source: 'user' | 'suggested';
  addedAt: string;
}

export function listQuestions(): Question[] {
  return (db().prepare('SELECT * FROM ai_questions ORDER BY id').all() as any[]).map((r) => ({ id: r.id, question: r.question, source: r.source, addedAt: r.added_at }));
}

export function addQuestion(raw: string, source: Question['source'] = 'user'): Question | null {
  const q = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (q.length < 8) throw new Error('write the question the way a customer would ask it (at least a few words)');
  if (q.length > 300) throw new Error('keep the question under 300 characters');
  if (db().prepare('SELECT 1 FROM ai_questions WHERE lower(question) = lower(?)').get(q)) return null;
  if (listQuestions().length >= MAX_QUESTIONS) throw new Error(`you can check up to ${MAX_QUESTIONS} questions — remove one first`);
  const r = db().prepare('INSERT INTO ai_questions (question, source, added_at) VALUES (?, ?, ?)').run(q, source, new Date().toISOString());
  return listQuestions().find((x) => x.id === Number(r.lastInsertRowid))!;
}

export function removeQuestion(id: number): void {
  db().prepare('DELETE FROM ai_questions WHERE id = ?').run(id);
}

/** Questions a customer would ask an assistant before they know this business exists. */
export async function suggestQuestions(count = 8): Promise<Question[]> {
  const existing = listQuestions().map((q) => q.question);
  const res = await askJson<{ questions: string[] }>({
    purpose: 'ai-visibility:questions',
    model: MODELS.score,
    effort: 'low',
    maxTokens: 3000,
    system: agentSystem('You know how people ask AI assistants for recommendations.'),
    schema: { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', items: { type: 'string' } } } },
    prompt:
      `Write ${count} questions a potential customer of this business would type into ChatGPT, Claude or Gemini when looking for what it offers — before they know the business. ` +
      `Mix "what is the best…", "how do I…", "is X worth it" and comparison questions. Write them in the language the customers use. Never name this business.` +
      (existing.length ? `\nAlready being checked (don't repeat):\n${existing.map((q) => `- ${q}`).join('\n')}` : ''),
  });
  const added: Question[] = [];
  for (const q of res.questions) {
    if (listQuestions().length >= MAX_QUESTIONS) break;
    try {
      const a = addQuestion(q, 'suggested');
      if (a) added.push(a);
    } catch {
      /* skip a malformed suggestion */
    }
  }
  return added;
}

// ---------------------------------------------------------------- brand names

/** Names the business goes by: its domain, the domain without the ending, and any the owner added. */
export function brandNames(): string[] {
  const url = siteUrl();
  const host = url ? new URL(url).hostname.replace(/^www\./, '') : currentSite();
  const bare = host.split('.')[0];
  const extra = getSetting<string[]>('brandNames', []);
  // "acme-widgets.com" is written "Acme Widgets" in prose; the site's own name (unless it's just the address) too.
  const spaced = bare.replace(/[-_]+/g, ' ');
  const slug = currentSiteOrNull();
  const own = slug ? getSite(slug)?.name : undefined;
  const named = own && own !== slug && own !== host ? [own] : [];
  return [...new Set([...extra, ...named, host, bare, spaced].map((n) => n.trim()).filter((n) => n.length >= 3))];
}

export function setBrandNames(names: string[]): string[] {
  const clean = [...new Set((names ?? []).map((n) => String(n).replace(/\s+/g, ' ').trim()).filter((n) => n.length >= 2 && n.length <= 80))].slice(0, 10);
  setSetting('brandNames', clean);
  return brandNames();
}

/** Does the text name the business? Case-insensitive; Latin names must match a whole word. */
export function textMentions(text: string, names: string[]): boolean {
  const t = text.toLowerCase();
  return names.some((n) => {
    const name = n.toLowerCase();
    if (!/^[a-z0-9.\- ]+$/.test(name)) return t.includes(name);
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(t);
  });
}

// ---------------------------------------------------------------- checks

interface Analysis {
  mentioned: boolean;
  position: number | null;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  competitors: string[];
  others: string[];
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mentioned', 'position', 'sentiment', 'competitors', 'others'],
  properties: {
    mentioned: { type: 'boolean', description: 'Does the answer name our business (any of its names)?' },
    position: { type: ['integer', 'null'], description: '1 = ours is the first business it recommends, 2 = second… null if not named.' },
    sentiment: { type: ['string', 'null'], enum: ['positive', 'neutral', 'negative', null], description: 'How it describes our business; null if not named.' },
    competitors: { type: 'array', items: { type: 'string' }, description: 'Which of the listed competitors it names, spelled as in the list.' },
    others: { type: 'array', items: { type: 'string' }, description: 'Other businesses, products or websites it recommends (not ours, not the listed competitors).' },
  },
};

export async function analyseAnswer(answer: string, purpose: string): Promise<Analysis> {
  const names = brandNames();
  const comps = listCompetitors().map((c) => c.name);
  const a = await askJson<Analysis>({
    purpose,
    model: MODELS.score,
    effort: 'low',
    maxTokens: 1500,
    system: 'You read an AI assistant\'s answer and record facts about it. Only report what the answer actually says.',
    schema: ANALYSIS_SCHEMA,
    prompt: `Our business goes by: ${names.join(', ')}.\nListed competitors: ${comps.join(', ') || '(none)'}\n\n<answer>\n${answer}\n</answer>`,
  });
  // A plain name match is a fact the model can miss; never let it say "not named" when the name is right there.
  const mentioned = a.mentioned || textMentions(answer, names);
  const known = new Set(comps);
  return {
    mentioned,
    position: mentioned && Number.isInteger(a.position) && a.position! >= 1 ? a.position : null,
    sentiment: mentioned ? (a.sentiment ?? 'neutral') : null,
    competitors: [...new Set(a.competitors.filter((c) => known.has(c)))],
    others: [...new Set(a.others.map((o) => o.trim()).filter((o) => o && !textMentions(o, names)))].slice(0, 12),
  };
}

export function estimateCost(): { checks: number; usd: number } {
  const checks = listQuestions().length * activeEngines().length;
  return { checks, usd: Math.round(checks * 0.012 * 100) / 100 };
}

/** Ask every question of every available assistant and record what they say. */
export async function runVisibilityCheck(onProgress: (m: string) => void = () => {}): Promise<number> {
  const qs = listQuestions();
  if (!qs.length) throw new Error('add some questions to check first');
  if (engineSettings().checkedAt === null) {
    onProgress('Finding which AI assistants your connection can reach');
    await detectEngines();
  }
  const engines = activeEngines();
  if (!engines.length) throw new Error('no AI assistant answered — check the AI connection on the website list');
  const run = Number(db().prepare(`INSERT INTO ai_runs (at, engines, status) VALUES (?, ?, 'running')`).run(new Date().toISOString(), JSON.stringify(Object.fromEntries(engines))).lastInsertRowid);
  const purpose = `ai-visibility:run:${run}`;
  const ins = db().prepare(
    'INSERT INTO ai_answers (run_id, question_id, question, engine, model, answer, error, mentioned, position, sentiment, competitors, others) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  try {
    for (const [i, q] of qs.entries()) {
      onProgress(`Asking ${engines.length} assistant(s) question ${i + 1} of ${qs.length}`);
      await Promise.all(
        engines.map(async ([engine, model]) => {
          try {
            const answer = await askPlain({ purpose, model, prompt: q.question, maxTokens: 4000 });
            const a = await analyseAnswer(answer, purpose);
            ins.run(run, q.id, q.question, engine, model, answer, null, a.mentioned ? 1 : 0, a.position, a.sentiment, JSON.stringify(a.competitors), JSON.stringify(a.others));
          } catch (err: any) {
            ins.run(run, q.id, q.question, engine, model, null, String(err?.message ?? err).slice(0, 300), null, null, null, '[]', '[]');
          }
        }),
      );
    }
    const cost = (getGlobalDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) c FROM llm_calls WHERE site = ? AND purpose = ?').get(currentSite(), purpose) as { c: number }).c;
    db().prepare(`UPDATE ai_runs SET status = 'done', cost = ? WHERE id = ?`).run(cost, run);
    const s = visibilitySummary();
    log('info', 'ai-visibility', `named in ${s?.overall.mentioned ?? 0} of ${s?.overall.answered ?? 0} answers ($${cost.toFixed(3)})`);
    return run;
  } catch (err: any) {
    db().prepare(`UPDATE ai_runs SET status = 'failed', error = ? WHERE id = ?`).run(String(err?.message ?? err), run);
    throw err;
  }
}

// ---------------------------------------------------------------- what the page shows

export interface Cell {
  answerId: number;
  mentioned: boolean | null;
  position: number | null;
  sentiment: string | null;
  error: string | null;
  excerpt: string;
}

export function visibilitySummary() {
  const run = db().prepare(`SELECT * FROM ai_runs WHERE status = 'done' ORDER BY id DESC LIMIT 1`).get() as any;
  if (!run) return null;
  const rows = db().prepare('SELECT * FROM ai_answers WHERE run_id = ? ORDER BY question_id, engine').all(run.id) as any[];
  const engines = Object.keys(JSON.parse(run.engines)) as EngineId[];
  const answered = rows.filter((r) => !r.error);
  const mentioned = answered.filter((r) => r.mentioned);
  const positions = mentioned.map((r) => r.position).filter((p): p is number => p !== null);
  const perEngine = engines.map((e) => {
    const mine = answered.filter((r) => r.engine === e);
    const hits = mine.filter((r) => r.mentioned);
    const pos = hits.map((r) => r.position).filter((p): p is number => p !== null);
    return { engine: e, label: ENGINE_LABEL[e], model: JSON.parse(run.engines)[e], answered: mine.length, mentioned: hits.length, avgPosition: pos.length ? Math.round((pos.reduce((a, b) => a + b, 0) / pos.length) * 10) / 10 : null };
  });
  type QuestionRow = { questionId: number; question: string; cells: Partial<Record<EngineId, Cell>> };
  const byQuestion = new Map<number, QuestionRow>();
  for (const r of rows) {
    const q: QuestionRow = byQuestion.get(r.question_id) ?? { questionId: r.question_id, question: r.question, cells: {} };
    q.cells[r.engine as EngineId] = {
      answerId: r.id,
      mentioned: r.error ? null : !!r.mentioned,
      position: r.position,
      sentiment: r.sentiment,
      error: r.error,
      excerpt: String(r.answer ?? '').replace(/\s+/g, ' ').slice(0, 220),
    };
    byQuestion.set(r.question_id, q);
  }
  // Share of voice: in how many answers each name appears.
  const voice = new Map<string, number>();
  for (const r of answered) for (const n of new Set([...JSON.parse(r.competitors), ...JSON.parse(r.others)])) voice.set(n, (voice.get(n) ?? 0) + 1);
  const shareOfVoice = [{ name: 'You', answers: mentioned.length, you: true }, ...[...voice].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([name, answers]) => ({ name, answers, you: false }))];
  const trend = (db().prepare(`SELECT id, at FROM ai_runs WHERE status = 'done' ORDER BY id DESC LIMIT 12`).all() as any[]).reverse().map((t) => {
    const a = db().prepare('SELECT COUNT(*) n, COALESCE(SUM(mentioned), 0) m FROM ai_answers WHERE run_id = ? AND error IS NULL').get(t.id) as { n: number; m: number };
    return { at: t.at, score: a.n ? Math.round((100 * a.m) / a.n) : 0 };
  });
  return {
    runId: run.id as number,
    at: run.at as string,
    cost: run.cost as number,
    overall: { answered: answered.length, mentioned: mentioned.length, score: answered.length ? Math.round((100 * mentioned.length) / answered.length) : 0, avgPosition: positions.length ? Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 10) / 10 : null },
    perEngine,
    questions: [...byQuestion.values()],
    shareOfVoice,
    trend,
    failed: rows.length - answered.length,
  };
}

export function getAnswer(id: number): { question: string; engine: string; model: string; answer: string | null; error: string | null } | null {
  const r = db().prepare('SELECT question, engine, model, answer, error FROM ai_answers WHERE id = ?').get(id) as any;
  return r ?? null;
}

export function runningRun(): boolean {
  return !!db().prepare(`SELECT 1 FROM ai_runs WHERE status = 'running'`).get();
}

/** On startup: a check cut off by a restart is marked failed rather than "running" forever. */
export function closeStaleRuns(): void {
  db().prepare(`UPDATE ai_runs SET status = 'failed', error = 'stopped because Plume was restarted' WHERE status = 'running'`).run();
}

// ---------------------------------------------------------------- gaps → Dashboard

export interface Gap {
  runId: number;
  questionId: number;
  question: string;
  namedInstead: string[];
  engines: number;
}

/** Questions where no assistant named us but at least one named someone else — the clearest content gaps. */
export function openGaps(): Gap[] {
  const s = visibilitySummary();
  if (!s) return [];
  const done = new Set(getSetting<string[]>('aiGapsDone', []));
  const out: Gap[] = [];
  for (const q of s.questions) {
    if (done.has(`${s.runId}:${q.questionId}`)) continue;
    const cells = Object.values(q.cells).filter((c): c is Cell => !!c && c.mentioned !== null);
    if (!cells.length || cells.some((c) => c.mentioned)) continue;
    const rows = db().prepare('SELECT competitors, others FROM ai_answers WHERE run_id = ? AND question_id = ? AND error IS NULL').all(s.runId, q.questionId) as any[];
    const named = [...new Set(rows.flatMap((r) => [...JSON.parse(r.competitors), ...JSON.parse(r.others)]))];
    if (named.length) out.push({ runId: s.runId, questionId: q.questionId, question: q.question, namedInstead: named.slice(0, 5), engines: cells.length });
  }
  return out;
}

export function gapDone(runId: number, questionId: number): void {
  const done = getSetting<string[]>('aiGapsDone', []);
  setSetting('aiGapsDone', [...done.filter((k) => !k.startsWith(`${runId}:`) || k !== `${runId}:${questionId}`), `${runId}:${questionId}`].slice(-500));
}
