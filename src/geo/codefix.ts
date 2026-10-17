import type Database from 'better-sqlite3';
import { getDb, getSetting } from '../db';
import { MODELS } from '../config';
import { askJson } from '../llm/client';
import { siteEnv } from '../integrations';
import { techSignals } from '../research/techSignals';
import { AuditResult, Issue, pinnedIssues } from '../agents/seoAudit';
import { finishJob, runningJob, startJob, updateJob } from '../jobs';
import { log } from '../log';

/**
 * Site fixes as GitHub pull requests. Plume finds the files behind the page, asks for exact find → replace
 * edits, checks every edit lands exactly once, and opens a pull request on a new branch. It never merges.
 */

const TABLE = `CREATE TABLE IF NOT EXISTS code_fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,            -- opened | failed | not-fixable
  pr_url TEXT,
  files TEXT NOT NULL DEFAULT '[]',
  message TEXT
);
CREATE INDEX IF NOT EXISTS code_fixes_by_issue ON code_fixes (issue_id, id);`;
const ready = new WeakSet<Database.Database>();
function db(): Database.Database {
  const d = getDb();
  if (!ready.has(d)) {
    d.exec(TABLE);
    ready.add(d);
  }
  return d;
}

// ---------------------------------------------------------------- GitHub

interface Gh {
  api: string;
  repo: string;
  token: string;
}

function gh(env = siteEnv()): Gh {
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO ?? '')) {
    throw new Error('connect GitHub for this website under Settings (repository and access token) to open pull requests');
  }
  return { api: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''), repo: env.GITHUB_REPO!, token: env.GITHUB_TOKEN! };
}

async function call(g: Gh, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${g.api}/repos/${g.repo}${path}`, {
    method,
    headers: { authorization: `Bearer ${g.token}`, accept: 'application/vnd.github+json', 'user-agent': 'plume', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('GitHub refused the access token — make a new one and save it in Settings');
    if (res.status === 403 || res.status === 404) throw new Error(`GitHub says this token can't ${method === 'GET' ? 'read' : 'change'} ${g.repo} (${data.message ?? res.status})`);
    throw new Error(`GitHub said ${res.status}: ${data.message ?? res.statusText}`);
  }
  return data;
}

// ---------------------------------------------------------------- which files

const SOURCE_EXT = /\.(html?|jsx?|tsx?|vue|svelte|astro|mdx?|njk|liquid|hbs|ejs|php|erb|twig|pug)$/i;
const LAYOUT_NAME = /(^|\/)(_app|_document|layout|base|default|head|header|seo|meta|root|baseof|app)\.[a-z]+$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|out|\.next|\.nuxt|vendor|coverage|\.cache|public\/build)(\/|$)/;
/** New files Plume may create — plain site files only, never code that runs (no workflows, no scripts). */
const ALLOWED_NEW = /^((public|static|src\/static)\/)?(robots\.txt|sitemap\.xml|llms\.txt)$/;
const MAX_FILE = 60_000;
const MAX_TOTAL = 160_000;

export interface TreeFile {
  path: string;
  size: number;
}

/** Checks that need the shared layout (they're about every page) rather than one page's file. */
const SITE_WIDE = new Set(['missing-identity-schema', 'missing-canonical', 'missing-meta-description', 'meta-description-length']);

