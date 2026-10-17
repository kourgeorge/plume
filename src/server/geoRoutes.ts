import type { FastifyInstance } from 'fastify';
import {
  ENGINES, EngineId, MAX_QUESTIONS, addQuestion, brandNames, detectEngines, engineSettings, estimateCost, getAnswer,
  listQuestions, openGaps, pinEngine, removeQuestion, runVisibilityCheck, runningRun, setBrandNames, suggestQuestions, visibilitySummary,
} from '../geo/visibility';
import { findIssue, fixesByIssue, lastFix, startFixPullRequest } from '../geo/codefix';
import { finishJob, runningJob, startJob, updateJob } from '../jobs';
import { siteEnv } from '../integrations';
import { aiGapSeen } from '../today';

/** Routes for AI visibility and code fixes. Kept apart from the main route file; registered from there. */
export function registerGeoRoutes(app: FastifyInstance): void {
  const bad = (reply: any, err: any, code = 400) => reply.code(code).send({ error: String(err?.message ?? err) });

  // ---- AI visibility ----
  app.get('/api/ai-visibility', async () => ({
    summary: visibilitySummary(),
    questions: listQuestions(),
    engines: engineSettings(),
    brandNames: brandNames(),
    estimate: estimateCost(),
    running: runningRun() ? (runningJob('ai-visibility')?.progress ?? 'checking…') : null,
    max: MAX_QUESTIONS,
  }));

  app.post<{ Body: { question?: string } }>('/api/ai-visibility/questions', async (req, reply) => {
    try {
      const q = addQuestion(req.body?.question ?? '');
      return q ?? reply.code(409).send({ error: 'that question is already on the list' });
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/ai-visibility/questions/:id', async (req) => (removeQuestion(Number(req.params.id)), { ok: true }));
  app.post('/api/ai-visibility/suggest', async (_req, reply) => {
    try {
      return { added: await suggestQuestions() };
    } catch (err) {
      return bad(reply, err);
    }
  });

  app.put<{ Body: { names?: string[] } }>('/api/ai-visibility/names', async (req) => ({ names: setBrandNames(req.body?.names ?? []) }));

  app.put<{ Body: { engine?: string; model?: string } }>('/api/ai-visibility/engines', async (req, reply) => {
    if (!ENGINES.includes(req.body?.engine as EngineId)) return reply.code(400).send({ error: 'unknown assistant' });
    try {
      return pinEngine(req.body!.engine as EngineId, req.body?.model ?? '');
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.post('/api/ai-visibility/engines/detect', async (_req, reply) => {
    try {
      return await detectEngines();
    } catch (err) {
      return bad(reply, err);
    }
  });

  /** Run the check in the background; the page polls GET /api/ai-visibility. */
  app.post('/api/ai-visibility/run', async (_req, reply) => {
    if (runningRun() || runningJob('ai-visibility')) return reply.code(409).send({ error: 'a check is already running' });
    if (!listQuestions().length) return reply.code(400).send({ error: 'add some questions to check first' });
    const jobId = startJob('ai-visibility', 'Starting');
    runVisibilityCheck((m) => updateJob(jobId, m))
      .then(() => finishJob(jobId))
      .catch((err) => finishJob(jobId, String(err?.message ?? err)));
    return { jobId };
  });

  app.get<{ Params: { id: string } }>('/api/ai-visibility/answers/:id', async (req, reply) => getAnswer(Number(req.params.id)) ?? reply.code(404).send({ error: 'no such answer' }));
  app.get('/api/ai-visibility/gaps', async () => openGaps());
  app.post<{ Body: { runId?: number; questionId?: number } }>('/api/ai-visibility/gaps/done', async (req, reply) => {
    if (!req.body?.runId || !req.body?.questionId) return reply.code(400).send({ error: 'runId and questionId required' });
    aiGapSeen(req.body.runId, req.body.questionId); // also counts toward "done today"
    return { ok: true };
  });

  // ---- fixes as pull requests ----
  app.get('/api/code-fixes', async () => {
    const env = siteEnv();
    return { connected: !!(env.GITHUB_TOKEN && env.GITHUB_REPO), repo: env.GITHUB_REPO ?? null, fixes: fixesByIssue(), running: runningJob('codefix')?.progress ?? null };
  });
  app.post<{ Body: { issueId?: string } }>('/api/code-fixes', async (req, reply) => {
    const id = req.body?.issueId ?? '';
    if (!findIssue(id)) return reply.code(404).send({ error: 'that fix is no longer in the latest site check' });
    try {
      return { jobId: startFixPullRequest(id) };
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.get<{ Querystring: { issueId?: string } }>('/api/code-fixes/status', async (req) => ({ fix: lastFix(req.query.issueId ?? '') }));
}
