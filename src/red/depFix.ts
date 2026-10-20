import type { Issue } from '../agents/seoAudit';
import { Gh, ghBase, ghCall, ghFrom, ghPath, ghPullRequest, GhError } from '../github';
import { siteEnv } from '../integrations';
import { recordAction } from '../actions';
import { log } from '../log';

/**
 * Opens a pull request that raises a vulnerable dependency to a safe version.
 *
 * This is deliberately a small, deterministic change — not the LLM page-fix path. It edits the
 * version requirement in package.json and asks the maintainer to run `npm install` to regenerate the
 * lockfile. Plume does NOT hand-edit the lockfile: npm resolves a whole dependency tree when it
 * installs, and a faked lockfile edit would likely be wrong or inconsistent. Being honest about that
 * boundary is better than opening a PR that looks complete but installs badly. Plume never merges.
 */

/** Pulls the dependency name and safe version out of a `vulnerable-dependency-<name>` issue. */
function parseIssue(issue: Issue): { name: string; safe: string } | null {
  const m = issue.check.match(/^vulnerable-dependency-(.+)$/);
  if (!m) return null;
  // The steps line reads: "Update <name> past <version> ...". Take the version after "past ".
  const vm = issue.steps.join(' ').match(/past\s+([\d.]+)/);
  if (!vm) return null;
  // A safe floor: the next patch above the flagged ceiling. e.g. past 4.17.20 -> ^4.17.21.
  const parts = vm[1].split('.').map(Number);
  parts[parts.length - 1] = (parts[parts.length - 1] || 0) + 1;
  return { name: m[1], safe: parts.join('.') };
}

/** Bumps one dependency's requirement in package.json text, preserving formatting elsewhere. */
export function bumpInManifest(manifest: string, name: string, safe: string): { text: string; changed: boolean } {
  let changed = false;
  const text = manifest.replace(
    new RegExp(`("${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*")([^"]+)(")`),
    (_full, pre, _cur, post) => {
      changed = true;
      return `${pre}^${safe}${post}`;
    },
  );
  return { text, changed };
}

export async function openDependencyFix(issue: Issue, env: NodeJS.ProcessEnv = siteEnv()): Promise<{ prUrl: string | null; message: string }> {
  const parsed = parseIssue(issue);
  if (!parsed) return { prUrl: null, message: 'This does not look like a dependency issue Plume can bump automatically.' };

  let g: Gh;
  try {
    g = ghFrom(env);
  } catch {
    return { prUrl: null, message: 'Connect a GitHub repository for this site first.' };
  }

  const { base, sha } = await ghBase(g, env);
  let manifestRaw: { content: string; sha: string };
  try {
    const f = await ghCall(g, 'GET', `/contents/package.json?ref=${encodeURIComponent(base)}`);
    manifestRaw = { content: Buffer.from(String(f.content ?? ''), 'base64').toString('utf8'), sha: f.sha };
  } catch {
    return { prUrl: null, message: 'Could not read package.json from the repository.' };
  }

  const { text, changed } = bumpInManifest(manifestRaw.content, parsed.name, parsed.safe);
  if (!changed) {
    return { prUrl: null, message: `${parsed.name} is not listed directly in package.json — it may be a sub-dependency. Update the package that brings it in, or run "npm audit fix".` };
  }

  const branch = `plume/bump-${parsed.name}-${Date.now().toString(36)}`;
  const title = `Security: update ${parsed.name} to a safe version`;
  const body = [
    `**Problem:** ${issue.title}`,
    `**Why it matters:** ${issue.why}`,
    `**What this changes:** raises \`${parsed.name}\` to \`^${parsed.safe}\` in \`package.json\`.`,
    '',
    '**Before merging:** run `npm install` on this branch to regenerate `package-lock.json`, then check the app still builds and the tests pass. Plume changed only the version requirement, not the lockfile, because npm resolves the full dependency tree on install.',
    '',
    '_Opened by Plume-Red. Please review before merging — Plume never merges anything itself._',
  ].join('\n');

  try {
    const pr = await ghPullRequest(g, { base, sha, branch, title, body }, async (b) => {
      await ghCall(g, 'PUT', `/contents/${ghPath('package.json')}`, {
        message: `Security: update ${parsed.name} to ^${parsed.safe}`,
        content: Buffer.from(text).toString('base64'),
        branch: b,
        sha: manifestRaw.sha,
      });
    });
    recordAction({ kind: 'code-pr', ref: issue.id, url: issue.url, title: issue.title, data: { prUrl: pr.url, files: ['package.json'] } });
    log('info', 'red', `opened ${pr.url} to bump ${parsed.name}`);
    return { prUrl: pr.url, message: `Opened a pull request to update ${parsed.name}.` };
  } catch (err: any) {
    if (err instanceof GhError && err.status === 409) return { prUrl: null, message: 'package.json changed on GitHub since Plume read it — try again.' };
    throw err;
  }
}