/** The files most likely to hold the page (and, for site-wide checks, the layout), best first. */
export function candidateFiles(issue: Pick<Issue, 'check' | 'url'>, tree: TreeFile[]): string[] {
  const files = tree.filter((f) => !SKIP_DIR.test(f.path) && f.size <= MAX_FILE);
  if (issue.check === 'missing-robots' || issue.check === 'ai-crawlers-blocked' || issue.check === 'cloudflare-ai-block') {
    return files.filter((f) => /(^|\/)robots\.txt$/.test(f.path) || /(^|\/)robots\.(ts|js)$/.test(f.path)).map((f) => f.path).slice(0, 3);
  }
  if (issue.check === 'missing-sitemap') return files.filter((f) => /(^|\/)sitemap/.test(f.path)).map((f) => f.path).slice(0, 3);
  const src = files.filter((f) => SOURCE_EXT.test(f.path));
  const page = (() => {
    try {
      return new URL(issue.url).pathname.replace(/\/+$/, '').replace(/^\/+/, '');
    } catch {
      return '';
    }
  })();
  const noExt = (p: string) => p.replace(/\.[a-z]+$/i, '');
  const score = (p: string): number => {
    const base = noExt(p).toLowerCase();
    if (!page) {
      if (/(^|\/)(index|home|page)$/.test(base) && base.split('/').length <= 4) return /(src\/)?(pages|app)\/(index|page)$|^(public\/)?index$|^index$/.test(base) ? 3 : 2;
      return 0;
    }
    const p2 = page.toLowerCase();
    if (base.endsWith(`/${p2}`) || base === p2) return 3;
    if (base.endsWith(`/${p2}/index`) || base.endsWith(`/${p2}/page`) || base === `${p2}/index`) return 3;
    const last = p2.split('/').pop()!;
    if (base.endsWith(`/${last}`) || base.endsWith(`/${last}/index`) || base.endsWith(`/${last}/page`)) return 1;
    return 0;
  };
  const pages = src.map((f) => ({ f: f.path, s: score(f.path) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.f.length - b.f.length).map((x) => x.f);
  const layouts = src.filter((f) => LAYOUT_NAME.test(f.path)).map((f) => f.path).sort((a, b) => a.length - b.length);
  const ordered = SITE_WIDE.has(issue.check) ? [...layouts.slice(0, 3), ...pages.slice(0, 2)] : [...pages.slice(0, 3), ...layouts.slice(0, 2)];
  return [...new Set(ordered)].slice(0, 5);
}

// ---------------------------------------------------------------- edits

export interface Edit {
  path: string;
  find: string;
  replace: string;
}
export interface NewFile {
  path: string;
  content: string;
}
interface Plan {
  can_fix: boolean;
  reason: string;
  summary: string;
  edits: Edit[];
  new_files: NewFile[];
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['can_fix', 'reason', 'summary', 'edits', 'new_files'],
  properties: {
    can_fix: { type: 'boolean' },
    reason: { type: 'string', description: 'If can_fix is false: why, in one plain sentence. Otherwise empty.' },
    summary: { type: 'string', description: 'What the change does, for the pull request.' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'find', 'replace'],
        properties: {
          path: { type: 'string' },
          find: { type: 'string', description: 'Exact text copied from the file, long enough to appear only once.' },
          replace: { type: 'string', description: 'What that text becomes.' },
        },
      },
    },
    new_files: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
    },
  },
};

/** Apply edits to file contents, requiring each `find` to occur exactly once. Returns new contents or the first problem. */
export function applyEdits(files: Record<string, string>, edits: Edit[]): { ok: true; files: Record<string, string> } | { ok: false; problem: string } {
  if (edits.length > 12) return { ok: false, problem: `too many edits (${edits.length}); make the smallest change that fixes the problem` };
  const out = { ...files };
  for (const e of edits) {
    if (!(e.path in out)) return { ok: false, problem: `"${e.path}" is not one of the files you were shown` };
    if (!e.find) return { ok: false, problem: `an edit to ${e.path} has empty "find" text` };
    const count = out[e.path].split(e.find).length - 1;
    if (count !== 1) return { ok: false, problem: `the "find" text for ${e.path} appears ${count} times; it must appear exactly once — copy a longer, unique piece` };
    out[e.path] = out[e.path].replace(e.find, () => e.replace);
  }
  return { ok: true, files: out };
}

export function checkNewFiles(newFiles: NewFile[], tree: TreeFile[]): string | null {
  const existing = new Set(tree.map((t) => t.path));
  for (const f of newFiles) {
    if (!ALLOWED_NEW.test(f.path)) return `Plume can only create robots.txt, sitemap.xml or llms.txt (at the root, public/ or static/), not "${f.path}"`;
    if (existing.has(f.path)) return `"${f.path}" already exists — edit it instead of creating it`;
    if (f.content.length > 100_000) return `"${f.path}" is too large`;
  }
  return null;
}

