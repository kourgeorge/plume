/**
 * The one way Plume talks to GitHub: articles as pull requests, site fixes as pull requests, and the
 * Settings "Test" button all go through here, so they share the same timeouts and plain-English errors.
 */

export interface Gh {
  api: string;
  repo: string;
  token: string;
}

const REPO_SHAPE = /^[\w.-]+\/[\w.-]+$/;

/** A fine-grained token page with the permissions Plume needs already ticked. The user only picks the repository. */
export const TOKEN_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Plume&description=Lets+Plume+open+pull+requests&expires_in=366&contents=write&pull_requests=write&metadata=read';

export function ghConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.GITHUB_TOKEN && REPO_SHAPE.test(env.GITHUB_REPO ?? ''));
}

export function ghFrom(env: NodeJS.ProcessEnv = process.env): Gh {
  if (!ghConfigured(env)) throw new Error('connect GitHub for this website under Settings (repository and access token) to open pull requests');
  return { api: (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''), repo: env.GITHUB_REPO!, token: env.GITHUB_TOKEN! };
}

export class GhError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A path inside the repository, made safe for a URL one part at a time. */
export const ghPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** One request to /repos/{repo}{path}. Errors say what went wrong and what to do about it. */
export async function ghCall(g: Gh, method: string, path: string, body?: unknown): Promise<any> {
  const { data } = await ghRaw(g, method, path, body);
  return data;
}

async function ghRaw(g: Gh, method: string, path: string, body?: unknown): Promise<{ res: Response; data: any }> {
  let res: Response;
  try {
    res = await fetch(`${g.api}/repos/${g.repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${g.token}`, accept: 'application/vnd.github+json', 'user-agent': 'plume', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new GhError(err?.name === 'TimeoutError' ? 'GitHub took too long to answer — try again in a minute' : `could not reach GitHub (${err?.message ?? err})`, 0);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GhError(explain(g, method, path, res, data), res.status);
  return { res, data };
}

function explain(g: Gh, method: string, path: string, res: Response, data: any): string {
  const said = data.message ?? res.statusText;
  if (res.status === 401) return 'GitHub refused the access token (it may have expired) — make a new one and save it in Settings';
  if (res.status === 403 && /rate limit/i.test(said)) return 'GitHub says Plume has made too many requests — wait a while and try again';
  if (res.status === 403 && method === 'POST' && path === '/pulls') return `the token can change ${g.repo} but can't open pull requests — give it "Pull requests: Read and write" on GitHub`;
  if (res.status === 403 || res.status === 404) {
    if (path === '' || method !== 'GET') return `GitHub says this token can't ${method === 'GET' ? 'see' : 'change'} ${g.repo} — check the repository name and that the token was given access to it (${said})`;
  }
  return `GitHub said ${res.status}: ${said}`;
}

/** The branch pull requests go into: the one saved in Settings, or the repository's main branch. */
export async function ghBase(g: Gh, env: NodeJS.ProcessEnv): Promise<{ base: string; sha: string; repo: any }> {
  const repo = await ghCall(g, 'GET', '');
  const base: string = env.GITHUB_BRANCH || repo.default_branch;
  try {
    const sha: string = (await ghCall(g, 'GET', `/git/ref/heads/${ghPath(base)}`)).object.sha;
    return { base, sha, repo };
  } catch (err) {
    if (err instanceof GhError && err.status === 404) throw new GhError(`${g.repo} has no branch called "${base}" — fix the base branch in Settings`, 404);
    throw err;
  }
}

/** Create or replace a file on a branch. Replacing needs the file's current version, so look it up first. */
export async function ghPutFile(g: Gh, branch: string, path: string, text: string, message: string): Promise<void> {
  let sha: string | undefined;
  try {
    sha = (await ghCall(g, 'GET', `/contents/${ghPath(path)}?ref=${encodeURIComponent(branch)}`)).sha;
  } catch (err) {
    if (!(err instanceof GhError && err.status === 404)) throw err;
  }
  await ghCall(g, 'PUT', `/contents/${ghPath(path)}`, { message, content: Buffer.from(text).toString('base64'), branch, ...(sha ? { sha } : {}) });
}

/**
 * Make a fresh branch, let `work` commit to it, then open a pull request. If anything fails after the branch
 * exists, the branch is deleted again so failed tries don't pile up in the repository.
 */
export async function ghPullRequest(
  g: Gh,
  o: { base: string; sha: string; branch: string; title: string; body: string },
  work: (branch: string) => Promise<void>,
): Promise<{ url: string | null; number: number }> {
  await ghCall(g, 'POST', '/git/refs', { ref: `refs/heads/${o.branch}`, sha: o.sha });
  try {
    await work(o.branch);
    const pr = await ghCall(g, 'POST', '/pulls', { title: o.title.slice(0, 250), head: o.branch, base: o.base, body: o.body });
    return { url: pr.html_url ?? null, number: pr.number };
  } catch (err) {
    await ghCall(g, 'DELETE', `/git/refs/heads/${ghPath(o.branch)}`).catch(() => {});
    throw err;
  }
}

/** The Settings "Test" button: read-only checks that catch the usual setup mistakes before the first pull request. */
export async function ghTest(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }> {
  try {
    const g = ghFrom(env);
    const { res, data: repo } = await ghRaw(g, 'GET', '');
    if (repo.permissions && !repo.permissions.push) return { ok: false, message: `Found ${repo.full_name}, but this token can only read it. Give it "Contents: Read and write".` };
    // Classic tokens list their scopes; without "repo" (or "public_repo" for a public repository) they can't write.
    const scopes = res.headers.get('x-oauth-scopes');
    if (scopes !== null) {
      const have = scopes.split(',').map((s) => s.trim());
      if (!have.includes('repo') && !(have.includes('public_repo') && !repo.private)) return { ok: false, message: `Found ${repo.full_name}, but this token is missing the "repo" permission.` };
    }
    const { base } = await ghBase(g, env);
    const fineGrained = g.token.startsWith('github_pat_');
    return {
      ok: true,
      message: `Found ${repo.full_name}; pull requests will go into "${base}".${fineGrained ? ' (Make sure the token also has "Pull requests: Read and write" — GitHub only checks that on the first pull request.)' : ''}`,
    };
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err).replace(/^./, (c) => c.toUpperCase()) };
  }
}
