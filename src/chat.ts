import type Anthropic from '@anthropic-ai/sdk';
import { getDb, getGlobalDb, getSetting } from './db';
import { MODELS } from './config';
import { PROFILE_DOCS, ProfileDocId, agentSystem, isProfileDocId, readDoc, writeDoc } from './context/profile';
import { addCompetitor, listCompetitors, removeCompetitor, setUserNotes, userNotes } from './context/extra';
import { chatSearchTools, converse, runLocalTool } from './llm/client';
import { createDraft, getDraft, listDrafts } from './queue';
import { todayFeed } from './today';
import { AGENTS, startAgentRun } from './agents';
import { AuditResult } from './agents/seoAudit';
import { lastSpeed } from './analytics/pagespeed';
import { deviceSplit, publishedResults, resultsSummary, topPages, topQueries } from './analytics/results';
import { googleConnected } from './analytics/google';
import { LIVE_BREAKDOWNS, LiveBreakdown, liveNow } from './analytics/live';
import type { PullStatus } from './analytics/pull';
import { describeIntegrations } from './integrations';
import { openAlerts, rankingsTable } from './seo/rankings';
import { openGaps, visibilitySummary } from './geo/visibility';
import { STATUSES, listContacts, summary as outreachSummary } from './outreach/store';
import { searchConsoleGaps } from './agents/seo';
import { checkCompetitor, listScans, openChanges, openSuggestions, scanNewsSocial } from './watch';
import { closeBrowser } from './research/fetchPage';
import { finishJob, getJob, runningJob, startJob, updateJob } from './jobs';
import { startPageRefresh } from './research/refresh';
import { lineDiff, diffStats } from './diff';
import { renderMarkdown } from './render';
import { currentSite } from './site';
import { log } from './log';
import { actionResults, auditHistory, describeResult, recordAction } from './actions';

/**
 * The chat assistant: a conversation per thread, with tools that read the site's data and propose work.
 * Rules that keep it safe:
 * - it never changes a document itself — it proposes, the owner applies;
 * - drafts it writes go to the Dashboard for approval like any agent's;
 * - it starts paid agent runs only when the owner asked;
 * - the stored history is only ever appended to (newer models reject edited history), and the
 *   system prompt is frozen when the thread starts. Later facts reach the model as notes on the next message.
 */

export const MAX_ROUNDS = 12;
const NOTE_TAG = '<context-update>';

const DOC_IDS = [...PROFILE_DOCS.map((d) => d.id), 'notes'] as const;
type ChatDoc = ProfileDocId | 'notes';

const ROLE = `You are the marketing lead for this business, talking with its owner in a chat inside Plume, their marketing workspace.
Be direct and practical; write in plain English unless the owner writes in another language. Keep answers short unless asked for depth.

How to work:
- Look things up with your tools instead of guessing (today's queue, Google search results, visitors and devices, live visitors, rankings, AI visibility, outreach, site health, competitors, documents).
- Never say something isn't connected without checking get_connections first.
- To change a document, call propose_document_change with the complete new text. The owner sees the difference and applies it — never say a document is changed until they have applied it.
- To produce a post or article, call create_draft. It goes to the owner's Dashboard for approval; nothing is published by you.
- Only call run_agent when the owner explicitly asks for an agent to run — runs cost money.
- The owner may mention @seo, @writer (agents) or @doc:product, @doc:voice, … (documents); treat these as pointers to what they mean.
- Messages that start with ${NOTE_TAG} are facts from Plume about what happened since your last turn (applied changes, finished jobs). Trust them over your earlier assumptions.`;

// ---------------------------------------------------------------- tools

