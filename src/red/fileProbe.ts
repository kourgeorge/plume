import type { Issue } from '../agents/seoAudit';
import { withId } from '../issueId';

/**
 * Checks whether the live site exposes files it never should — a leaked `.env`, an open `.git`
 * folder, an editor backup of a config file. Unlike the header/TLS checks, this actively asks the
 * server for specific paths, so it runs ONLY when ownership is verified (see ownership.ts) and only
 * for a short, fixed list. It never follows links, never guesses deeply, and asks for each path once.
 */

const add = (issues: Issue[], i: Omit<Issue, 'id'>) => issues.push(withId(i));

interface ProbeTarget {
  path: string;
  check: string;
  title: string;
  why: string;
  /** A short signature we expect in the body, so a soft-404 that returns 200 with a normal page isn't a false alarm. */
  signature: RegExp;
}

const TARGETS: ProbeTarget[] = [
  {
    path: '/.env',
    check: 'exposed-env',
    title: 'Environment file (.env) is reachable from the web',
    why: 'A .env file holds passwords, API keys, and database details in plain text. If it can be downloaded, so can everything in it.',
    signature: /^[A-Z0-9_]+\s*=/m,
  },
  {
    path: '/.git/HEAD',
    check: 'exposed-git',
    title: 'The .git folder is reachable from the web',
    why: 'An exposed .git folder lets anyone download your whole source history, including anything secret that was ever committed.',
    signature: /^ref:\s+refs\//m,
  },
  {
    path: '/wp-config.php~',
    check: 'exposed-wp-config-backup',
    title: 'A backup of wp-config.php is reachable',
    why: 'Editor backups like wp-config.php~ are served as plain text, exposing the WordPress database password and secret keys.',
    signature: /DB_(PASSWORD|NAME|USER)/,
  },
  {
    path: '/.DS_Store',
    check: 'exposed-ds-store',
    title: '.DS_Store file is published',
    why: 'This macOS file lists the names of everything in the folder, handing an attacker a map of files that were not meant to be found.',
    signature: /Bud1|\x00\x00\x00/,
  },
];

export async function probeFiles(origin: string, fetchFn: typeof fetch = fetch): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const t of TARGETS) {
    const url = origin.replace(/\/$/, '') + t.path;
    let res: Response;
    try {
      res = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch {
      continue; // unreachable path tells us nothing
    }
    if (res.status !== 200) continue;
    const body = (await res.text().catch(() => '')).slice(0, 4000);
    if (!t.signature.test(body)) continue; // 200 but not the real thing (a soft 404 / SPA catch-all)
    add(issues, {
      check: t.check,
      severity: 'critical',
      area: 'security',
      url,
      title: t.title,
      why: t.why,
      steps: [
        `Block web access to ${t.path} at your server or CDN, and make sure the file is not in your web root.`,
        'If it held any secrets, treat them as leaked and rotate them.',
      ],
    });
  }
  return issues;
}
