import type { Publisher } from './index';

/** Opens a pull request that adds the article as a Markdown file. Nothing reaches the main branch until someone merges it. */
export const github: Publisher = {
  id: 'github',
  label: 'GitHub (pull request)',
  needs: ['GITHUB_TOKEN', 'GITHUB_REPO'],
  configured: (env = process.env) => !!(env.GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO ?? '')),
  async publish(draft, _html, env = process.env) {
    const api = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
    const repo = env.GITHUB_REPO!;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${api}/repos/${repo}${path}`, {
        method,
        headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'plume' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`GitHub said ${res.status}: ${data.message ?? res.statusText}`);
      return data;
    };
    const base: string = env.GITHUB_BRANCH || (await call('GET', '')).default_branch;
    const sha: string = (await call('GET', `/git/ref/heads/${base}`)).object.sha;
    const slug = draft.meta.slug || `draft-${draft.id}`;
    const branch = `plume/${slug}-${Date.now().toString(36)}`;
    await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
    const dir = (env.GITHUB_PATH || 'content/blog').replace(/^\/|\/$/g, '');
    const q = (s: string) => JSON.stringify(s);
    const file = `---\ntitle: ${q(draft.title)}\nslug: ${q(slug)}\ndescription: ${q(draft.meta.metaDescription ?? '')}\n---\n\n${draft.body.replace(/^\s*#\s+[^\n]*\n+/, '')}\n`;
    await call('PUT', `/contents/${dir}/${slug}.md`, { message: `Add article: ${draft.title}`, content: Buffer.from(file).toString('base64'), branch });
    const pr = await call('POST', '/pulls', { title: `Add article: ${draft.title}`, head: branch, base, body: draft.meta.reason ? String(draft.meta.reason) : 'Written by Plume.' });
    return { url: pr.html_url ?? null, externalId: String(pr.number), dryRun: false };
  },
};