const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'read_document',
    description: 'Read the current full text of one business document. Documents may have changed since the chat started.',
    input_schema: { type: 'object', additionalProperties: false, required: ['doc'], properties: { doc: { type: 'string', enum: [...DOC_IDS] } } },
  },
  {
    name: 'propose_document_change',
    description: 'Propose a new version of a document. Give the COMPLETE new text, not a fragment. The owner reviews the difference and applies or discards it.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['doc', 'new_text', 'summary'],
      properties: {
        doc: { type: 'string', enum: [...DOC_IDS] },
        new_text: { type: 'string', description: 'The whole document as it should read after the change, in Markdown.' },
        summary: { type: 'string', description: 'One sentence: what changes and why.' },
      },
    },
  },
  {
    name: 'create_draft',
    description: "Put a finished piece of writing onto the owner's Dashboard for approval.",
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'title', 'body', 'reason'],
      properties: {
        kind: { type: 'string', enum: ['blog_post', 'article', 'landing_page', 'social_post'] },
        channel: { type: 'string', enum: ['x', 'linkedin', 'facebook', 'other'], description: 'For social_post only.' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown. For blog posts, articles and pages start with "# " + title.' },
        reason: { type: 'string', description: 'One sentence shown to the owner: why this piece, why now.' },
      },
    },
  },
  {
    name: 'run_agent',
    description: 'Start an agent run in the background (it finds work and writes drafts). Costs money — only when the owner asked.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['agent'],
      properties: { agent: { type: 'string', enum: AGENTS.map((a) => a.id) }, how_many: { type: 'integer', minimum: 1, maximum: 5 } },
    },
  },
  {
    name: 'refresh_pages',
    description: "Re-read the website's pages now (up to 40) and re-run the site check. Free, runs in the background. Pages that no longer exist are removed from the saved copy.",
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  { name: 'get_today', description: "What is waiting on the owner's Dashboard: drafts, site fixes, speed problems, competitor changes.", input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  {
    name: 'get_results',
    description: 'Google Search Console and Analytics results: top searches, searches close to page one, how published work is doing.',
    input_schema: { type: 'object', additionalProperties: false, properties: { days: { type: 'integer', enum: [7, 30] } } },
  },
  {
    name: 'get_traffic',
    description:
      'Google Analytics and Search Console totals for the site: visitors, sessions, views, clicks, compared with the period before; channels and sites that sent visitors; top pages and landing pages; countries; and devices (search clicks by mobile/desktop/tablet, visitors by device and system such as Android, iOS, Windows).',
    input_schema: { type: 'object', additionalProperties: false, properties: { days: { type: 'integer', enum: [7, 30] } } },
  },
  {
    name: 'get_live_visitors',
    description: 'People on the site in the last hour (or 30 minutes), from Google Analytics realtime, split by page, country or device.',
    input_schema: { type: 'object', additionalProperties: false, properties: { by: { type: 'string', enum: Object.keys(LIVE_BREAKDOWNS) } } },
  },
  { name: 'get_rankings', description: 'Tracked Google searches: our position each week, the change, clicks, who ranks above us, and big moves.', input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'get_ai_visibility', description: 'Whether AI assistants (ChatGPT, Claude, Gemini) name us when asked our questions, who they name instead, and the gaps.', input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'get_outreach', description: 'Outreach lists: creators and link opportunities, how many are at each step, and the latest ones.', input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'get_connections', description: 'Which services this website is connected to (Google Search Console and Analytics with the chosen site/property and last data pull, publishing, social, phone, outreach).', input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'get_site_health', description: 'Latest site check (score, top problems) and page speed for phones and computers.', input_schema: { type: 'object', additionalProperties: false, properties: {} } },
  {
    name: 'list_competitors',
    description:
      'The competitor list with notes, the result of the latest scans (baseline / changed / unchanged, each finding with its source link), and competitors the scan suggested adding.',
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'scan_competitors',
    description:
      'Scan competitors now, in the background: their website (new pages, prices, headline — free) and, with include_news, news and their LinkedIn/X posts (costs money — only when the owner asked). Leave competitor out to scan every watched one.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: { competitor: { type: 'string', description: 'Name of one competitor; omit for all watched.' }, include_news: { type: 'boolean' } },
    },
  },
  {
    name: 'add_competitor',
    description: 'Add a competitor to the list (the owner can undo it).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: { name: { type: 'string' }, website: { type: 'string' }, notes: { type: 'string' } },
    },
  },
];

export interface ChatAction {
  id: number;
  threadId: number;
  kind: 'doc-change' | 'draft' | 'job' | 'competitor';
  data: any;
  status: 'pending' | 'applied' | 'discarded' | 'done' | 'undone';
  at: string;
}

function createAction(threadId: number, kind: ChatAction['kind'], data: object, status: ChatAction['status']): number {
  return Number(
    getDb().prepare('INSERT INTO chat_actions (thread_id, kind, data, status, at) VALUES (?, ?, ?, ?, ?)').run(threadId, kind, JSON.stringify(data), status, new Date().toISOString()).lastInsertRowid,
  );
}

function readChatDoc(doc: ChatDoc): string {
  return doc === 'notes' ? userNotes() : (readDoc(doc) ?? '');
}

function docTitle(doc: ChatDoc): string {
  return doc === 'notes' ? 'Your notes' : PROFILE_DOCS.find((d) => d.id === doc)!.title;
}

