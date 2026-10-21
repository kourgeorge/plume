import type { AuditResult, Issue, Severity } from '../agents/seoAudit';
import { getDb, setSetting } from '../db';
import { log } from '../log';
import { siteEnv } from '../integrations';
import { fetchHeaders } from './headers';
import { headerIssues, transportIssues, versionIssues } from './checks';
import { scanRepo } from './repoScan';
import { probeFiles } from './fileProbe';
import { redPermissions, RedPermissions } from './ownership';
import { cleanUrl } from '../issueId';
import { recordScan } from '../issues';

/**
 * Plume-Red: the security side of Plume. One scan that runs each tier of checks only as far as the
 * site's connection allows (see ownership.ts), and never runs active testing without an explicit OK.
 *
 * The result is the same shape the SEO audit produces, so it shows up in the report, the dashboard,
 * and (for the issues that have a code fix) the pull-request flow, with no new machinery.
 */

export interface RedScanOptions {
  /** The site's address, e.g. https://acme.test. Without it only repo checks can run. */
  origin?: string;
  /** The user ticked "also run active, non-destructive tests" for THIS scan. Ignored unless ownership is verified. */
  approveActive?: boolean;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

export interface RedScanResult extends AuditResult {
  /** What the gate allowed, so the UI can explain why some checks were skipped. */
  permissions: RedPermissions;
  /** Plain-English notes about checks that were skipped and why. */
  skipped: string[];
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** A handful of pages to check headers on: the home page plus whatever else was crawled, capped. */
function pagesToCheck(origin: string | undefined): string[] {
  if (!origin) return [];
  const urls = new Set<string>([origin.replace(/\/$/, '') + '/']);
  try {
    const rows = getDb().prepare('SELECT url FROM pages WHERE status < 400 ORDER BY url LIMIT 10').all() as { url: string }[];
    for (const r of rows) urls.add(r.url);
  } catch {
    // no crawl yet — just the home page
  }
  return [...urls].slice(0, 10);
}

export async function runRedScan(opts: RedScanOptions = {}): Promise<RedScanResult> {
  const env = opts.env ?? siteEnv();
  const fetchFn = opts.fetchFn ?? fetch;
  const perms = redPermissions(env);
  const skipped: string[] = [];
  const issues: Issue[] = [];

  if (!perms.enabled) {
    skipped.push(perms.reason);
    return finish(issues, perms, skipped, 0);
  }

  let pagesChecked = 0;
  // What ran this time, so only those parts can say a problem is gone (see `covers` below).
  const ran = { headersOn: new Set<string>(), transport: false, home: false, repo: false, files: false, active: false };

  // Tier A: passive header / TLS / version checks on what the server already returns.
  if (perms.passiveHeaders && opts.origin) {
    const origin = opts.origin.replace(/\/$/, '');
    const pages = pagesToCheck(origin);
    let homeHtml: string | undefined;
    for (const url of pages) {
      const head = await fetchHeaders(url, fetchFn);
      issues.push(...headerIssues(url, head));
      pagesChecked++;
      if (head.ok) ran.headersOn.add(cleanUrl(url));
      if (url === origin + '/' && head.ok) {
        // Read the home page body once, for mixed-content and version checks.
        try {
          const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000) });
          homeHtml = (await res.text()).slice(0, 500_000);
        } catch {
          /* leave undefined */
        }
      }
    }
    issues.push(...transportIssues(origin, homeHtml));
    if (homeHtml) issues.push(...versionIssues(origin, homeHtml));
    ran.transport = true;
    ran.home = !!homeHtml;
  } else if (!opts.origin) {
    skipped.push('No site address, so header and TLS checks were skipped.');
  }

  // Tier B: repo-based checks (dependencies, committed secrets).
  if (perms.repoScan) {
    try {
      issues.push(...(await scanRepo(env)));
      ran.repo = true;
    } catch (e) {
      log('warn', 'red', `repo scan failed: ${e instanceof Error ? e.message : e}`);
      skipped.push('Could not read the connected repository this time.');
    }
  } else {
    skipped.push('No GitHub repository connected, so dependency and secret checks were skipped.');
  }

  // Tier C: live file-probe. Verified ownership only.
  if (perms.fileProbe && opts.origin) {
    issues.push(...(await probeFiles(opts.origin, fetchFn)));
    ran.files = true;
  } else if (opts.origin) {
    skipped.push('Exposed-file checks need Search Console connected (Google verifies you own the domain first).');
  }

  // Active testing: verified ownership AND an explicit per-scan approval.
  if (opts.approveActive) {
    if (perms.activeTesting) {
      const { runActiveTests } = await import('./active');
      issues.push(...(await runActiveTests(opts.origin!, fetchFn)));
      ran.active = true;
    } else {
      skipped.push('Active tests were requested but need Search Console connected first; they did not run.');
    }
  }

  const result = finish(issues, perms, skipped, pagesChecked);
  if (perms.enabled) recordScan(result.issues, { agent: 'red', at: result.at, covers: redCovers(ran) });
  return result;
}

const HEADER_CHECKS = new Set(['missing-csp', 'missing-hsts', 'missing-referrer-policy', 'missing-x-content-type', 'missing-x-frame-options']);
const FILE_CHECKS = new Set(['exposed-ds-store', 'exposed-env', 'exposed-git', 'exposed-wp-config-backup']);
const ACTIVE_CHECK = /^(reflected-input|sql-injection|cors-reflects-origin|open-redirect-|cookie-flags-)/;

/** Which earlier problems this scan could have found again: only the parts that ran, on the pages they read. */
function redCovers(ran: { headersOn: Set<string>; transport: boolean; home: boolean; repo: boolean; files: boolean; active: boolean }): (check: string, url: string) => boolean {
  return (check, url) => {
    if (check === 'no-https') return ran.transport;
    if (HEADER_CHECKS.has(check)) return ran.headersOn.has(cleanUrl(url));
    if (FILE_CHECKS.has(check)) return ran.files;
    if (ACTIVE_CHECK.test(check)) return ran.active;
    if (url.startsWith('repo:')) return ran.repo;
    // Mixed content and an outdated builder come from reading the home page.
    return ran.home;
  };
}

function finish(issues: Issue[], permissions: RedPermissions, skipped: string[], pagesChecked: number): RedScanResult {
  // Drop duplicate ids (same problem found twice), then order most severe first.
  const seen = new Set<string>();
  const unique = issues.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  unique.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.url.localeCompare(b.url));

  const WEIGHT: Record<Severity, number> = { critical: 10, high: 6, medium: 3, low: 1 };
  const penalty = unique.reduce((s, i) => s + WEIGHT[i.severity], 0);
  // A clean scan scores 100; the score falls as issues pile up. Kept on the same 0–100 scale as the SEO audit.
  const score = penalty ? Math.max(0, Math.round(100 * (1 - penalty / (penalty + 20)))) : 100;

  const result: RedScanResult = {
    score,
    counts: {
      critical: unique.filter((i) => i.severity === 'critical').length,
      warnings: unique.filter((i) => i.severity !== 'critical').length,
      passed: 0,
    },
    issues: unique,
    pagesChecked,
    at: new Date().toISOString(),
    permissions,
    skipped,
  };
  try {
    setSetting('lastRedScan', result);
  } catch {
    /* settings not available in some test contexts */
  }
  return result;
}