const ROLE = `You make small, careful fixes to a website's source code so a site-check problem goes away.
Change as little as possible, keep the file's existing style and formatting, and never touch anything unrelated.
Use only the facts given; don't invent prices, claims or contact details. If the files shown don't contain the
place to fix it (for example the content comes from a database or a site builder), say can_fix: false and why.`;

// ---------------------------------------------------------------- the whole flow

const BUILDERS = new Set(['Wix', 'Squarespace', 'Webflow', 'Framer', 'Google Sites', 'Shopify', 'HubSpot CMS']);

/** Find a site-check problem by its id, in the latest check or in the ones sent over by hand. */
export function findIssue(id: string): Issue | null {
  const audit = getSetting<AuditResult | null>('lastAudit', null);
  return audit?.issues.find((i) => i.id === id) ?? pinnedIssues().find((i) => i.id === id) ?? null;
}

export function lastFix(issueId: string): { status: string; prUrl: string | null; message: string | null; at: string } | null {
  const r = db().prepare('SELECT * FROM code_fixes WHERE issue_id = ? ORDER BY id DESC LIMIT 1').get(issueId) as any;
  return r ? { status: r.status, prUrl: r.pr_url, message: r.message, at: r.at } : null;
}

export function fixesByIssue(): Record<string, { status: string; prUrl: string | null; message: string | null }> {
  const rows = db().prepare('SELECT * FROM code_fixes WHERE id IN (SELECT MAX(id) FROM code_fixes GROUP BY issue_id)').all() as any[];
  return Object.fromEntries(rows.map((r) => [r.issue_id, { status: r.status, prUrl: r.pr_url, message: r.message }]));
}

function record(issueId: string, status: string, message: string, prUrl: string | null = null, files: string[] = []): void {
  db().prepare('INSERT INTO code_fixes (issue_id, at, status, pr_url, files, message) VALUES (?, ?, ?, ?, ?, ?)').run(issueId, new Date().toISOString(), status, prUrl, JSON.stringify(files), message);
}

