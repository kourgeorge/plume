import type Database from 'better-sqlite3';
import { getDb, getSetting } from '../db';
import { MODELS } from '../config';
import { askJson } from '../llm/client';
import { siteEnv } from '../integrations';
import { techSignals } from '../research/techSignals';
import { AuditResult, Issue, pinnedIssues } from '../agents/seoAudit';
import { finishJob, runningJob, startJob, updateJob } from '../jobs';
import { log } from '../log';
import { recordAction } from '../actions';
import { Gh, GhError, ghBase, ghCall, ghConfigured, ghFrom, ghPath, ghPullRequest } from '../github';
import * as cheerio from 'cheerio';
import { fetchHttp } from '../research/fetchPage';
import { extractPage } from '../research/crawl';
import { languageName, pageLanguageOf } from '../context/language';
import { aiAccess } from '../research/aiCrawlers';
import { auditPages, markFixDone } from '../agents/seoAudit';
import { recordFixDone } from '../actions';
import { escapeHtml } from '../publish';
import { DiffLine, lineDiff } from '../diff';
import { RECHECKABLE } from '../compliance/checks';

/**
 * Site fixes as GitHub pull requests, in three steps the owner can follow:
 * 1. Prepare: find the file behind the page (by matching text from the live page, not by guessing from
 *    names), work out exact find → replace edits, and show the file and the change before anything is sent.
 * 2. Open: on the owner's say-so, open a pull request on a new branch. Plume never merges.
 * 3. Follow up: once the pull request is merged, re-read the live page and mark the fix done if it's gone.
 */