const str = (v: unknown, max = 200_000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Why there are no Google numbers, in the owner's words: not signed in, nothing picked, or the last pull failed. */
function googleMissing(need: 'search' | 'any'): string {
  if (!googleConnected()) return 'Google is not connected for this website, so there is no Search Console or Analytics data.';
  const site = getSetting<string | null>('gscSite', null);
  const property = getSetting<string | null>('ga4Property', null);
  const last = getSetting<PullStatus | null>('lastPull', null);
  if (!site && (need === 'search' || !property)) return 'Google is connected, but no Search Console site is picked for this website yet (Results page).';
  const err = last?.searchConsole.error ?? last?.analytics.error;
  if (err) return `Google is connected, but the last data pull failed: ${err}`;
  if (!last?.at) return 'Google is connected, but no data has been pulled yet. It is pulled once a day, or now from the Results page.';
  return 'Google is connected and pulled, but there are no rows for this period.';
}

/** Run one of the chat's own tools. Returns text for the model; never throws. */
export async function runChatTool(threadId: number, name: string, input: any, toolUseId: string): Promise<{ content: string; isError: boolean }> {
  try {
    switch (name) {
      case 'read_document': {
        const doc = input?.doc as ChatDoc;
        if (!(DOC_IDS as readonly string[]).includes(doc)) return { content: `unknown document "${doc}"`, isError: true };
        return { content: readChatDoc(doc) || '(this document is empty)', isError: false };
      }
      case 'propose_document_change': {
        const doc = input?.doc as ChatDoc;
        if (!(DOC_IDS as readonly string[]).includes(doc)) return { content: `unknown document "${doc}"`, isError: true };
        const after = str(input?.new_text).trim();
        if (!after) return { content: 'new_text is empty — give the complete new document', isError: true };
        const before = readChatDoc(doc);
        if (after === before.trim()) return { content: 'that is the same as the current text; nothing to propose', isError: true };
        const id = createAction(threadId, 'doc-change', { doc, before, after, summary: str(input?.summary, 500), toolUseId }, 'pending');
        return { content: `Proposed as change #${id}. The owner will see it and apply or discard it.`, isError: false };
      }
      case 'create_draft': {
        const kind = ['blog_post', 'article', 'landing_page', 'social_post'].includes(input?.kind) ? input.kind : 'article';
        const title = str(input?.title, 300).trim();
        const body = str(input?.body).trim();
        if (!title || !body) return { content: 'title and body are required', isError: true };
        const channel = kind === 'social_post' && ['x', 'linkedin', 'facebook'].includes(input?.channel) ? input.channel : undefined;
        const d = createDraft({ agent: 'chat', kind, title, body, meta: { reason: str(input?.reason, 500) || 'Written in chat', channel, chatThread: threadId } });
        createAction(threadId, 'draft', { draftId: d.id, title, toolUseId }, 'done');
        return { content: `Draft #${d.id} is on the owner's Dashboard for approval.`, isError: false };
      }
      case 'run_agent': {
        const agent = String(input?.agent ?? '');
        const n = Math.min(5, Math.max(1, Number(input?.how_many) || 1));
        const jobId = startAgentRun(agent, n); // throws a plain reason when it can't start
        createAction(threadId, 'job', { jobId, agent, howMany: n, toolUseId }, 'done');
        return { content: `Started the ${agent} agent (job ${jobId}, up to ${n} draft(s)). Its drafts will appear on the Dashboard when it finishes.`, isError: false };
      }
      case 'refresh_pages': {
        const jobId = startPageRefresh(); // throws a plain reason when it can't start
        createAction(threadId, 'job', { jobId, label: 'Re-read pages', doneText: 'finished — the saved pages and site check are up to date', toolUseId }, 'done');
        return { content: `Started re-reading the site (job ${jobId}). It takes a minute or two; the owner can watch the progress on the card.`, isError: false };
      }
      case 'get_today': {
        const items = todayFeed();
        if (!items.length) return { content: 'Nothing is waiting.', isError: false };
        return {
          content: items
            .map((i) =>
              i.kind === 'draft'
                ? `- Draft #${i.draft.id} by ${i.draft.agent}: "${i.draft.title}" (${i.draft.words} words)${i.draft.meta.reason ? ` — ${i.draft.meta.reason}` : ''}`
                : i.kind === 'fix'
                  ? `- Site fix (${i.fix.severity}): ${i.fix.title} on ${i.fix.url}`
                  : i.kind === 'speed'
                    ? `- Speed (${i.strategy}, score ${i.performance}): ${i.headline}`
                    : i.kind === 'rank'
                      ? `- Ranking move: "${i.alert.keyword}" went from position ${i.alert.from} to ${i.alert.to} (week of ${i.alert.week})${i.googleUpdates.length ? `; Google was rolling out ${i.googleUpdates.map((u) => `the ${u.name} (${u.date})`).join(' and ')} then` : ''}`
                      : i.kind === 'page-change'
                        ? `- Our own pages changed since the last read: ${i.change.changes.map((c) => `${c.url}: ${c.text}`).join('; ')}`
                      : i.kind === 'ai-gap'
                        ? `- AI gap: asked "${i.gap.question}", ${i.gap.engines} AI assistant(s) recommended ${i.gap.namedInstead.join(', ')} and not us`
                        : `- Competitor change: ${i.change.name} ${i.change.changes.map((c) => c.text).join('; ')}`,
            )
            .join('\n'),
          isError: false,
        };
      }
      case 'get_results': {
        const days = input?.days === 7 ? 7 : 30;
        const q = topQueries(30, days);
        if (!q.length) return { content: googleMissing('search'), isError: false };
        const near = searchConsoleGaps(topQueries(500, days), days === 7 ? 15 : 50).slice(0, 10);
        const mine = publishedResults(new Date(), days).slice(0, 10);
        const done = actionResults(15);
        return {
          content: [
            `Last ${days} days.`,
            'Top searches:',
            ...q.slice(0, 15).map((r) => `- "${r.query}": ${r.clicks} clicks, ${r.impressions} impressions, position ${r.position.toFixed(1)}`),
            near.length ? 'Close to page one:' : '',
            ...near.map((o) => `- "${o.keyword}": ${o.impressions} impressions, position ${Number(o.position).toFixed(1)}`),
            mine.length ? 'Published by Plume:' : '',
            ...mine.map((m) => `- "${m.title}": ${m.clicks} clicks, ${m.impressions} impressions${m.position ? `, position ${m.position.toFixed(1)}` : ''}`),
            ...(done.length ? ['What was done and what happened afterwards:', ...done.map(describeResult)] : []),
          ]
            .filter(Boolean)
            .join('\n'),
          isError: false,
        };
      }
      case 'get_traffic': {
        const days = input?.days === 7 ? 7 : 30;
        const s = resultsSummary(days);
        const dev = deviceSplit(days);
        if (!s.from && !dev.search.length && !dev.visits.length) return { content: googleMissing('any'), isError: false };
        const n = (v: number | null | undefined) => (v == null ? 'n/a' : Math.round(v).toLocaleString('en-US'));
        const vs = (a: number | null, b: number | null, ok: boolean) => (ok && a != null && b ? ` (before: ${n(b)}, ${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%)` : '');
        const pct = (part: number, all: number) => (all ? `${Math.round((100 * part) / all)}%` : '');
        const clicks = dev.search.reduce((t, r) => t + r.clicks, 0);
        const users = dev.visits.reduce((t, r) => t + r.users, 0);
        const lines = [
          `Last ${days} days${s.from ? ` (${s.from} to ${s.to})` : ''}.`,
          `Search: ${n(s.now.clicks)} clicks${vs(s.now.clicks, s.before.clicks, s.compare.search)}, ${n(s.now.impressions)} impressions, average position ${s.now.position?.toFixed(1) ?? 'n/a'}.`,
          s.now.users != null || s.now.views != null
            ? `Visits: ${n(s.now.users)} visitors${vs(s.now.users, s.before.users, s.compare.visits)}, ${n(s.now.sessions)} sessions, ${n(s.now.views)} page views${s.now.engagement != null ? `, ${Math.round(s.now.engagement * 100)}% engaged` : ''}${s.now.keyEvents != null ? `, ${s.now.keyEvents} key events` : ''}.`
            : 'Visits: no Analytics data.',
          ...(dev.search.length ? ['Search clicks by device:', ...dev.search.map((r) => `- ${r.device}: ${n(r.clicks)} clicks (${pct(r.clicks, clicks)}), ${n(r.impressions)} impressions, position ${r.position?.toFixed(1) ?? 'n/a'}`)] : []),
          ...(dev.visits.length ? ['Visitors by device and system:', ...dev.visits.map((r) => `- ${r.device} / ${r.os}: ${n(r.users)} visitors (${pct(r.users, users)})`)] : []),
          ...(s.channels.length ? ['Visitors by channel:', ...s.channels.map((c) => `- ${c.label}: ${n(c.users)}`)] : []),
          ...(s.topSources.length ? ['Sites that sent visitors:', ...s.topSources.map((c) => `- ${c.label}: ${n(c.users)}`)] : []),
          ...(s.landing.length ? ['First page of the visit:', ...s.landing.map((c) => `- ${c.label}: ${n(c.users)} visitors`)] : []),
          ...(s.pages.length ? ['Most viewed pages:', ...s.pages.map((p) => `- ${p.page}: ${n(p.views)} views`)] : []),
          ...(s.countries.length ? ['Search clicks by country:', ...s.countries.map((c) => `- ${c.country}: ${n(c.clicks)}`)] : []),
        ];
        const top = topPages(10, days).filter((p) => p.clicks > 0);
        if (top.length) lines.push('Pages by search clicks:', ...top.map((p) => `- ${p.page}: ${p.clicks} clicks, ${p.impressions} impressions`));
        if (!dev.search.length && !dev.visits.length) lines.push('No device data yet: it arrives with the next Google pull.');
        return { content: lines.join('\n'), isError: false };
      }
      case 'get_live_visitors': {
        const by = (input?.by in LIVE_BREAKDOWNS ? input.by : 'page') as LiveBreakdown;
        const live = await liveNow(by);
        if (live.missing === 'google') return { content: 'Google is not connected for this website.', isError: false };
        if (live.missing === 'property') return { content: 'Google is connected, but no Analytics property is picked for this website (Results page).', isError: false };
        if (live.missing === 'error') return { content: `Google refused the realtime report: ${live.error}`, isError: false };
        return {
          content: [`${live.total} people on the site in the last ${live.minutes} minutes.`, ...live.rows.map((r) => `- ${r.label}: ${r.users}`)].join('\n'),
          isError: false,
        };
      }
      case 'get_rankings': {
        const rows = rankingsTable(8);
        if (!rows.length) return { content: 'No searches are tracked yet (Rankings page).', isError: false };
        const alerts = openAlerts();
        return {
          content: [
            'Tracked searches (position: smaller is better; change: positive moved up):',
            ...rows.map((r) => `- "${r.keyword}": ${r.current?.position != null ? `position ${r.current.position.toFixed(1)} (week of ${r.current.week})` : 'no impressions yet'}${r.change != null ? `, change ${r.change > 0 ? '+' : ''}${r.change}` : ''}, ${r.clicks} clicks over 8 weeks${r.serp?.above.length ? `; above us: ${r.serp.above.join(', ')}` : ''}`),
            ...(alerts.length ? ['Big moves:', ...alerts.map((a) => `- "${a.keyword}" from ${a.from} to ${a.to} (week of ${a.week})`)] : []),
          ].join('\n'),
          isError: false,
        };
      }
      case 'get_ai_visibility': {
        const v = visibilitySummary();
        if (!v) return { content: 'No AI visibility check has run yet (AI visibility page).', isError: false };
        const gaps = openGaps();
        return {
          content: [
            `Latest check ${v.at.slice(0, 10)}: named in ${v.overall.mentioned} of ${v.overall.answered} answers (${v.overall.score}%)${v.overall.avgPosition != null ? `, average position ${v.overall.avgPosition}` : ''}.`,
            ...v.perEngine.map((e) => `- ${e.label}: ${e.mentioned}/${e.answered}`),
            'Named most often:',
            ...v.shareOfVoice.map((x) => `- ${x.name}: ${x.answers} answers`),
            ...(gaps.length ? ['Questions where others were named and we were not:', ...gaps.map((g) => `- "${g.question}": ${g.namedInstead.join(', ')}`)] : []),
          ].join('\n'),
          isError: false,
        };
      }
      case 'get_outreach': {
        const lines: string[] = [];
        for (const kind of Object.keys(STATUSES) as (keyof typeof STATUSES)[]) {
          const counts = outreachSummary(kind);
          const total = Object.values(counts).reduce((a, b) => a + b, 0);
          lines.push(`${kind === 'creator' ? 'Creators' : 'Link opportunities'}: ${total}${total ? ` (${Object.entries(counts).filter(([, c]) => c).map(([st, c]) => `${c} ${st}`).join(', ')})` : ''}`);
          lines.push(...listContacts(kind).slice(0, 8).map((c) => `- ${c.name} (${c.status})${c.url ? ` ${c.url}` : ''}${c.why ? `: ${c.why.slice(0, 120)}` : ''}`));
        }
        return { content: lines.join('\n'), isError: false };
      }
      case 'get_connections': {
        const last = getSetting<PullStatus | null>('lastPull', null);
        const site = getSetting<string | null>('gscSite', null);
        const property = getSetting<string | null>('ga4Property', null);
        const lines = [
          `Google: ${googleConnected() ? 'signed in' : 'not connected'}. Search Console site: ${site ?? 'none picked'}. Analytics property: ${property ?? 'none picked'}.`,
          last?.at ? `Last Google pull ${last.at.slice(0, 16).replace('T', ' ')}: Search Console ${last.searchConsole.error ? `failed (${last.searchConsole.error})` : `${last.searchConsole.rows} rows`}, Analytics ${last.analytics.error ? `failed (${last.analytics.error})` : `${last.analytics.rows} rows`}.` : 'Google data has never been pulled.',
          'Other connections:',
          ...describeIntegrations().filter((i) => i.id !== 'google').map((i) => `- ${i.label}: ${i.connected ? 'connected' : 'not connected'}`),
        ];
        return { content: lines.join('\n'), isError: false };
      }
      case 'get_site_health': {
        const audit = getSetting<AuditResult | null>('lastAudit', null);
        const speed = lastSpeed();
        const lines: string[] = [];
        if (audit) {
          lines.push(`Site check: ${audit.score}/100 on ${audit.pagesChecked} pages (${audit.counts.critical} critical, ${audit.counts.warnings} warnings).`);
          lines.push(...audit.issues.slice(0, 8).map((i) => `- ${i.severity}: ${i.title} (${i.url})`));
          const hist = auditHistory(10);
          if (hist.length > 1) lines.push(`Score over the last ${hist.length} checks: ${hist.map((h) => `${h.score} (${h.day})`).join(' → ')}.`);
          const fixed = actionResults(30).filter((a) => a.kind === 'fix-done').slice(0, 8);
          if (fixed.length) lines.push('Fixes the owner marked done:', ...fixed.map(describeResult));
        } else lines.push('No site check yet.');
        for (const k of ['mobile', 'desktop'] as const) {
          const r = speed[k];
          if (r) lines.push(`${k === 'mobile' ? 'Phones' : 'Computers'}: performance ${r.scores.performance}, SEO ${r.scores.seo}. ${r.headline ?? 'All loading measurements pass.'}${r.opportunities[0] ? ` Biggest fix: ${r.opportunities[0].title}.` : ''}`);
        }
        return { content: lines.join('\n'), isError: false };
      }
      case 'list_competitors': {
        const comps = listCompetitors();
        const changes = openChanges();
        const suggestions = openSuggestions();
        if (!comps.length) return { content: 'No competitors listed yet.', isError: false };
        const scanLine = (c: (typeof comps)[number]) =>
          (['site', 'news-social'] as const)
            .map((scope) => {
              const last = listScans(c.id, 20).find((x) => x.scope === scope);
              return last ? `  ${scope === 'site' ? 'Website' : 'News & social'} scan ${last.at.slice(0, 10)}: ${last.outcome}` : `  ${scope === 'site' ? 'Website' : 'News & social'}: never scanned`;
            })
            .join('\n');
        return {
          content: [
            ...comps.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ''}${c.watch ? ' [watched]' : ''}${c.notes ? `: ${c.notes}` : ''}\n${scanLine(c)}`),
            ...(changes.length
              ? ['Findings not yet seen by the owner:', ...changes.flatMap((c) => c.changes.map((x) => `- ${c.name}: ${x.text}${x.url ? ` — ${x.url}` : ''}`))]
              : []),
            ...(suggestions.length ? ['Suggested competitors (not on the list yet):', ...suggestions.map((s) => `- ${s.name}${s.url ? ` (${s.url})` : ''}: ${s.reason}`)] : []),
          ].join('\n'),
          isError: false,
        };
      }
      case 'scan_competitors': {
        const want = str(input?.competitor, 200).toLowerCase();
        const pool = listCompetitors();
        const targets = want ? pool.filter((c) => c.name.toLowerCase().includes(want)) : pool.filter((c) => c.watch);
        if (!targets.length) return { content: want ? `No competitor called "${input?.competitor}".` : 'No competitors are being watched. Name one to scan it.', isError: true };
        if (runningJob('competitor-scan')) return { content: 'A competitor scan is already running.', isError: true };
        const news = !!input?.include_news;
        const jobId = startJob('competitor-scan', `Scanning ${targets.length} competitor(s)`);
        (async () => {
          const notes: string[] = [];
          try {
            for (const c of targets) {
              updateJob(jobId, `Scanning ${c.name}`);
              if (c.url) {
                const ch = await checkCompetitor(c);
                const last = listScans(c.id, 1)[0];
                notes.push(`${c.name} website: ${last?.outcome ?? 'checked'}${ch.length ? ` (${ch.length} change${ch.length > 1 ? 's' : ''})` : ''}`);
              }
              if (news) {
                const r = await scanNewsSocial(c);
                notes.push(`${c.name} news & social: ${r.outcome}${r.findings.length ? ` (${r.findings.length} finding${r.findings.length > 1 ? 's' : ''})` : ''}`);
              }
            }
            updateJob(jobId, notes.join(' · '));
            finishJob(jobId);
          } catch (err: any) {
            finishJob(jobId, String(err?.message ?? err));
          } finally {
            await closeBrowser();
          }
        })();
        createAction(threadId, 'job', { jobId, label: `Competitor scan (${targets.map((c) => c.name).join(', ')})`, doneText: 'finished — findings are on the Dashboard and on each competitor', toolUseId }, 'done');
        return { content: `Started scanning ${targets.map((c) => c.name).join(', ')} (job ${jobId})${news ? ', including news and social' : ', website only'}. Results go to the Dashboard; call list_competitors afterwards to read them.`, isError: false };
      }
      case 'add_competitor': {
        const c = addCompetitor({ name: str(input?.name, 200), url: str(input?.website, 300) || null, notes: str(input?.notes, 1000), source: 'user' });
        if (!c) return { content: 'That competitor is already on the list.', isError: false };
        createAction(threadId, 'competitor', { competitorId: c.id, name: c.name, toolUseId }, 'done');
        return { content: `Added ${c.name} to the competitor list.`, isError: false };
      }
    }
    return { content: `unknown tool ${name}`, isError: true };
  } catch (err: any) {
    return { content: String(err?.message ?? err), isError: true };
  }
}

// ---------------------------------------------------------------- threads and messages

export interface Thread {
  id: number;
  title: string;
  running: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function threadRow(r: any): Thread {
  return { id: r.id, title: r.title, running: !!r.running, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listThreads(limit = 30): Thread[] {
  return getDb().prepare('SELECT * FROM chat_threads ORDER BY updated_at DESC LIMIT ?').all(limit).map(threadRow);
}

export function getThread(id: number): Thread | undefined {
  const r = getDb().prepare('SELECT * FROM chat_threads WHERE id = ?').get(id);
  return r ? threadRow(r) : undefined;
}

export function deleteThread(id: number): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE thread_id = ?').run(id);
    db.prepare('DELETE FROM chat_actions WHERE thread_id = ?').run(id);
    db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id);
  })();
}

/** The system prompt, frozen per thread: business documents (cached), extra context, results, then the role. */
function freshSystem(): Anthropic.Beta.BetaTextBlockParam[] {
  return agentSystem(ROLE, undefined, undefined, 'chat');
}

export function createThread(firstMessage: string): Thread {
  const now = new Date().toISOString();
  const title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 70) || 'New chat';
  const r = getDb().prepare('INSERT INTO chat_threads (title, system, created_at, updated_at) VALUES (?, ?, ?, ?)').run(title, JSON.stringify(freshSystem()), now, now);
  return getThread(Number(r.lastInsertRowid))!;
}

interface StoredMessage {
  id: number;
  role: 'user' | 'assistant';
  kind: 'text' | 'assistant' | 'tool';
  content: any[];
  at: string;
}

function storedMessages(threadId: number): StoredMessage[] {
  return (getDb().prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id').all(threadId) as any[]).map((r) => ({ id: r.id, role: r.role, kind: r.kind, content: JSON.parse(r.content), at: r.at }));
}

function appendMessage(threadId: number, role: 'user' | 'assistant', kind: StoredMessage['kind'], content: any[]): void {
  const now = new Date().toISOString();
  getDb().prepare('INSERT INTO chat_messages (thread_id, role, kind, content, at) VALUES (?, ?, ?, ?, ?)').run(threadId, role, kind, JSON.stringify(content), now);
  getDb().prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now, threadId);
}

/** Queue a fact for the model's next turn ("the owner applied change #3"). */
export function addNote(threadId: number, note: string): void {
  const r = getDb().prepare('SELECT notes FROM chat_threads WHERE id = ?').get(threadId) as { notes: string } | undefined;
  if (!r) return;
  getDb().prepare('UPDATE chat_threads SET notes = ? WHERE id = ?').run(JSON.stringify([...JSON.parse(r.notes), note]), threadId);
}

function takeNotes(threadId: number): string[] {
  const r = getDb().prepare('SELECT notes FROM chat_threads WHERE id = ?').get(threadId) as { notes: string };
  getDb().prepare(`UPDATE chat_threads SET notes = '[]' WHERE id = ?`).run(threadId);
  return JSON.parse(r.notes);
}

/** Answer tool calls left without results (the run was cut off), so the history stays valid. */
function repairDangling(threadId: number): void {
  const msgs = storedMessages(threadId);
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'assistant') return;
  const pending = last.content.filter((b) => b.type === 'tool_use');
  if (!pending.length) return;
  appendMessage(
    threadId,
    'user',
    'tool',
    pending.map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: 'This step was interrupted before it ran. Do it again if it is still needed.', is_error: true })),
  );
}

const running = new Set<string>();
const runKey = (threadId: number) => `${currentSite()}|${threadId}`;

/**
 * Add the owner's message and let the assistant work until it has answered.
 * Resolves when the reply is finished; the web page polls the thread meanwhile.
 */
export async function sendMessage(threadId: number, text: string): Promise<void> {
  const key = runKey(threadId);
  if (running.has(key)) throw new Error('the assistant is still answering — wait for it to finish');
  const thread = getDb().prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as any;
  if (!thread) throw new Error(`no chat ${threadId}`);
  running.add(key);
  getDb().prepare('UPDATE chat_threads SET running = 1, error = NULL WHERE id = ?').run(threadId);
  try {
    repairDangling(threadId);
    const notes = takeNotes(threadId);
    const content: any[] = [];
    if (notes.length) content.push({ type: 'text', text: `${NOTE_TAG}\n${notes.map((n) => `- ${n}`).join('\n')}` });
    content.push({ type: 'text', text });
    appendMessage(threadId, 'user', 'text', content);
    await runLoop(threadId, JSON.parse(thread.system));
  } catch (err: any) {
    const message = String(err?.message ?? err);
    getDb().prepare('UPDATE chat_threads SET error = ? WHERE id = ?').run(message, threadId);
    log('warn', 'chat', `chat ${threadId}: ${message}`);
  } finally {
    getDb().prepare('UPDATE chat_threads SET running = 0 WHERE id = ?').run(threadId);
    running.delete(key);
  }
}

async function runLoop(threadId: number, system: Anthropic.Beta.BetaTextBlockParam[]): Promise<void> {
  const search = chatSearchTools();
  const tools: Anthropic.Beta.BetaToolUnion[] = [...TOOLS, ...search.tools];
  const sources: string[] = [];
  for (let round = 0; round <= MAX_ROUNDS; round++) {
    const messages = storedMessages(threadId).map((m) => ({ role: m.role, content: m.content })) as Anthropic.Beta.BetaMessageParam[];
    const msg = await converse({ purpose: `chat:${threadId}`, model: MODELS.draft, system, messages, tools, noMoreTools: round === MAX_ROUNDS });
    appendMessage(threadId, 'assistant', 'assistant', msg.content as any[]);
    if (msg.stop_reason === 'refusal') throw new Error('the model declined to answer that');
    if (msg.stop_reason === 'pause_turn') continue; // a long server-side search: let it carry on
    if (msg.stop_reason !== 'tool_use') return;
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const c of calls) {
      const r = search.local && (c.name === 'web_search' || c.name === 'read_page') ? await runLocalTool(c.name, c.input, sources) : await runChatTool(threadId, c.name, c.input, c.id);
      results.push({ type: 'tool_result', tool_use_id: c.id, content: r.content, is_error: r.isError });
    }
    appendMessage(threadId, 'user', 'tool', results);
  }
}

// ---------------------------------------------------------------- actions the owner takes

export function getAction(id: number): ChatAction | undefined {
  const r = getDb().prepare('SELECT * FROM chat_actions WHERE id = ?').get(id) as any;
  return r ? { id: r.id, threadId: r.thread_id, kind: r.kind, data: JSON.parse(r.data), status: r.status, at: r.at } : undefined;
}

function setActionStatus(id: number, status: ChatAction['status']): void {
  getDb().prepare('UPDATE chat_actions SET status = ? WHERE id = ?').run(status, id);
}

/** Apply a proposed document change — only if the document hasn't changed since it was proposed. */
export function applyAction(id: number): ChatAction {
  const a = getAction(id);
  if (!a || a.kind !== 'doc-change') throw new Error('no such proposed change');
  if (a.status !== 'pending') throw new Error(`this change was already ${a.status}`);
  const doc = a.data.doc as ChatDoc;
  if (readChatDoc(doc) !== a.data.before) throw new Error(`${docTitle(doc)} has changed since this was proposed — ask the assistant to propose it again`);
  if (doc === 'notes') setUserNotes(a.data.after);
  else writeDoc(doc, a.data.after);
  recordAction({ kind: 'doc-edited', ref: doc, title: docTitle(doc), data: { via: 'chat' } });
  setActionStatus(id, 'applied');
  addNote(a.threadId, `The owner applied change #${id} to "${docTitle(doc)}". It now reads as you proposed.`);
  return getAction(id)!;
}

export function discardAction(id: number): ChatAction {
  const a = getAction(id);
  if (!a || a.kind !== 'doc-change') throw new Error('no such proposed change');
  if (a.status !== 'pending') throw new Error(`this change was already ${a.status}`);
  setActionStatus(id, 'discarded');
  addNote(a.threadId, `The owner discarded change #${id} to "${docTitle(a.data.doc)}". The document is unchanged.`);
  return getAction(id)!;
}

export function undoAction(id: number): ChatAction {
  const a = getAction(id);
  if (!a || a.kind !== 'competitor' || a.status !== 'done') throw new Error('nothing to undo');
  removeCompetitor(a.data.competitorId);
  setActionStatus(id, 'undone');
  addNote(a.threadId, `The owner removed ${a.data.name} from the competitor list again.`);
  return getAction(id)!;
}

// ---------------------------------------------------------------- what the page shows

export interface ShownAction {
  id: number;
  kind: ChatAction['kind'];
  status: ChatAction['status'];
  title: string;
  summary?: string;
  diff?: ReturnType<typeof lineDiff>;
  stats?: { added: number; removed: number };
  draft?: { id: number; status: string } | null;
  job?: { status: string; progress: string | null; error: string | null } | null;
  /** For job cards: what to say when the job has finished. */
  doneText?: string;
  /** True when a pending change can no longer apply because the document moved on. */
  stale?: boolean;
}

export interface ShownItem {
  role: 'you' | 'assistant';
  html?: string;
  text?: string;
  /** Plain labels for what the assistant looked at ("Looked at the Dashboard"). */
  steps?: string[];
  actions?: ShownAction[];
  at: string;
}

const STEP_LABEL: Record<string, string> = {
  read_document: 'Read a document',
  propose_document_change: 'Proposed a change',
  create_draft: 'Wrote a draft',
  run_agent: 'Started an agent',
  refresh_pages: 'Re-read the site',
  get_today: 'Looked at the Dashboard',
  get_results: 'Looked at Google results',
  get_site_health: 'Checked site health',
  get_traffic: 'Looked at visitors and devices',
  get_live_visitors: 'Looked at live visitors',
  get_rankings: 'Looked at rankings',
  get_ai_visibility: 'Looked at AI visibility',
  get_outreach: 'Looked at outreach',
  get_connections: 'Checked connections',
  list_competitors: 'Looked at competitors',
  add_competitor: 'Added a competitor',
  web_search: 'Searched the web',
  read_page: 'Read a web page',
};

function showAction(a: ChatAction): ShownAction {
  if (a.kind === 'doc-change') {
    const diff = lineDiff(a.data.before, a.data.after);
    return {
      id: a.id,
      kind: a.kind,
      status: a.status,
      title: `Change to ${docTitle(a.data.doc)}`,
      summary: a.data.summary,
      diff,
      stats: diffStats(diff),
      stale: a.status === 'pending' && readChatDoc(a.data.doc) !== a.data.before,
    };
  }
  if (a.kind === 'draft') {
    const d = getDraft(a.data.draftId);
    return { id: a.id, kind: a.kind, status: a.status, title: a.data.title, draft: d ? { id: d.id, status: d.status } : null };
  }
  if (a.kind === 'job') {
    const j = getJob(a.data.jobId);
    return { id: a.id, kind: a.kind, status: a.status, title: a.data.label ?? `${AGENTS.find((x) => x.id === a.data.agent)?.label ?? a.data.agent} agent`, doneText: a.data.doneText, job: j ? { status: j.status, progress: j.progress, error: j.error } : null };
  }
  return { id: a.id, kind: a.kind, status: a.status, title: a.data.name };
}

/** The thread as the page shows it: the owner's words, the assistant's answers, step labels, and action cards. */
export function showThread(threadId: number): { thread: Thread; items: ShownItem[]; cost: number } {
  const thread = getThread(threadId);
  if (!thread) throw new Error(`no chat ${threadId}`);
  const actions = (getDb().prepare('SELECT * FROM chat_actions WHERE thread_id = ? ORDER BY id').all(threadId) as any[]).map((r) => getAction(r.id)!);
  const byToolUse = new Map(actions.map((a) => [a.data.toolUseId as string, a]));
  const items: ShownItem[] = [];
  for (const m of storedMessages(threadId)) {
    if (m.kind === 'tool') continue;
    if (m.kind === 'text') {
      const text = m.content.filter((b) => b.type === 'text' && !String(b.text).startsWith(NOTE_TAG)).map((b) => b.text).join('\n');
      items.push({ role: 'you', text, at: m.at });
      continue;
    }
    const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const uses = m.content.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use');
    const steps = [...new Set(uses.map((u) => STEP_LABEL[u.name] ?? u.name))];
    const shown = uses.map((u) => byToolUse.get(u.id)).filter((a): a is ChatAction => !!a).map(showAction);
    // Consecutive assistant turns (tool rounds) read as one answer.
    const prev = items[items.length - 1];
    if (prev?.role === 'assistant') {
      if (text) prev.html = `${prev.html ?? ''}${renderMarkdown(text)}`;
      prev.steps = [...new Set([...(prev.steps ?? []), ...steps])];
      prev.actions = [...(prev.actions ?? []), ...shown];
    } else items.push({ role: 'assistant', html: text ? renderMarkdown(text) : '', steps, actions: shown, at: m.at });
  }
  const cost = (getGlobalDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) c FROM llm_calls WHERE site = ? AND purpose = ?').get(currentSite(), `chat:${threadId}`) as { c: number }).c;
  return { thread, items, cost };
}

/** Starting points based on this site's actual data, in plain words. */
export function suggestions(): string[] {
  const out: string[] = [];
  const waiting = listDrafts({ status: 'draft' }).length;
  if (waiting) out.push(`What's waiting for me today, and what should I approve first?`);
  const audit = getSetting<AuditResult | null>('lastAudit', null);
  const speed = lastSpeed().mobile;
  if (speed?.headline) out.push('Why is my site slow on phones, and what should I fix first?');
  else if (audit && audit.score < 80) out.push('What are the most important problems on my site?');
  if (topQueries(1).length) out.push('Which searches am I close to page one on, and what should I write about them?');
  const change = openChanges()[0];
  if (change) out.push(`What changed at ${change.name}, and should I react?`);
  const comps = listCompetitors();
  out.push(comps.length ? `How do we stand out against ${comps[0].name}?` : 'Who are my main competitors?');
  out.push('Plan the next 30 days of marketing for me.');
  out.push('Write a LinkedIn post about what makes us different.');
  out.push('Make our brand voice warmer and more direct.');
  return out.slice(0, 6);
}

export const MENTIONS = (): { token: string; label: string }[] => [
  ...AGENTS.map((a) => ({ token: `@${a.id}`, label: `${a.label} agent` })),
  ...PROFILE_DOCS.map((d) => ({ token: `@doc:${d.id}`, label: d.title })),
  { token: '@doc:notes', label: 'Your notes' },
];

export function isThreadRunning(threadId: number): boolean {
  return running.has(runKey(threadId));
}

/** On startup: a thread marked running was cut off by a restart. */
export function closeStaleChats(): void {
  getDb().prepare(`UPDATE chat_threads SET running = 0, error = 'stopped because Plume was restarted — send your message again' WHERE running = 1`).run();
}

export { isProfileDocId };
