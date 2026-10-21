import type { Issue } from '../agents/seoAudit';
import { Gh, ghBase, ghCall, ghFrom, ghPath } from '../github';
import { siteEnv } from '../integrations';
import { withId } from '../issueId';

/**
 * Security checks that read the connected GitHub repository: known-vulnerable dependencies and
 * secrets committed by accident. These only read files from a repo the user linked (the token is
 * scoped to it), so they are allowed whenever a repo is connected. No site is contacted.
 */

const add = (issues: Issue[], i: Omit<Issue, 'id'>) => issues.push(withId(i));

/** A dependency and the version at or below which it is known vulnerable. Bundled snapshot; a later follow-up refreshes it. */
interface DepAdvisory {
  name: string;
  ecosystem: 'npm' | 'composer';
  atOrBelow: string;
  severity: Issue['severity'];
  note: string;
}

const DEP_ADVISORIES: DepAdvisory[] = [
  { name: 'lodash', ecosystem: 'npm', atOrBelow: '4.17.20', severity: 'high', note: 'Prototype-pollution fixes landed in 4.17.21.' },
  { name: 'axios', ecosystem: 'npm', atOrBelow: '0.21.1', severity: 'high', note: 'Server-side request forgery fixed in 0.21.2.' },
  { name: 'minimist', ecosystem: 'npm', atOrBelow: '1.2.5', severity: 'medium', note: 'Prototype-pollution fixed in 1.2.6.' },
];

function cmpVersion(a: string, b: string): number {
  const clean = (s: string) => s.replace(/[^\d.].*$/, '');
  const pa = clean(a).split('.').map(Number);
  const pb = clean(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Pulls {name: version} from a package-lock.json (v2/v3 "packages" or v1 "dependencies"). */
export function parsePackageLock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  if (json.packages) {
    for (const [p, info] of Object.entries<any>(json.packages)) {
      if (!p) continue; // "" is the root project
      const name = p.replace(/^node_modules\//, '').replace(/.*\/node_modules\//, '');
      if (info?.version) out[name] = info.version;
    }
  }
  if (json.dependencies) {
    const walk = (deps: any) => {
      for (const [name, info] of Object.entries<any>(deps)) {
        if (info?.version) out[name] = info.version;
        if (info?.dependencies) walk(info.dependencies);
      }
    };
    walk(json.dependencies);
  }
  return out;
}

export function dependencyIssues(repoLabel: string, installed: Record<string, string>): Issue[] {
  const issues: Issue[] = [];
  for (const adv of DEP_ADVISORIES) {
    const have = installed[adv.name];
    if (have && cmpVersion(have, adv.atOrBelow) <= 0) {
      add(issues, {
        check: `vulnerable-dependency-${adv.name}`,
        severity: adv.severity,
        area: 'security',
        url: `repo:${repoLabel}/${adv.name}`, // not a page; repoScan results key on the repo, not a URL
        title: `${adv.name} ${have} has a known security fix`,
        why: `${adv.note} Your project locks ${adv.name} at ${have}.`,
        steps: [`Update ${adv.name} past ${adv.atOrBelow} (for npm: run "npm update ${adv.name}" or raise it in package.json, then commit the new lockfile).`],
      });
    }
  }
  return issues;
}

/** Patterns for secrets that should never be committed. Kept deliberately specific to avoid false alarms. */
const SECRET_PATTERNS: { check: string; label: string; re: RegExp }[] = [
  { check: 'secret-aws-key', label: 'an AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { check: 'secret-stripe-live', label: 'a live Stripe secret key', re: /sk_live_[0-9a-zA-Z]{24,}/ },
  { check: 'secret-google-api', label: 'a Google API key', re: /AIza[0-9A-Za-z_\-]{35}/ },
  { check: 'secret-private-key', label: 'a private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

/** Files that are meant to hold examples, not real secrets, so a match there is only a low note. */
const EXAMPLE_FILE = /(^|\/)(\.env\.example|\.env\.sample|example\.|sample\.)/i;

export function secretIssues(repoLabel: string, path: string, text: string): Issue[] {
  const issues: Issue[] = [];
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) {
      const isExample = EXAMPLE_FILE.test(path);
      add(issues, {
        check: `${p.check}:${path}`,
        severity: isExample ? 'low' : 'critical',
        area: 'security',
        url: `repo:${repoLabel}/${path}`,
        title: `${isExample ? 'Possible' : 'Committed'} secret in ${path}`,
        why: isExample
          ? `This looks like ${p.label} in an example file. If it is a placeholder, ignore it; if it is real, it is public to anyone who can see the repository.`
          : `${path} appears to contain ${p.label}. Anyone who can read the repository (and anyone in its history) can use it.`,
        steps: [
          'Treat the key as leaked: rotate it (make a new one, delete the old) with the provider now.',
          `Remove it from ${path} and load it from an environment variable instead.`,
          'Removing it in a new commit does not erase it from history — rotating is what makes it safe.',
        ],
      });
    }
  }
  return issues;
}

/** Files worth scanning for secrets. Keeps the request count small. */
const SCAN_FOR_SECRETS = /(^|\/)(\.env(\..*)?|config\.(js|json|yml|yaml|php)|settings\.py|credentials|.*\.pem)$/i;
const MAX_SECRET_FILE = 100_000;

/**
 * Runs the repo-based checks against the connected repository. Reads the dependency lockfile(s) and a
 * small set of likely-secret-holding files. Returns [] when no repo is connected.
 */
export async function scanRepo(env: NodeJS.ProcessEnv = siteEnv()): Promise<Issue[]> {
  let g: Gh;
  try {
    g = ghFrom(env);
  } catch {
    return [];
  }
  const issues: Issue[] = [];
  const { base, sha } = await ghBase(g, env);
  const tree: { path: string; size: number }[] = ((await ghCall(g, 'GET', `/git/trees/${sha}?recursive=1`)).tree ?? [])
    .filter((t: any) => t.type === 'blob')
    .map((t: any) => ({ path: t.path, size: t.size ?? 0 }));

  const readFile = async (p: string): Promise<string> => {
    const f = await ghCall(g, 'GET', `/contents/${ghPath(p)}?ref=${encodeURIComponent(base)}`);
    return Buffer.from(String(f.content ?? ''), 'base64').toString('utf8');
  };

  // Dependencies: the root package-lock.json, when present.
  const lock = tree.find((t) => t.path === 'package-lock.json');
  if (lock && lock.size <= 2_000_000) {
    issues.push(...dependencyIssues(g.repo, parsePackageLock(await readFile('package-lock.json'))));
  }

  // Secrets: a handful of likely files, skipping big ones.
  const secretFiles = tree.filter((t) => SCAN_FOR_SECRETS.test(t.path) && t.size <= MAX_SECRET_FILE).slice(0, 20);
  for (const f of secretFiles) {
    issues.push(...secretIssues(g.repo, f.path, await readFile(f.path)));
  }
  return issues;
}