export async function openFixPullRequest(issue: Issue, onProgress: (m: string) => void = () => {}, env = siteEnv()): Promise<{ prUrl: string | null; message: string }> {
  const g = gh(env);
  onProgress(`Reading ${g.repo}`);
  const repo = await call(g, 'GET', '');
  const base: string = env.GITHUB_BRANCH || repo.default_branch;
  const headSha: string = (await call(g, 'GET', `/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;
  const tree: TreeFile[] = ((await call(g, 'GET', `/git/trees/${headSha}?recursive=1`)).tree ?? []).filter((t: any) => t.type === 'blob').map((t: any) => ({ path: t.path, size: t.size ?? 0 }));
  const paths = candidateFiles(issue, tree);
  const builder = techSignals().list.find((s) => s.kind === 'builder' && BUILDERS.has(s.name));
  const robotsLike = ['missing-robots', 'missing-sitemap', 'ai-crawlers-blocked', 'cloudflare-ai-block'].includes(issue.check);
  if (!paths.length && !robotsLike) {
    const msg = builder
      ? `The site is built with ${builder.name}, and ${g.repo} doesn't hold this page. Make the fix in ${builder.name}'s editor — the steps and code are on the fix.`
      : `Couldn't find the file for ${new URL(issue.url).pathname} in ${g.repo}. Make the fix by hand — the steps and code are on the fix.`;
    record(issue.id, 'not-fixable', msg);
    return { prUrl: null, message: msg };
  }

  onProgress(`Reading ${paths.length} file(s)`);
  const contents: Record<string, string> = {};
  const shas: Record<string, string> = {};
  let total = 0;
  for (const p of paths) {
    const f = await call(g, 'GET', `/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(base)}`);
    const text = Buffer.from(String(f.content ?? ''), 'base64').toString('utf8');
    if (total + text.length > MAX_TOTAL) break;
    total += text.length;
    contents[p] = text;
    shas[p] = f.sha;
  }

  const issueText =
    `Problem on ${issue.url}: ${issue.title}\nWhy it matters: ${issue.why}\nHow to fix it:\n${issue.steps.map((s) => `- ${s}`).join('\n')}` +
    (issue.snippet ? `\nSuggested code:\n${issue.snippet}` : '');
  const filesText = Object.entries(contents).map(([p, c]) => `<file path="${p}">\n${c}\n</file>`).join('\n\n');
  let prompt = `${issueText}\n\nThe repository's files that most likely hold this page:\n${filesText || '(none — you may create robots.txt, sitemap.xml or llms.txt if that is the fix)'}\n\nOther files in the repository (names only): ${tree.slice(0, 200).map((t) => t.path).join(', ')}`;

  let plan: Plan | null = null;
  let result: ReturnType<typeof applyEdits> | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    onProgress(attempt ? 'Correcting the change' : 'Working out the change');
    plan = await askJson<Plan>({ purpose: 'codefix:plan', model: MODELS.draft, effort: 'high', maxTokens: 16000, system: ROLE, schema: PLAN_SCHEMA, prompt });
    if (!plan.can_fix) break;
    const newProblem = checkNewFiles(plan.new_files, tree);
    result = newProblem ? { ok: false, problem: newProblem } : applyEdits(contents, plan.edits);
    if (result.ok && (plan.edits.length || plan.new_files.length)) break;
    const problem = result.ok ? 'no edits were given' : result.problem;
    prompt += `\n\nYour last answer could not be applied: ${problem}. Give the change again.`;
    result = null;
  }
  if (!plan?.can_fix) {
    const msg = `Not fixed in code: ${plan?.reason || 'the change could not be worked out'}`;
    record(issue.id, 'not-fixable', msg);
    return { prUrl: null, message: msg };
  }
  if (!result || !result.ok) {
    const msg = 'Could not produce a change that applies cleanly. Make the fix by hand — the steps and code are on the fix.';
    record(issue.id, 'failed', msg);
    return { prUrl: null, message: msg };
  }

  onProgress('Opening the pull request');
  const branch = `plume/fix-${issue.check}-${Date.now().toString(36)}`;
  await call(g, 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: headSha });
  const changed: string[] = [];
  for (const [p, text] of Object.entries(result.files)) {
    if (text === contents[p]) continue;
    await call(g, 'PUT', `/contents/${p.split('/').map(encodeURIComponent).join('/')}`, { message: `Fix: ${issue.title}`, content: Buffer.from(text).toString('base64'), branch, sha: shas[p] });
    changed.push(p);
  }
  for (const f of plan.new_files) {
    await call(g, 'PUT', `/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`, { message: `Add ${f.path}`, content: Buffer.from(f.content).toString('base64'), branch });
    changed.push(f.path);
  }
  const body = [
    `**Problem:** ${issue.title} (${issue.url})`,
    `**Why it matters:** ${issue.why}`,
    `**What this changes:** ${plan.summary}`,
    `**Files:** ${changed.map((c) => `\`${c}\``).join(', ')}`,
    '',
    '_Opened by Plume. Please review before merging — Plume never merges anything itself._',
  ].join('\n\n');
  const pr = await call(g, 'POST', '/pulls', { title: `Fix: ${issue.title}`.slice(0, 250), head: branch, base, body });
  record(issue.id, 'opened', plan.summary, pr.html_url ?? null, changed);
  log('info', 'codefix', `opened ${pr.html_url} for ${issue.check} (${changed.length} file(s))`);
  return { prUrl: pr.html_url ?? null, message: plan.summary };
}

/** Background job for the web page: "Fix it with a pull request". */
export function startFixPullRequest(issueId: string): number {
  const issue = findIssue(issueId);
  if (!issue) throw new Error('that fix is no longer in the latest site check');
  gh(); // fail at once, with the setup message, when GitHub isn't connected
  if (runningJob('codefix')) throw new Error('a pull request is already being prepared — wait for it to finish');
  const jobId = startJob('codefix', `Preparing a pull request: ${issue.title}`);
  openFixPullRequest(issue, (m) => updateJob(jobId, m))
    .then((r) => {
      updateJob(jobId, r.prUrl ? `Opened ${r.prUrl}` : r.message);
      finishJob(jobId);
    })
    .catch((err) => {
      record(issue.id, 'failed', String(err?.message ?? err));
      finishJob(jobId, String(err?.message ?? err));
    });
  return jobId;
}