const TABLE = `CREATE TABLE IF NOT EXISTS code_fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL,            -- proposed | cancelled | opened | merged | verified | closed | failed | not-fixable
  pr_url TEXT,
  files TEXT NOT NULL DEFAULT '[]',
  message TEXT
);
CREATE INDEX IF NOT EXISTS code_fixes_by_issue ON code_fixes (issue_id, id);
-- Which repository file a page comes from, found once by matching the live page's text, reused after.
CREATE TABLE IF NOT EXISTS page_sources (
  url TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  how TEXT NOT NULL,
  at TEXT NOT NULL
);`;
/** Added after the first version of the table; older databases get them on first use. */
const LATER_COLUMNS: [string, string][] = [
  ['pr_number', 'INTEGER'],
  ['proposal', 'TEXT'],
  ['checked_at', 'TEXT'],
];
const ready = new WeakSet<Database.Database>();
function db(): Database.Database {
  const d = getDb();
  if (!ready.has(d)) {
    d.exec(TABLE);
    const have = new Set((d.prepare('PRAGMA table_info(code_fixes)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of LATER_COLUMNS) if (!have.has(name)) d.exec(`ALTER TABLE code_fixes ADD COLUMN ${name} ${type}`);
    ready.add(d);
  }
  return d;
}

// ---------------------------------------------------------------- GitHub

const gh = (env = siteEnv()): Gh => ghFrom(env);
const call = ghCall;

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

// ---------------------------------------------------------------- which file is this page?

/** How Plume knows a file is the page's source: its text matched the live page, it was found that way before, or only its name fits. */
export type SourceHow = 'text' | 'remembered' | 'name';
export interface PageSource {
  path: string;
  how: SourceHow;
  /** What matched, in plain words, for the owner to check. */
  evidence: string;
}

/** Bits of the live page that should appear, word for word, in the file it is built from. Longest (most telling) first. */
export function fingerprints(html: string): { label: string; text: string }[] {
  const $ = cheerio.load(html);
  const out: { label: string; text: string }[] = [];
  const add = (label: string, text: string | undefined) => {
    const t = norm(text ?? '');
    if (t.length >= 12 && !out.some((o) => o.text === t)) out.push({ label, text: t });
  };
  add('the page title', $('title').first().text());
  add('the main heading', $('h1').first().text());
  add('the meta description', $('meta[name="description"]').attr('content'));
  // A few long paragraphs: specific to this page, unlike menus and footers.
  $('main p, article p, body p')
    .map((_, el) => $(el).text())
    .get()
    .map((t) => norm(t))
    .filter((t) => t.length >= 40)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .forEach((t) => add('a paragraph', t.slice(0, 80)));
  return out;
}

/** Same text however it's written in the file: entities decoded, spacing collapsed. */
function norm(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which of the page's fingerprints a file holds. */
export function matchScore(fileText: string, prints: { label: string; text: string }[]): { score: number; matched: string[] } {
  const body = norm(fileText);
  const matched = prints.filter((p) => body.includes(p.text));
  // The title counts double: it's the one thing every page has and no two pages should share.
  return { score: matched.reduce((n, p) => n + (p.label === 'the page title' ? 2 : 1), 0), matched: matched.map((p) => p.label) };
}

/** Files worth opening to look for the page's text, most likely first: names that fit, then nearby folders. */
export function searchOrder(url: string, tree: TreeFile[], limit = 40): string[] {
  const src = tree.filter((f) => !SKIP_DIR.test(f.path) && f.size <= MAX_FILE && SOURCE_EXT.test(f.path));
  const named = candidateFiles({ check: 'missing-title', url }, src);
  let parts: string[] = [];
  try {
    parts = new URL(url).pathname.toLowerCase().split('/').filter(Boolean).map((p) => p.replace(/\.[a-z]+$/, ''));
  } catch {}
  const near = (p: string) => p.toLowerCase().split('/').filter((x) => parts.includes(x.replace(/\.[a-z]+$/, ''))).length;
  const rest = src
    .map((f) => f.path)
    .filter((p) => !named.includes(p))
    .sort((a, b) => near(b) - near(a) || Number(/\.html?$/i.test(b)) - Number(/\.html?$/i.test(a)) || a.length - b.length);
  return [...named, ...rest].slice(0, limit);
}

function rememberedSource(url: string, repo: string): string | null {
  const r = db().prepare('SELECT path FROM page_sources WHERE url = ? AND repo = ?').get(url, repo) as { path: string } | undefined;
  return r?.path ?? null;
}

function rememberSource(url: string, repo: string, path: string, how: string): void {
  db().prepare('INSERT OR REPLACE INTO page_sources (url, repo, path, how, at) VALUES (?, ?, ?, ?, ?)').run(url, repo, path, how, new Date().toISOString());
}

/**
 * Find the repository file a live page is built from by looking for the page's own text in the files,
 * so it works whatever the files are called. Remembered per page; checked again if that file changes.
 */
async function findPageSource(
  g: Gh,
  base: string,
  tree: TreeFile[],
  url: string,
  liveHtml: string | null,
  read: (path: string) => Promise<string>,
): Promise<PageSource | null> {
  const prints = liveHtml ? fingerprints(liveHtml) : [];
  const known = rememberedSource(url, g.repo);
  if (known && tree.some((t) => t.path === known)) {
    // Still holds the page's text (or there's no live page to compare with): keep using it.
    if (!prints.length || matchScore(await read(known), prints).score > 0) return { path: known, how: 'remembered', evidence: 'found by matching the page text on an earlier fix' };
  }
  if (prints.length) {
    let best: { path: string; score: number; matched: string[] } | null = null;
    const order = searchOrder(url, tree);
    for (let i = 0; i < order.length; i += 6) {
      const batch = await Promise.all(order.slice(i, i + 6).map(async (p) => ({ path: p, ...matchScore(await read(p).catch(() => ''), prints) })));
      for (const m of batch) if (m.score > (best?.score ?? 0)) best = m;
      // A file with the title and something else is certain enough; stop opening files.
      if (best && best.score >= 3) break;
    }
    if (best) {
      rememberSource(url, g.repo, best.path, 'text');
      return { path: best.path, how: 'text', evidence: `it contains ${best.matched.join(' and ')} of the live page` };
    }
  }
  const named = candidateFiles({ check: 'missing-title', url }, tree)[0];
  return named ? { path: named, how: 'name', evidence: "its name fits the page address, but Plume couldn't confirm it holds the page's text" } : null;
}

/** Checks that need the shared layout (they're about every page) rather than one page's file. */
const SITE_WIDE = new Set([
  'missing-identity-schema', 'missing-canonical', 'missing-meta-description', 'meta-description-length',
  // Cookie banners and footer links live in the shared layout, not one page.
  'privacy-no-consent', 'privacy-trackers-before-consent', 'privacy-no-policy', 'privacy-no-optout', 'privacy-no-imprint', 'privacy-google-fonts', 'a11y-no-statement', 'a11y-html-has-lang', 'a11y-meta-viewport',
]);

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
      // "/legal/storage.html" and "/legal/storage" both mean the file legal/storage.*
      return new URL(issue.url).pathname.replace(/\/+$/, '').replace(/^\/+/, '').replace(/\.(html?|php)$/i, '');
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
const ROBOTS_LIKE = new Set(['missing-robots', 'missing-sitemap', 'ai-crawlers-blocked', 'cloudflare-ai-block']);
/** A prepared change waits this long for the owner; after that the repository may have moved on. */
const PROPOSAL_DAYS = 7;
/** After a merge, keep re-reading the live page this long (the site may take a while to rebuild). */
const FOLLOW_UP_DAYS = 3;

/** Find a site-check problem by its id, in the latest check or in the ones sent over by hand. */
export function findIssue(id: string): Issue | null {
  const audit = getSetting<AuditResult | null>('lastAudit', null);
  return audit?.issues.find((i) => i.id === id) ?? pinnedIssues().find((i) => i.id === id) ?? null;
}

/** What the owner sees before a pull request is opened. */
export interface ProposalView {
  repo: string;
  base: string;
  source: PageSource | null;
  summary: string;
  files: { path: string; isNew: boolean; diff: DiffLine[] }[];
}
/** Everything needed to open the pull request later, exactly as shown. */
interface StoredProposal extends ProposalView {
  headSha: string;
  changes: { path: string; text: string; sha?: string; message: string }[];
}

export interface FixState {
  status: string;
  prUrl: string | null;
  message: string | null;
  at: string;
  proposal?: ProposalView;
}

function rowState(r: any): FixState {
  const out: FixState = { status: r.status, prUrl: r.pr_url, message: r.message, at: r.at };
  if (r.status === 'proposed' && r.proposal) {
    const { headSha: _h, changes: _c, ...view } = JSON.parse(r.proposal) as StoredProposal;
    out.proposal = view;
  }
  return out;
}

function latestRow(issueId: string): any {
  return db().prepare('SELECT * FROM code_fixes WHERE issue_id = ? ORDER BY id DESC LIMIT 1').get(issueId);
}

export function lastFix(issueId: string): FixState | null {
  const r = latestRow(issueId);
  return r ? rowState(r) : null;
}

export function fixesByIssue(): Record<string, FixState> {
  const rows = db().prepare('SELECT * FROM code_fixes WHERE id IN (SELECT MAX(id) FROM code_fixes GROUP BY issue_id)').all() as any[];
  return Object.fromEntries(rows.map((r) => [r.issue_id, rowState(r)]));
}

function record(issueId: string, status: string, message: string, o: { prUrl?: string | null; prNumber?: number | null; files?: string[]; proposal?: StoredProposal } = {}): void {
  db()
    .prepare('INSERT INTO code_fixes (issue_id, at, status, pr_url, pr_number, files, message, proposal) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(issueId, new Date().toISOString(), status, o.prUrl ?? null, o.prNumber ?? null, JSON.stringify(o.files ?? []), message, o.proposal ? JSON.stringify(o.proposal) : null);
}

export interface FixOptions {
  /** Reads the live page; injected so tests don't touch the internet. */
  fetchFn?: typeof fetch;
}

/**
 * Step 1: find the file and work out the change, but send nothing to GitHub except reads.
 * The result is saved as "proposed" so the owner can look at it before saying yes.
 */
export async function prepareFix(issue: Issue, onProgress: (m: string) => void = () => {}, env = siteEnv(), opts: FixOptions = {}): Promise<{ proposal: ProposalView | null; message: string }> {
  const g = gh(env);
  onProgress(`Reading ${g.repo}`);
  const { base, sha: headSha } = await ghBase(g, env);
  const tree: TreeFile[] = ((await call(g, 'GET', `/git/trees/${headSha}?recursive=1`)).tree ?? []).filter((t: any) => t.type === 'blob').map((t: any) => ({ path: t.path, size: t.size ?? 0 }));
  const cache: Record<string, { text: string; sha: string }> = {};
  const readFile = async (p: string) => {
    if (!cache[p]) {
      const f = await call(g, 'GET', `/contents/${ghPath(p)}?ref=${encodeURIComponent(base)}`);
      cache[p] = { text: Buffer.from(String(f.content ?? ''), 'base64').toString('utf8'), sha: f.sha };
    }
    return cache[p].text;
  };

  const robotsLike = ROBOTS_LIKE.has(issue.check);
  let source: PageSource | null = null;
  let lang = '';
  let paths: string[];
  if (robotsLike) {
    paths = candidateFiles(issue, tree);
  } else {
    onProgress('Looking for the file this page comes from');
    const live = await fetchHttp(issue.url, opts.fetchFn);
    // A short page counts as "thin" to the crawler, but its title and headings still say which file it is.
    const liveHtml = live.html ?? null;
    if (liveHtml) lang = pageLanguageOf(extractPage(issue.url, 200, liveHtml).page);
    source = await findPageSource(g, base, tree, issue.url, liveHtml, readFile);
    const named = candidateFiles(issue, tree);
    // A file that holds the page's text comes first. For site-wide checks the shared layout follows,
    // since on some sites the <head> lives there rather than in the page.
    paths = [...new Set([...(source ? [source.path] : []), ...named])].slice(0, 5);
  }

  const builder = techSignals().list.find((s) => s.kind === 'builder' && BUILDERS.has(s.name));
  if (!paths.length && !robotsLike) {
    const msg = builder
      ? `The site is built with ${builder.name}, and ${g.repo} doesn't hold this page. Make the fix in ${builder.name}'s editor — the steps and code are on the fix.`
      : `Couldn't find the file for ${new URL(issue.url).pathname} in ${g.repo}. Make the fix by hand — the steps and code are on the fix.`;
    record(issue.id, 'not-fixable', msg);
    return { proposal: null, message: msg };
  }

  onProgress(`Reading ${paths.length} file(s)`);
  const contents: Record<string, string> = {};
  let total = 0;
  for (const p of paths) {
    const text = await readFile(p);
    if (total + text.length > MAX_TOTAL) break;
    total += text.length;
    contents[p] = text;
  }

  const issueText =
    `Problem on ${issue.url}: ${issue.title}\nWhy it matters: ${issue.why}\nHow to fix it:\n${issue.steps.map((s) => `- ${s}`).join('\n')}` +
    (issue.snippet ? `\nSuggested code:\n${issue.snippet}` : '') +
    (lang ? `\nThe page is in ${languageName(lang)}: write any text visitors or search engines will read (titles, descriptions) in that language.` : '');
  const where = source
    ? source.how === 'name'
      ? `\n${source.path} looks like this page's file by its name only; check it really is before editing it.`
      : `\n${source.path} is this page's file (${source.evidence}). If the problem is in the <head> and this file has its own <head>, fix it there.`
    : '';
  const filesText = Object.entries(contents).map(([p, c]) => `<file path="${p}">\n${c}\n</file>`).join('\n\n');
  let prompt = `${issueText}${where}\n\nThe repository's files that most likely hold this page:\n${filesText || '(none — you may create robots.txt, sitemap.xml or llms.txt if that is the fix)'}\n\nOther files in the repository (names only): ${tree.slice(0, 200).map((t) => t.path).join(', ')}`;

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
    return { proposal: null, message: msg };
  }
  if (!result || !result.ok) {
    const msg = 'Could not produce a change that applies cleanly. Make the fix by hand — the steps and code are on the fix.';
    record(issue.id, 'failed', msg);
    return { proposal: null, message: msg };
  }

  const edited = Object.entries(result.files).filter(([p, text]) => text !== contents[p]);
  const stored: StoredProposal = {
    repo: g.repo,
    base,
    headSha,
    source,
    summary: plan.summary,
    files: [
      ...edited.map(([p, text]) => ({ path: p, isNew: false, diff: lineDiff(contents[p], text) })),
      ...plan.new_files.map((f) => ({ path: f.path, isNew: true, diff: lineDiff('', f.content) })),
    ],
    changes: [
      ...edited.map(([p, text]) => ({ path: p, text, sha: cache[p].sha, message: `Fix: ${issue.title}` })),
      ...plan.new_files.map((f) => ({ path: f.path, text: f.content, message: `Add ${f.path}` })),
    ],
  };
  record(issue.id, 'proposed', plan.summary, { files: stored.changes.map((c) => c.path), proposal: stored });
  const { headSha: _h, changes: _c, ...view } = stored;
  return { proposal: view, message: plan.summary };
}

/** Step 2: the owner said yes. Open the pull request with exactly the change they saw. */
export async function openProposedFix(issueId: string, env = siteEnv(), known?: Issue): Promise<{ prUrl: string | null; message: string }> {
  const issue = known ?? findIssue(issueId);
  if (!issue) throw new Error('that fix is no longer in the latest site check');
  const row = latestRow(issueId);
  if (row?.status !== 'proposed' || !row.proposal) throw new Error('there is no prepared change for this fix — press "Fix with a pull request" first');
  if (Date.now() - new Date(row.at).getTime() > PROPOSAL_DAYS * 86400e3) throw new Error(`this change was prepared more than ${PROPOSAL_DAYS} days ago — prepare it again so it matches the repository`);
  const p = JSON.parse(row.proposal) as StoredProposal;
  const g = gh(env);
  if (g.repo !== p.repo) throw new Error(`this change was prepared for ${p.repo}, but the website is now connected to ${g.repo} — prepare it again`);
  const body = [
    `**Problem:** ${issue.title} (${issue.url})`,
    `**Why it matters:** ${issue.why}`,
    `**What this changes:** ${p.summary}`,
    p.source ? `**Why this file:** \`${p.source.path}\` — ${p.source.evidence}.` : '',
    `**Files:** ${p.changes.map((c) => `\`${c.path}\``).join(', ')}`,
    '',
    '_Opened by Plume. Please review before merging — Plume never merges anything itself. After you merge, Plume re-checks the live page and marks the fix done._',
  ]
    .filter((l, i) => l || i > 3)
    .join('\n\n');
  let pr: { url: string | null; number: number };
  try {
    pr = await ghPullRequest(
      g,
      { base: p.base, sha: p.headSha, branch: `plume/fix-${issue.check}-${Date.now().toString(36)}`, title: `Fix: ${issue.title}`, body },
      async (branch) => {
        for (const c of p.changes) await call(g, 'PUT', `/contents/${ghPath(c.path)}`, { message: c.message, content: Buffer.from(c.text).toString('base64'), branch, ...(c.sha ? { sha: c.sha } : {}) });
      },
    );
  } catch (err: any) {
    // 409: the file changed since the change was prepared.
    if (err instanceof GhError && err.status === 409) throw new Error('the file changed on GitHub since Plume prepared this — prepare the change again');
    throw err;
  }
  const changed = p.changes.map((c) => c.path);
  record(issue.id, 'opened', p.summary, { prUrl: pr.url, prNumber: pr.number, files: changed });
  recordAction({ kind: 'code-pr', ref: issue.id, url: issue.url, title: issue.title, data: { prUrl: pr.url, files: changed } });
  log('info', 'codefix', `opened ${pr.url} for ${issue.check} (${changed.length} file(s))`);
  return { prUrl: pr.url, message: p.summary };
}

/** The owner looked at the change and said no. */
export function cancelProposedFix(issueId: string): void {
  if (latestRow(issueId)?.status === 'proposed') record(issueId, 'cancelled', 'Cancelled before the pull request was opened.');
}

/** Prepare and open in one go, without stopping to show the change. For scripts and tests. */
export async function openFixPullRequest(issue: Issue, onProgress: (m: string) => void = () => {}, env = siteEnv(), opts: FixOptions = {}): Promise<{ prUrl: string | null; message: string }> {
  const r = await prepareFix(issue, onProgress, env, opts);
  if (!r.proposal) return { prUrl: null, message: r.message };
  onProgress('Opening the pull request');
  return openProposedFix(issue.id, env, issue);
}

/** Background job for the web page: "Fix with a pull request" prepares the change for the owner to look at. */
export function startFixPullRequest(issueId: string): number {
  const issue = findIssue(issueId);
  if (!issue) throw new Error('that fix is no longer in the latest site check');
  gh(); // fail at once, with the setup message, when GitHub isn't connected
  if (runningJob('codefix')) throw new Error('a pull request is already being prepared — wait for it to finish');
  const jobId = startJob('codefix', `Preparing a change: ${issue.title}`);
  prepareFix(issue, (m) => updateJob(jobId, m))
    .then((r) => {
      updateJob(jobId, r.proposal ? 'Ready for you to look at' : r.message);
      finishJob(jobId);
    })
    .catch((err) => {
      record(issue.id, 'failed', String(err?.message ?? err));
      finishJob(jobId, String(err?.message ?? err));
    });
  return jobId;
}

// ---------------------------------------------------------------- after the merge

/**
 * Is the problem still on the live site? true = still there, false = gone, null = Plume can't tell from
 * outside (e.g. a Cloudflare setting) or couldn't read the page.
 */
export async function stillBroken(issue: Issue, fetchFn: typeof fetch = fetch): Promise<boolean | null> {
  const origin = (() => {
    try {
      return new URL(issue.url).origin;
    } catch {
      return '';
    }
  })();
  if (issue.check === 'cloudflare-ai-block') return null;
  // Privacy and accessibility problems need the full browser visit; the compliance agent's next run re-checks them.
  if (RECHECKABLE.test(issue.check)) return null;
  if (issue.check === 'missing-robots' || issue.check === 'missing-sitemap') {
    const r = await fetchHttp(`${origin}/${issue.check === 'missing-robots' ? 'robots.txt' : 'sitemap.xml'}`, fetchFn);
    return r.ok ? false : r.kind === 'http-error' ? true : null;
  }
  if (issue.check === 'ai-crawlers-blocked') {
    const r = await fetchHttp(`${origin}/robots.txt`, fetchFn);
    if (!r.ok) return null;
    return aiAccess(r.html).some((c) => c.kind === 'search' && !c.allowed);
  }
  const r = await fetchHttp(issue.url, fetchFn);
  // A short page counts as "thin" to the crawler, but its <head> is all most checks need.
  const html = r.html;
  if (!html) return null;
  const { page } = extractPage(issue.url, r.status ?? 200, html);
  const row = {
    url: issue.url,
    status: r.status ?? 200,
    title: page.title,
    meta_description: page.metaDescription,
    canonical: page.canonical,
    h1: page.h1,
    headings: JSON.stringify(page.headings),
    images_missing_alt: page.imagesMissingAlt,
    has_schema: page.hasSchema ? 1 : 0,
    word_count: page.wordCount,
    schema_types: JSON.stringify(page.schemaTypes),
    page_date: page.pageDate,
  };
  // The other pages from the last read, so checks that compare pages (same title twice) still work.
  const others = (getDb().prepare('SELECT * FROM pages WHERE url != ?').all(issue.url) as any[]) ?? [];
  return auditPages([row, ...others] as any).issues.some((i) => i.id === issue.id);
}

/**
 * Step 3, on a timer: look at every open pull request Plume made. Merged → re-read the live page, and if
 * the problem is gone, mark the fix done. Closed without merging → say so and stop.
 */
export async function followUpFixes(env = siteEnv(), fetchFn: typeof fetch = fetch): Promise<{ checked: number; verified: string[]; closed: number }> {
  const out = { checked: 0, verified: [] as string[], closed: 0 };
  if (!ghConfigured(env)) return out;
  const g = gh(env);
  const rows = (db().prepare("SELECT * FROM code_fixes WHERE id IN (SELECT MAX(id) FROM code_fixes GROUP BY issue_id) AND status IN ('opened', 'merged') AND pr_number IS NOT NULL").all() as any[]);
  for (const r of rows) {
    out.checked++;
    const issue = findIssue(r.issue_id);
    const pr = await call(g, 'GET', `/pulls/${r.pr_number}`).catch(() => null);
    if (!pr) continue;
    const keep = { prUrl: r.pr_url, prNumber: r.pr_number, files: JSON.parse(r.files ?? '[]') };
    if (pr.state === 'closed' && !pr.merged_at) {
      record(r.issue_id, 'closed', 'The pull request was closed without merging.', keep);
      out.closed++;
      continue;
    }
    if (!pr.merged_at) continue;
    // Not in the site check any more (fixed some other way, or marked done): nothing left to confirm.
    if (!issue) {
      record(r.issue_id, 'verified', 'Merged. The problem is no longer in the site check.', keep);
      continue;
    }
    const broken = await stillBroken(issue, fetchFn).catch(() => null);
    if (broken === false) {
      markFixDone(issue.id);
      recordFixDone(issue);
      record(issue.id, 'verified', 'Merged, and the live page no longer has the problem.', keep);
      log('info', 'codefix', `confirmed fixed on the live site: ${issue.check} on ${issue.url}`);
      out.verified.push(issue.id);
      continue;
    }
    const days = (Date.now() - new Date(pr.merged_at).getTime()) / 86400e3;
    const msg =
      broken === null
        ? "Merged. Plume can't check this one from outside — look at the site, then mark it fixed."
        : days > FOLLOW_UP_DAYS
          ? `Merged ${Math.floor(days)} days ago, but the live page still has the problem. Check that the site was rebuilt, or that the right file was changed.`
          : 'Merged. Waiting for the live site to update — Plume checks again every hour.';
    // Stop re-checking once there's nothing more Plume can learn on its own.
    const done = broken === null || days > FOLLOW_UP_DAYS;
    if (r.status !== 'merged' || r.message !== msg) record(issue.id, done ? 'closed' : 'merged', msg, keep);
    else db().prepare('UPDATE code_fixes SET checked_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
  }
  return out;
}
