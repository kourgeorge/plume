import Fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { getDb, getGlobalDb, getSetting, setSetting } from '../db';
import { currentSite, isSlug, withSite } from '../site';
import { addSite, getSite, removeSite, renameSite, setSiteUrl, siteSummaries, siteUrl, touchSite } from '../sites';
import { MODELS } from '../config';
import { clearLlmConfig, describeLlm, getLlmConfig, llmProblem, saveLlmConfig } from '../llm/settings';
import { searchMode, testConnection } from '../llm/client';
import { PROVIDERS } from '../llm/providers';
import { RTL, contentLanguage, contentLanguages, languageList, languageName, setContentLanguages } from '../context/language';
import { PROFILE_DOCS, docWrittenAt, isProfileDocId, profileComplete, readDoc, writeDoc } from '../context/profile';
import { renderMarkdown } from '../render';
import { techSignals } from '../research/techSignals';
import { startResearch } from '../research/profile';
import { getJob, runningJob, runningJobs } from '../jobs';
import { AGENTS, getAgent, startAgentRun, startAgentRuns } from '../agents';
import { agentInstructions, generalInstructions, setAgentInstructions, setGeneralInstructions } from '../agents/instructions';
import { AuditResult, dailyFixes, runAudit } from '../agents/seoAudit';
import { DraftMeta, DraftStatus, draftEvents, editDraft, getDraft, listDrafts, moveDraft } from '../queue';
import { PUBLISHERS, getPublisher, pageHtml, stripTitle, targetsFor } from '../publish';
import { describeIntegrations, getIntegration, removeIntegration, saveIntegration, siteEnv, testIntegration } from '../integrations';
import { publishOne } from '../publish/runner';
import { authUrl, disconnectGoogle, finishAuth, googleConfigured, googleConnected } from '../analytics/google';
import { PullStatus, listAnalyticsProperties, listSearchConsoleSites, matchSite, pullAll } from '../analytics/pull';
import { LIVE_BREAKDOWNS, LiveBreakdown, liveNow } from '../analytics/live';
import { performanceNotes, publishedResults, resultsSummary, topPages, topQueries } from '../analytics/results';
import { searchConsoleGaps } from '../agents/seo';
import { TaskSetting, reschedule, runTask, taskDefs, taskOverview, taskSetting, updateTask } from '../scheduler';
import {
  MENTIONS, applyAction, createThread, deleteThread, discardAction, getThread, isThreadRunning, listThreads, sendMessage, showThread, suggestions, undoAction,
} from '../chat';
import { pageChangeSeen, rankAlertSeen } from '../today';
import { updatesBetween } from '../seo/googleUpdates';
import { changeSeen, countDone, fixDone, notUseful, sendSpeedToSeo, skipItem, todayFeed, todayProgress } from '../today';
import {
  addCompetitor, brandProfiles, getCompetitor, listCompetitors, listPeople, removeCompetitor, removePerson,
  savePerson, setBrandProfiles, setUserNotes, updateCompetitor, userNotes,
} from '../context/extra';
import { checkCompetitor, getSuggestion, openChanges, lastChecked, listScans, openSuggestions, scanNewsSocial, settleSuggestion, socialsOf } from '../watch';
import { extractCompetitors } from '../research/competitors';
import { buildLlmsTxt } from '../research/llmstxt';
import { closeBrowser } from '../research/fetchPage';
import { Level, recentLogs, systemLogs } from '../log';
import { budgetStatus, setBudgetLimit } from '../llm/budget';
import { lastSpeed } from '../analytics/pagespeed';
import { registerGeoRoutes } from './geoRoutes';
import { actionResults, actionsNote, auditHistory, recordAction } from '../actions';
import { registerOutreachRoutes } from './outreachRoutes';
import { registerPhoneRoutes } from './phoneRoutes';
import { registerToolsRoutes } from './toolsRoutes';
import { registerReportRoutes } from './reportRoutes';
import { MAX_TRACKED, completeWeeks, listTracked, normalizeKeyword, rankingsTable, suggestKeywords, trackKeyword, untrackKeyword } from '../seo/rankings';
import { checkSerp, clearSerpCreds, describeSerp, latestSerp, saveSerpCreds, serpCreds, setSerpLocation } from '../seo/serp';
import { competitorKeywordsCheckedAt, keywordGaps, keywordMetrics, refreshCompetitorKeywords, savedMetrics } from '../seo/keywordData';

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

  // Which website a request is for: the dashboard sends it as a header; plain links (downloads, Google sign-in) as ?site=.
  // Everything the request does, including background work it starts, then happens inside that site.
  const SITE_FREE = [/^\/api\/system-logs(\?|$)/, /^\/api\/sites(\/|$|\?)/, /^\/api\/budget(\?|$)/, /^\/api\/google\/callback/, /^\/api\/llm(\/|$|\?)/];
  app.addHook('onRequest', (req, reply, done) => {
    if (!req.url.startsWith('/api/')) return done();
    const raw = (req.headers['x-plume-site'] as string | undefined) ?? (req.query as Record<string, string> | undefined)?.site;
    if (!raw) {
      if (SITE_FREE.some((r) => r.test(req.url))) return done();
      reply.code(400).send({ error: 'pick a website first' });
      return;
    }
    if (!isSlug(raw) || !getSite(raw)) {
      reply.code(404).send({ error: `no website "${raw}" — it may have been removed` });
      return;
    }
    withSite(raw, done);
  });

  const web = path.resolve(__dirname, '../../web');
  app.register(fastifyStatic, { root: web, index: false });
  app.get('/', async (_req, reply) => reply.sendFile('sites.html'));
  app.get<{ Params: { slug: string } }>('/s/:slug', async (req, reply) => reply.redirect(`/s/${encodeURIComponent(req.params.slug)}/`));
  app.get<{ Params: { slug: string } }>('/s/:slug/', async (req, reply) => {
    if (!isSlug(req.params.slug) || !getSite(req.params.slug)) return reply.redirect('/');
    touchSite(req.params.slug);
    return reply.sendFile('index.html');
  });

  // ---- AI connection (shared by all sites) ----
  app.get('/api/llm', async () => ({ ...describeLlm(), webSearch: searchMode() }));
  app.put<{ Body: { provider?: string; baseUrl?: string; apiKey?: string; headers?: string; models?: Record<string, string> } }>('/api/llm', async (req, reply) => {
    try {
      saveLlmConfig(req.body ?? {});
      return { ...describeLlm(), webSearch: searchMode() };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  /** The providers the connection screen offers, with their default address and models. */
  app.get('/api/llm/providers', async () => PROVIDERS);
  app.delete('/api/llm', async () => (clearLlmConfig(), describeLlm()));
  /** One tiny call per model, so the user sees at once which models their gateway allows. Costs a fraction of a cent. */
  app.post('/api/llm/test', async () => testConnection(getLlmConfig()));

  // ---- the site list ----
  app.get('/api/sites', async () => siteSummaries());
  app.post<{ Body: { url?: string; research?: boolean } }>('/api/sites', async (req, reply) => {
    try {
      const { site, created } = addSite(req.body?.url ?? '');
      const jobId = created && req.body?.research ? withSite(site.slug, () => startResearch(site.url)) : null;
      // The new site's own timers: publishing, the daily checks.
      if (created) reschedule();
      return { site, created, jobId };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.put<{ Params: { slug: string }; Body: { name?: string; url?: string } }>('/api/sites/:slug', async (req, reply) => {
    if (!getSite(req.params.slug)) return reply.code(404).send({ error: `no site ${req.params.slug}` });
    try {
      if (typeof req.body?.url === 'string') setSiteUrl(req.params.slug, req.body.url);
      return typeof req.body?.name === 'string' ? renameSite(req.params.slug, req.body.name) : getSite(req.params.slug);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.delete<{ Params: { slug: string } }>('/api/sites/:slug', async (req, reply) => {
    try {
      removeSite(req.params.slug);
      reschedule();
      return { ok: true };
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });

  app.get('/api/state', async () => ({
    site: siteUrl(),
    slug: currentSite(),
    siteName: getSite(currentSite())?.name ?? currentSite(),
    docs: PROFILE_DOCS.map((d) => ({ id: d.id, title: d.title, written: readDoc(d.id) !== null })),
    hasApiKey: !llmProblem(),
    llmError: llmProblem(),
    llm: { ...describeLlm(), webSearch: searchMode() },
    language: {
      code: contentLanguage(),
      name: languageName(contentLanguage()),
      rtl: RTL.has(contentLanguage()),
      all: contentLanguages(),
      names: languageList(contentLanguages()),
    },
  }));

  /** The owner corrects the site's languages: codes like "he" or "en", main first. Research then leaves them alone. */
  app.post<{ Body: { languages?: string[] } }>('/api/language', async (req, reply) => {
    const codes = [...new Set((req.body?.languages ?? []).map((c) => String(c).toLowerCase().trim().split(/[-_]/)[0]).filter((c) => /^[a-z]{2,3}$/.test(c)))];
    if (!codes.length) return reply.code(400).send({ error: 'give at least one language code, like "en" or "he"' });
    setContentLanguages({ main: codes[0], all: codes }, true);
    return { code: codes[0], names: languageList(codes) };
  });

  /** Research always covers this site's own address; a different website is a different site in the list. */
  app.post<{ Body: { only?: string } }>('/api/research', async (req, reply) => {
    const site = getSite(currentSite())!;
    const only = req.body?.only;
    if (only && !isProfileDocId(only)) return reply.code(400).send({ error: `unknown document ${only}` });
    return { jobId: startResearch(site.url, only as never) };
  });

  app.get('/api/jobs/running', async () => runningJobs());
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = getJob(Number(req.params.id));
    return job ?? reply.code(404).send({ error: 'no such job' });
  });

  app.get<{ Params: { id: string } }>('/api/profile/:id', async (req, reply) => {
    if (!isProfileDocId(req.params.id)) return reply.code(404).send({ error: 'no such document' });
    const body = readDoc(req.params.id) ?? '';
    return { id: req.params.id, body, html: renderMarkdown(body), writtenAt: docWrittenAt(req.params.id) };
  });

  app.put<{ Params: { id: string }; Body: { body?: string } }>('/api/profile/:id', async (req, reply) => {
    if (!isProfileDocId(req.params.id)) return reply.code(404).send({ error: 'no such document' });
    if (typeof req.body?.body !== 'string') return reply.code(400).send({ error: 'body must be text' });
    const before = readDoc(req.params.id);
    writeDoc(req.params.id, req.body.body);
    if (before !== null && before.trim() !== req.body.body.trim()) recordAction({ kind: 'doc-edited', ref: req.params.id, title: PROFILE_DOCS.find((d) => d.id === req.params.id)!.title });
    return { ok: true };
  });

  // ---- agents ----
  /** Agent folders: how much is waiting, whether it's working right now, and what (if anything) it needs. */
  app.get('/api/agents', async () => {
    const ready = profileComplete();
    const audit = getSetting<AuditResult | null>('lastAudit', null);
    const folders = AGENTS.map((a) => {
      const drafts = listDrafts({ agent: a.id });
      const job = runningJob(`agent:${a.id}`);
      return {
        id: a.id,
        label: a.label,
        description: a.description,
        waiting: drafts.filter((d) => d.status === 'draft').length,
        total: drafts.length,
        working: job?.progress ?? null,
        needs: ready ? null : 'business profile',
        schedule: taskSetting(`agent:${a.id}`),
      };
    });
    return [
      ...folders,
      {
        id: 'site-check',
        label: 'Site fixes',
        description: "Your site's technical health, with two fixes a day.",
        waiting: audit ? dailyFixes(audit).length : 0,
        total: audit?.issues.length ?? 0,
        working: runningJob('task:site-check')?.progress ?? null,
        needs: siteUrl() ? null : 'your website',
        schedule: taskSetting('site-check'),
      },
    ];
  });

  /** Company-wide instructions: every agent and the chat follow them. */
  app.get('/api/instructions', async () => ({ text: generalInstructions() }));
  app.put<{ Body: { text?: string } }>('/api/instructions', async (req, reply) => {
    if (typeof req.body?.text !== 'string') return reply.code(400).send({ error: 'text must be text' });
    try {
      return { text: setGeneralInstructions(req.body.text) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id/instructions', async (req, reply) =>
    getAgent(req.params.id) ? { text: agentInstructions(req.params.id) } : reply.code(404).send({ error: 'no such agent' }),
  );
  app.put<{ Params: { id: string }; Body: { text?: string } }>('/api/agents/:id/instructions', async (req, reply) => {
    if (!getAgent(req.params.id)) return reply.code(404).send({ error: 'no such agent' });
    if (typeof req.body?.text !== 'string') return reply.code(400).send({ error: 'text must be text' });
    try {
      return { text: setAgentInstructions(req.params.id, req.body.text) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /** Several agents side by side; with no list, every agent. */
  app.post<{ Body: { ids?: string[] } }>('/api/agents/run', async (req, reply) => {
    try {
      return { started: startAgentRuns(Array.isArray(req.body?.ids) ? req.body.ids.map(String) : undefined) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.post<{ Params: { id: string }; Body: { limit?: number } }>('/api/agents/:id/run', async (req, reply) => {
    try {
      const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
      if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 10)) return reply.code(400).send({ error: 'drafts per run must be 1–10' });
      return { jobId: startAgentRun(req.params.id, limit) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ---- daily site check ----
  app.get('/api/audit', async () => {
    const audit = getSetting<AuditResult | null>('lastAudit', null);
    return { audit, today: audit ? dailyFixes(audit) : [], history: auditHistory(), fixed: actionResults(50).filter((a) => a.kind === 'fix-done') };
  });
  app.post('/api/audit', async () => {
    const audit = await runAudit(siteUrl() ?? undefined);
    return { audit, today: dailyFixes(audit), history: auditHistory(), fixed: actionResults(50).filter((a) => a.kind === 'fix-done') };
  });
  app.post<{ Body: { id?: string } }>('/api/audit/done', async (req, reply) => {
    if (!req.body?.id) return reply.code(400).send({ error: 'id required' });
    fixDone(req.body.id);
    return { ok: true };
  });

  // ---- inbox ----
  app.get('/api/publishers', async () =>
    {
    const env = siteEnv();
    return PUBLISHERS.map((p) => ({ id: p.id, label: p.label, configured: p.configured(env), needs: p.needs.filter((n) => !env[n]) }));
  });

  // ---- this website's settings: where it publishes ----
  app.get('/api/integrations', async () => describeIntegrations());
  app.put<{ Params: { id: string }; Body: { values?: Record<string, unknown> } }>('/api/integrations/:id', async (req, reply) => {
    if (!getIntegration(req.params.id)) return reply.code(404).send({ error: 'no such integration' });
    try {
      saveIntegration(req.params.id, req.body?.values ?? {});
      return describeIntegrations().find((i) => i.id === req.params.id);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.delete<{ Params: { id: string } }>('/api/integrations/:id', async (req, reply) => {
    if (!getIntegration(req.params.id)) return reply.code(404).send({ error: 'no such integration' });
    removeIntegration(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/integrations/:id/test', async (req, reply) =>
    getIntegration(req.params.id) ? testIntegration(req.params.id) : reply.code(404).send({ error: 'no such integration' }),
  );

  app.get<{ Querystring: { status?: DraftStatus; agent?: string } }>('/api/drafts', async (req) =>
    listDrafts(req.query).map(({ body, originalBody, ...rest }) => ({ ...rest, words: body.split(/\s+/).length })),
  );

  app.get<{ Params: { id: string } }>('/api/drafts/:id', async (req, reply) => {
    const d = getDraft(Number(req.params.id));
    return d ? { ...d, events: draftEvents(d.id), targets: targetsFor(d.kind) } : reply.code(404).send({ error: 'no such draft' });
  });

  // How the article will read, for the Preview tab. Takes the unsaved text, so it matches what is on screen.
  app.post<{ Body: { body?: string } }>('/api/preview', async (req) => ({ html: renderMarkdown(stripTitle(String(req.body?.body ?? ''))) }));

  // The draft as a finished web page (or its Markdown). ?download=1 saves it as a file instead of opening it.
  app.get<{ Params: { id: string }; Querystring: { format?: string; download?: string } }>('/api/drafts/:id/page', async (req, reply) => {
    const d = getDraft(Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'no such draft' });
    const md = req.query.format === 'md';
    const name = `${d.meta.slug || `draft-${d.id}`}.${md ? 'md' : 'html'}`.replace(/[^\w.-]+/g, '-');
    reply.header('content-type', md ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8');
    // AI-written text opened on the dashboard's own address: no scripts, no requests back to the dashboard.
    reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; sandbox");
    if (req.query.download === '1') reply.header('content-disposition', `attachment; filename="${name}"`);
    return md ? d.body : pageHtml(d);
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
      countDone();
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

  // ---- Google: Search Console + Analytics ----
  const redirectUri = `http://127.0.0.1:${port}/api/google/callback`;

  app.get('/api/google', async () => ({
    configured: googleConfigured(siteEnv()),
    connected: googleConnected(),
    site: getSetting<string | null>('gscSite', null),
    property: getSetting<string | null>('ga4Property', null),
    lastPull: getSetting<PullStatus | null>('lastPull', null),
    redirectUri,
  }));

  app.get('/api/google/connect', async (_req, reply) => {
    try {
      return reply.redirect(authUrl(redirectUri, currentSite()));
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/google/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    const back = (slug: string | null, msg?: string) => reply.redirect(`${slug ? `/s/${encodeURIComponent(slug)}/` : '/'}#results${msg ? `?google=${encodeURIComponent(msg)}` : ''}`);
    if (error || !code || !state) return back(null, error ?? 'cancelled');
    let slug: string | null = null;
    try {
      slug = await finishAuth(code, state);
      if (!getSite(slug)) return back(null);
      // Pick the matching Search Console site automatically when there's an obvious one.
      await withSite(slug, async () => {
        const origin = siteUrl();
        if (origin && !getSetting('gscSite', null)) {
          const match = matchSite(await listSearchConsoleSites(), origin);
          if (match) setSetting('gscSite', match);
        }
      });
      return back(slug);
    } catch (err: any) {
      return back(slug, err.message);
    }
  });

  /** Asks each Google service separately, so a switched-off API is named instead of failing the whole page. */
  app.post('/api/google/test', async (_req, reply) => {
    if (!googleConnected()) return reply.code(400).send({ error: 'sign in with Google first' });
    const check = async (label: string, fn: () => Promise<string>) => {
      try {
        return { label, ok: true, message: await fn() };
      } catch (err: any) {
        return { label, ok: false, message: String(err.message) };
      }
    };
    return [
      await check('Search Console', async () => `${(await listSearchConsoleSites()).length} site(s) visible`),
      await check('Analytics', async () => `${(await listAnalyticsProperties()).length} property(ies) visible`),
    ];
  });

  app.post('/api/google/disconnect', async () => {
    disconnectGoogle();
    return { ok: true };
  });

  app.get('/api/google/options', async (_req, reply) => {
    try {
      const [sites, properties] = await Promise.all([listSearchConsoleSites(), listAnalyticsProperties()]);
      return { sites, properties };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.put<{ Body: { site?: string | null; property?: string | null } }>('/api/google/selection', async (req) => {
    if (req.body?.site !== undefined) setSetting('gscSite', req.body.site || null);
    if (req.body?.property !== undefined) setSetting('ga4Property', req.body.property || null);
    return { ok: true };
  });

  app.post('/api/google/pull', async () => pullAll());

  app.get<{ Querystring: { days?: string } }>('/api/results', async (req) => {
    const days = req.query.days === '7' ? 7 : 30;
    return {
      days,
      queries: topQueries(50, days),
      nearlyThere: searchConsoleGaps(topQueries(500, days), days === 7 ? 15 : 50).slice(0, 20),
      pages: topPages(30, days),
      published: publishedResults(new Date(), days),
      actions: actionResults(50),
      notes: [performanceNotes(), actionsNote()].filter(Boolean).join('\n\n') || null,
    };
  });

  app.get<{ Querystring: { days?: string } }>('/api/results/summary', async (req) => {
    // Lets the page say why visits are missing: not picked, or the last fetch failed.
    const last = getSetting<PullStatus | null>('lastPull', null);
    const summary = resultsSummary(req.query.days === '30' ? 30 : 7);
    // Marked on the charts, so a sudden change can be read against what Google did that day.
    const googleUpdates = summary.from && summary.to ? updatesBetween(summary.from, summary.to) : [];
    return { ...summary, googleUpdates, analytics: { property: getSetting<string | null>('ga4Property', null), error: last?.analytics?.error ?? null } };
  });

  // People on the site right now (GA4 realtime), for the top bar.
  app.get<{ Querystring: { by?: string } }>('/api/analytics/live', async (req) =>
    liveNow((req.query.by && req.query.by in LIVE_BREAKDOWNS ? req.query.by : 'page') as LiveBreakdown),
  );

  // ---- timetable, logs, budget, speed ----
  app.get('/api/tasks', async () => taskOverview());
  app.put<{ Params: { id: string }; Body: Partial<TaskSetting> }>('/api/tasks/:id', async (req, reply) => {
    try {
      const b = req.body ?? {};
      return updateTask(req.params.id, { ...(b.enabled !== undefined ? { enabled: !!b.enabled } : {}), ...(b.cron ? { cron: String(b.cron) } : {}), ...(b.limit !== undefined ? { limit: Number(b.limit) } : {}) });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/run', async (req, reply) => {
    if (!taskDefs().some((t) => t.id === req.params.id)) return reply.code(404).send({ error: 'no such task' });
    return runTask(req.params.id);
  });

  /** Plume's own log and every website's, for the website list. Not tied to one site. */
  app.get<{ Querystring: { site?: string; problems?: string; limit?: string } }>('/api/system-logs', async (req) =>
    systemLogs({ site: req.query.site, problems: req.query.problems === '1', limit: Math.min(Number(req.query.limit ?? 300), 1000) }),
  );
  app.get<{ Querystring: { source?: string; level?: Level; limit?: string } }>('/api/logs', async (req) =>
    recentLogs({ source: req.query.source, level: req.query.level, limit: Math.min(Number(req.query.limit ?? 200), 1000) }),
  );

  app.get('/api/budget', async () => budgetStatus());
  app.put<{ Body: { limit?: number } }>('/api/budget', async (req, reply) => {
    try {
      setBudgetLimit(Number(req.body?.limit));
      return budgetStatus();
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get('/api/speed', async () => lastSpeed());
  app.post<{ Body: { strategy?: string } }>('/api/speed/send', async (req, reply) => {
    const strategy = req.body?.strategy === 'desktop' ? 'desktop' : 'mobile';
    const fix = sendSpeedToSeo(strategy);
    return fix ? { fix } : reply.code(400).send({ error: `nothing to fix on ${strategy} — every measurement passes` });
  });

  // ---- what the agents know: competitors, people, profiles, notes, llms.txt ----
  const bad = (reply: any, err: any) => reply.code(400).send({ error: err.message });
  app.get('/api/context', async () => ({
    competitors: listCompetitors().map((c) => ({ ...c, lastChecked: lastChecked(c.id), socials: socialsOf(c.id), unseen: openChanges().filter((x) => x.competitorId === c.id).length })),
    suggestions: openSuggestions(),
    people: listPeople(),
    profiles: brandProfiles(),
    notes: userNotes(),
  }));
  app.post<{ Body: { name?: string; url?: string; notes?: string; watch?: boolean } }>('/api/competitors', async (req, reply) => {
    try {
      const c = addCompetitor({ name: req.body?.name ?? '', url: req.body?.url, notes: req.body?.notes, watch: req.body?.watch, source: 'user' });
      return c ?? reply.code(409).send({ error: 'that competitor is already on the list' });
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.put<{ Params: { id: string }; Body: { name?: string; url?: string; notes?: string; watch?: boolean } }>('/api/competitors/:id', async (req, reply) => {
    try {
      const b = req.body ?? {};
      return updateCompetitor(Number(req.params.id), { name: b.name, url: b.url, notes: b.notes, watch: b.watch === undefined ? undefined : !!b.watch });
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/competitors/:id', async (req) => (removeCompetitor(Number(req.params.id)), { ok: true }));
  app.post<{ Params: { id: string } }>('/api/competitors/:id/check', async (req, reply) => {
    const c = getCompetitor(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'no such competitor' });
    try {
      const changes = await checkCompetitor(c);
      return { changes, firstLook: !changes.length && lastChecked(c.id) !== null };
    } catch (err) {
      return bad(reply, err);
    } finally {
      await closeBrowser();
    }
  });
  app.get<{ Params: { id: string } }>('/api/competitors/:id/scans', async (req) => listScans(Number(req.params.id)));
  /** The paid part of the scan: news, LinkedIn and X. Runs now, for one competitor. */
  app.post<{ Params: { id: string } }>('/api/competitors/:id/scan-news', async (req, reply) => {
    const c = getCompetitor(Number(req.params.id));
    if (!c) return reply.code(404).send({ error: 'no such competitor' });
    try {
      return await scanNewsSocial(c);
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>('/api/competitor-suggestions/:id/add', async (req, reply) => {
    const s = getSuggestion(Number(req.params.id));
    if (!s) return reply.code(404).send({ error: 'that suggestion is gone' });
    try {
      const c = addCompetitor({ name: s.name, url: s.url, notes: s.reason, source: 'research' });
      settleSuggestion(s.id, 'added');
      return c ?? { ok: true };
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.post<{ Params: { id: string } }>('/api/competitor-suggestions/:id/dismiss', async (req) => (settleSuggestion(Number(req.params.id), 'dismissed'), { ok: true }));
  app.post('/api/competitors/fill', async (_req, reply) => {
    try {
      return { added: await extractCompetitors() };
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.post<{ Body: { id?: number; name?: string; role?: string; bio?: string; xHandle?: string; linkedinUrl?: string } }>('/api/people', async (req, reply) => {
    try {
      return savePerson({ ...(req.body ?? {}), name: req.body?.name ?? '' });
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/people/:id', async (req) => (removePerson(Number(req.params.id)), { ok: true }));
  app.put<{ Body: { x?: string; linkedin?: string; facebook?: string } }>('/api/profiles', async (req, reply) => {
    try {
      return setBrandProfiles(req.body ?? {});
    } catch (err) {
      return bad(reply, err);
    }
  });
  app.put<{ Body: { notes?: string } }>('/api/notes', async (req, reply) => {
    if (typeof req.body?.notes !== 'string') return reply.code(400).send({ error: 'notes must be text' });
    setUserNotes(req.body.notes);
    return { ok: true };
  });
  app.get('/api/tech', async () => techSignals());
  app.get('/api/llms-txt', async (_req, reply) => {
    const body = buildLlmsTxt();
    return body ? { body } : reply.code(404).send({ error: 'Plume has not read your site yet' });
  });
  app.get('/api/llms-txt/download', async (_req, reply) => {
    const body = buildLlmsTxt();
    return body ? reply.type('text/plain; charset=utf-8').header('content-disposition', 'attachment; filename="llms.txt"').send(body) : reply.code(404).send('not ready');
  });

  // ---- chat ----
  app.get('/api/chat', async () => ({ threads: listThreads(), suggestions: suggestions(), mentions: MENTIONS(), aiReady: !llmProblem(), aiProblem: llmProblem() }));
  app.get<{ Params: { id: string } }>('/api/chat/:id', async (req, reply) => {
    try {
      return showThread(Number(req.params.id));
    } catch (err: any) {
      return reply.code(404).send({ error: err.message });
    }
  });
  /** Start a chat (no id) or continue one. Answers at once; the reply is written in the background. */
  app.post<{ Body: { threadId?: number; text?: string } }>('/api/chat', async (req, reply) => {
    const text = (req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'write a message first' });
    if (text.length > 20_000) return reply.code(400).send({ error: 'that message is too long (keep it under 20,000 characters)' });
    const problem = llmProblem();
    if (problem) return reply.code(400).send({ error: problem });
    let id = req.body?.threadId;
    if (id && !getThread(id)) return reply.code(404).send({ error: 'that chat no longer exists' });
    if (id && isThreadRunning(id)) return reply.code(409).send({ error: 'the assistant is still answering — wait for it to finish' });
    if (!id) id = createThread(text).id;
    void sendMessage(id, text);
    return { threadId: id };
  });
  app.delete<{ Params: { id: string } }>('/api/chat/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (isThreadRunning(id)) return reply.code(409).send({ error: 'wait for the answer to finish before deleting this chat' });
    deleteThread(id);
    return { ok: true };
  });
  for (const [verb, fn] of [['apply', applyAction], ['discard', discardAction], ['undo', undoAction]] as const) {
    app.post<{ Params: { id: string } }>(`/api/chat/actions/:id/${verb}`, async (req, reply) => {
      try {
        return fn(Number(req.params.id));
      } catch (err: any) {
        return reply.code(400).send({ error: err.message });
      }
    });
  }

  // ---- rankings ----
  app.get<{ Querystring: { weeks?: string } }>('/api/rankings', async (req) => {
    const weeks = Math.min(52, Math.max(4, Number(req.query.weeks) || 12));
    const rows = rankingsTable(weeks);
    const metrics = savedMetrics(rows.map((r) => r.keyword));
    return {
      rows: rows.map((r) => ({ ...r, volume: metrics.get(r.keyword)?.volume ?? null, difficulty: metrics.get(r.keyword)?.difficulty ?? null })),
      suggestions: suggestKeywords(10),
      serp: describeSerp(),
      hasData: completeWeeks(1).length > 0,
      max: MAX_TRACKED,
      gaps: keywordGaps(15, listTracked().map((t) => t.keyword)),
      gapsAt: competitorKeywordsCheckedAt(),
      hasCompetitorSites: listCompetitors().some((c) => c.url),
    };
  });
  // Monthly searches and difficulty for every tracked search not looked up in the last month.
  app.post('/api/rankings/metrics', async (_req, reply) => {
    if (!serpCreds()) return reply.code(400).send({ error: 'add a DataForSEO login below first' });
    try {
      const { metrics, cost } = await keywordMetrics(listTracked().map((t) => t.keyword));
      return { looked: metrics.size, cost };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  // What the listed competitors are on page one for.
  app.post('/api/rankings/gaps', async (_req, reply) => {
    if (!serpCreds()) return reply.code(400).send({ error: 'add a DataForSEO login below first' });
    if (!listCompetitors().some((c) => c.url)) return reply.code(400).send({ error: 'add a website to at least one competitor first' });
    const r = await refreshCompetitorKeywords();
    if (r.failed && !r.checked) return reply.code(400).send({ error: r.failed });
    return r;
  });
  app.post<{ Body: { keyword?: string; keywords?: string[]; source?: 'user' | 'suggested' } }>('/api/rankings', async (req, reply) => {
    const list = req.body?.keywords ?? (req.body?.keyword !== undefined ? [req.body.keyword] : []);
    if (!list.length) return reply.code(400).send({ error: 'type a search term' });
    try {
      const added = list.map((k) => trackKeyword(k, req.body?.source === 'suggested' ? 'suggested' : 'user')).filter(Boolean);
      return { added: added.length, already: list.length - added.length };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.delete<{ Querystring: { keyword?: string } }>('/api/rankings', async (req, reply) => {
    try {
      untrackKeyword(req.query.keyword ?? '');
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.get<{ Querystring: { keyword?: string } }>('/api/rankings/serp', async (req, reply) => {
    try {
      return { serp: latestSerp(normalizeKeyword(req.query.keyword ?? '')) };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.post<{ Body: { keyword?: string } }>('/api/rankings/serp', async (req, reply) => {
    try {
      const k = normalizeKeyword(req.body?.keyword ?? '');
      if (!listTracked().some((t) => t.keyword === k)) return reply.code(400).send({ error: 'track this search first' });
      return await checkSerp(k);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.put<{ Body: { login?: string; password?: string; location?: string } }>('/api/serp', async (req, reply) => {
    try {
      if (req.body?.login !== undefined) saveSerpCreds(req.body.login, req.body.password ?? '');
      if (req.body?.location !== undefined) setSerpLocation(req.body.location);
      return describeSerp();
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.delete('/api/serp', async () => (clearSerpCreds(), describeSerp()));
  app.post<{ Params: { id: string } }>('/api/page-changes/:id/seen', async (req) => (pageChangeSeen(Number(req.params.id)), { ok: true }));
  app.post<{ Params: { id: string } }>('/api/rank-alerts/:id/seen', async (req) => (rankAlertSeen(Number(req.params.id)), { ok: true }));

  // ---- Dashboard ----
  app.get('/api/today', async () => ({ items: todayFeed(), ...todayProgress() }));
  app.post<{ Params: { id: string } }>('/api/changes/:id/seen', async (req) => (changeSeen(Number(req.params.id)), { ok: true }));
  app.post<{ Body: { key?: string } }>('/api/today/skip', async (req, reply) => {
    if (!req.body?.key) return reply.code(400).send({ error: 'key required' });
    skipItem(req.body.key);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/drafts/:id/not-useful', async (req, reply) => {
    try {
      notUseful(Number(req.params.id), req.body?.reason ?? null);
      return { ok: true };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });
  app.post('/api/speed', async (_req, reply) => {
    const url = siteUrl();
    if (!url) return reply.code(400).send({ error: 'add your site first' });
    const r = await runTask('speed');
    return r.status === 'done' ? lastSpeed() : reply.code(502).send({ error: r.message });
  });

  /** This site's AI spending, plus every site's total (the monthly limit covers them all together). */
  app.get('/api/usage', async () => {
    const g = getGlobalDb();
    const site = currentSite();
    return {
      budget: budgetStatus(),
      total: g.prepare('SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost FROM llm_calls WHERE site = ?').get(site),
      allSites: g.prepare('SELECT COUNT(*) calls, COALESCE(SUM(cost_usd),0) cost FROM llm_calls').get(),
      byPurpose: g
        .prepare('SELECT purpose, model, COUNT(*) calls, SUM(input_tokens) input, SUM(output_tokens) output, SUM(cost_usd) cost FROM llm_calls WHERE site = ? GROUP BY purpose, model ORDER BY cost DESC')
        .all(site),
    };
  });

  registerGeoRoutes(app);
  registerOutreachRoutes(app);
  registerPhoneRoutes(app);
  registerToolsRoutes(app);
  registerReportRoutes(app);

  return app;
}
