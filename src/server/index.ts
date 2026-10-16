import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { getDb, getSetting, setSetting } from '../db';
import { PROFILE_DOCS, isProfileDocId, readDoc, writeDoc } from '../context/profile';
import { startResearch } from '../research/profile';
import { getJob } from '../jobs';
import { AGENTS, startAgentRun } from '../agents';
import { AuditResult, dailyFixes, markFixDone, runAudit } from '../agents/seoAudit';
import { DraftMeta, DraftStatus, draftEvents, editDraft, getDraft, listDrafts, moveDraft } from '../queue';
import { PUBLISHERS, getPublisher } from '../publish';
import { publishOne } from '../publish/runner';

/** Only this machine may talk to the API: reject other Host headers (DNS rebinding) and cross-site Origins. */
function localOnly(port: number) {
  const ok = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return (host?: string, origin?: string) => !!host && ok.has(host) && (!origin || ok.has(origin.replace(/^https?:\/\//, '')));
}

export function buildServer(port: number): FastifyInstance {
  const app = Fastify({ logger: false });
  const allowed = localOnly(port);

  app.addHook('onRequest', async (req, reply) => {
    if (!allowed(req.headers.host, req.headers.origin as string | undefined)) {
      return reply.code(403).send({ error: 'local access only' });
    }
  });

  app.register(fastifyStatic, { root: path.resolve(__dirname, '../../web') });

  app.get('/api/state', async () => ({
    site: getSetting<string | null>('siteUrl', null),
    docs: PROFILE_DOCS.map((d) => ({ id: d.id, title: d.title, written: readDoc(d.id) !== null })),
    hasApiKey: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  }));

  app.post<{ Body: { url?: string; only?: string } }>('/api/research', async (req, reply) => {
    const raw = req.body?.url ?? getSetting<string | null>('siteUrl', null);
    let url: URL;
    try {
      url = new URL(raw?.match(/^https?:\/\//) ? raw : `https://${raw}`);
    } catch {
      return reply.code(400).send({ error: 'enter a website address, e.g. example.com' });
    }
    const only = req.body?.only;
    if (only && !isProfileDocId(only)) return reply.code(400).send({ error: `unknown document ${only}` });
    setSetting('siteUrl', url.origin);
    return { jobId: startResearch(url.origin, only as never) };
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = getJob(Number(req.params.id));
    return job ?? reply.code(404).send({ error: 'no such job' });
  });

  app.get<{ Params: { id: string } }>('/api/profile/:id', async (req, reply) => {
    if (!isProfileDocId(req.params.id)) return reply.code(404).send({ error: 'no such document' });
    return { id: req.params.id, body: readDoc(req.params.id) ?? '' };
  });

  app.put<{ Params: { id: string }; Body: { body?: string } }>('/api/profile/:id', async (req, reply) => {
    if (!isProfileDocId(req.params.id)) return reply.code(404).send({ error: 'no such document' });
    if (typeof req.body?.body !== 'string') return reply.code(400).send({ error: 'body must be text' });
    writeDoc(req.params.id, req.body.body);
    return { ok: true };
  });

  // ---- agents ----
  app.get('/api/agents', async () => AGENTS.map((a) => ({ id: a.id, label: a.label, description: a.description })));

  app.post<{ Params: { id: string }; Body: { limit?: number } }>('/api/agents/:id/run', async (req, reply) => {
    try {
      return { jobId: startAgentRun(req.params.id, req.body?.limit) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---- daily site check ----
  app.get('/api/audit', async () => {
    const audit = getSetting<AuditResult | null>('lastAudit', null);
    return { audit, today: audit ? dailyFixes(audit) : [] };
  });
  app.post('/api/audit', async () => {
    const audit = await runAudit(getSetting<string | null>('siteUrl', null) ?? undefined);
    return { audit, today: dailyFixes(audit) };
  });
  app.post<{ Body: { id?: string } }>('/api/audit/done', async (req, reply) => {
    if (!req.body?.id) return reply.code(400).send({ error: 'id required' });
    markFixDone(req.body.id);
    return { ok: true };
  });

  // ---- inbox ----
  app.get('/api/publishers', async () =>
    PUBLISHERS.map((p) => ({ id: p.id, label: p.label, configured: p.configured(), needs: p.needs.filter((n) => !process.env[n]) })),
  );

  app.get<{ Querystring: { status?: DraftStatus; agent?: string } }>('/api/drafts', async (req) =>
    listDrafts(req.query).map(({ body, originalBody, ...rest }) => ({ ...rest, words: body.split(/\s+/).length })),
  );

  app.get<{ Params: { id: string } }>('/api/drafts/:id', async (req, reply) => {
    const d = getDraft(Number(req.params.id));
    return d ? { ...d, events: draftEvents(d.id) } : reply.code(404).send({ error: 'no such draft' });
  });

  app.put<{ Params: { id: string }; Body: { title?: string; body?: string; meta?: DraftMeta } }>('/api/drafts/:id', async (req, reply) => {
    try {
      return editDraft(Number(req.params.id), req.body ?? {});
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post<{ Params: { id: string }; Body: { target?: string; when?: string | null } }>('/api/drafts/:id/approve', async (req, reply) => {
    const target = req.body?.target ?? 'export';
    if (!getPublisher(target)) return reply.code(400).send({ error: `unknown target ${target}` });
    const when = req.body?.when ? new Date(req.body.when) : null;
    if (when && isNaN(when.getTime())) return reply.code(400).send({ error: 'bad date' });
    try {
      const d = moveDraft(Number(req.params.id), 'approved', { target, scheduledFor: when?.toISOString() ?? null, note: when ? `scheduled for ${when.toISOString()}` : 'approved' });
      return when && when > new Date() ? d : await publishOne(d.id);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  for (const [action, to] of [['reject', 'rejected'], ['reopen', 'draft']] as const) {
    app.post<{ Params: { id: string } }>(`/api/drafts/:id/${action}`, async (req, reply) => {
      try {
        return moveDraft(Number(req.params.id), to);
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });
  }

  app.get('/api/usage', async () => {
    const db = getDb();
    return {
      total: db.prepare('SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost FROM llm_calls').get(),
      byPurpose: db
        .prepare('SELECT purpose, model, COUNT(*) calls, SUM(input_tokens) input, SUM(output_tokens) output, SUM(cost_usd) cost FROM llm_calls GROUP BY purpose, model ORDER BY cost DESC')
        .all(),
    };
  });

  return app;
}
