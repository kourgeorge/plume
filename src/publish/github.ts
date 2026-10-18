import type { Publisher } from './index';
import { ghBase, ghConfigured, ghFrom, ghPullRequest, ghPutFile } from '../github';

/** Opens a pull request that adds the article as a Markdown file. Nothing reaches the main branch until someone merges it. */
export const github: Publisher = {
  id: 'github',
  label: 'GitHub (pull request)',
  needs: ['GITHUB_TOKEN', 'GITHUB_REPO'],
  configured: (env = process.env) => ghConfigured(env),
  async publish(draft, _html, env = process.env) {
    const g = ghFrom(env);
    const { base, sha } = await ghBase(g, env);
    const slug = draft.meta.slug || `draft-${draft.id}`;
    const dir = (env.GITHUB_PATH || 'content/blog').replace(/^\/|\/$/g, '');
    const q = (s: string) => JSON.stringify(s);
    const file = `---\ntitle: ${q(draft.title)}\nslug: ${q(slug)}\ndescription: ${q(draft.meta.metaDescription ?? '')}\n---\n\n${draft.body.replace(/^\s*#\s+[^\n]*\n+/, '')}\n`;
    const pr = await ghPullRequest(
      g,
      { base, sha, branch: `plume/${slug}-${Date.now().toString(36)}`, title: `Add article: ${draft.title}`, body: draft.meta.reason ? String(draft.meta.reason) : 'Written by Plume.' },
      // Replaces the file if an article with this name is already there, so publishing again updates it.
      (branch) => ghPutFile(g, branch, `${dir}/${slug}.md`, file, `Add article: ${draft.title}`),
    );
    return { url: pr.url, externalId: String(pr.number), dryRun: false };
  },
};
