import type { Issue } from '../agents/seoAudit';
import type { HeadResult } from './headers';

/**
 * Turns what the header-preserving fetch found into security issues, in the same shape as the SEO
 * audit (so they flow through the same report, dashboard, and fix flow). Every check here reads only
 * what the server already hands every visitor — nothing is sent that the site didn't already answer.
 *
 * Issue ids follow the existing `check:url` scheme, so the same problem on the same page isn't
 * reported twice.
 */

const add = (issues: Issue[], i: Omit<Issue, 'id'>) => issues.push({ ...i, id: `${i.check}:${i.url}` });

/** A header, why it matters in plain English, and what to add. Severity is how exposed the site is without it. */
interface HeaderRule {
  header: string;
  check: string;
  severity: Issue['severity'];
  title: string;
  why: string;
  value: string; // the recommended value, used in the fix snippet
}

const HEADER_RULES: HeaderRule[] = [
  {
    header: 'strict-transport-security',
    check: 'missing-hsts',
    severity: 'high',
    title: 'No HTTPS-only header (HSTS)',
    why: 'Without this header a visitor can be quietly downgraded to an unencrypted connection on their first visit, where their traffic can be read or changed.',
    value: 'max-age=31536000; includeSubDomains',
  },
  {
    header: 'content-security-policy',
    check: 'missing-csp',
    severity: 'medium',
    title: 'No Content-Security-Policy',
    why: 'This header is the main defence against injected scripts (cross-site scripting). Without it, a script that slips onto a page can do anything the page can.',
    value: "default-src 'self'",
  },
  {
    header: 'x-content-type-options',
    check: 'missing-x-content-type',
    severity: 'low',
    title: 'Missing X-Content-Type-Options',
    why: 'Without "nosniff", a browser may treat an uploaded file as a script and run it.',
    value: 'nosniff',
  },
  {
    header: 'x-frame-options',
    check: 'missing-x-frame-options',
    severity: 'medium',
    title: 'Page can be framed by other sites (clickjacking)',
    why: 'Without this, another site can load your page invisibly on top of its own and trick visitors into clicking things.',
    value: 'SAMEORIGIN',
  },
  {
    header: 'referrer-policy',
    check: 'missing-referrer-policy',
    severity: 'low',
    title: 'No Referrer-Policy',
    why: 'Without this, the full address of your page (which may carry private query values) is handed to every site a visitor clicks through to.',
    value: 'strict-origin-when-cross-origin',
  },
];

/** Security-header checks for one page's response. */
export function headerIssues(url: string, head: HeadResult): Issue[] {
  const issues: Issue[] = [];
  if (!head.ok) return issues; // a page we couldn't read tells us nothing about its headers
  for (const r of HEADER_RULES) {
    if (!head.headers[r.header]) {
      add(issues, {
        check: r.check,
        severity: r.severity,
        area: 'security',
        url,
        title: r.title,
        why: r.why,
        steps: [
          `Add the response header ${headerName(r.header)}: ${r.value}.`,
          'Where to set it depends on your host (a .htaccess file, your CDN/Cloudflare rules, or your framework’s config). Plume can open a pull request with the change if your site is on GitHub.',
        ],
        snippet: `${headerName(r.header)}: ${r.value}`,
      });
    }
  }
  return issues;
}

/** TLS / transport checks for the site as a whole. */
export function transportIssues(origin: string, httpsRedirect: boolean | undefined, homeHtml?: string): Issue[] {
  const issues: Issue[] = [];
  if (!origin.startsWith('https://')) {
    add(issues, {
      check: 'no-https',
      severity: 'critical',
      area: 'security',
      url: origin,
      title: 'Site is not served over HTTPS',
      why: 'Everything sent to and from an http:// site travels in clear text, where it can be read or changed on the way. Browsers mark these sites "Not secure".',
      steps: ['Turn on HTTPS for the site. Most hosts and CDNs (including Cloudflare) offer a free certificate in one click.'],
    });
    return issues; // the rest assumes https
  }
  if (httpsRedirect === false) {
    add(issues, {
      check: 'no-https-redirect',
      severity: 'high',
      area: 'security',
      url: origin,
      title: 'The http:// address does not redirect to https://',
      why: 'The secure site exists, but visitors who reach the plain http:// address stay there, unencrypted, instead of being sent to the secure one.',
      steps: ['Add a permanent redirect from http:// to https:// at your host or CDN.'],
    });
  }
  // Mixed content: a https page that pulls in http resources. Reads the home page HTML only.
  if (homeHtml) {
    const mixed = /\b(?:src|href)\s*=\s*["']http:\/\/[^"']+/i.test(homeHtml);
    if (mixed) {
      add(issues, {
        check: 'mixed-content',
        severity: 'medium',
        area: 'security',
        url: origin,
        title: 'Secure page loads some things over plain http',
        why: 'A padlocked page that pulls in images or scripts over http:// is only as safe as those parts — browsers may block them or warn the visitor.',
        steps: ['Change the http:// addresses in the page to https:// (or protocol-relative //).'],
      });
    }
  }
  return issues;
}

/**
 * CMS / builder version check. Reads the version a site volunteers in its HTML (the WordPress
 * generator meta tag, etc.) and flags it when it is at or below a version known to be vulnerable.
 * This reads only the public page; it does not probe the admin.
 */
interface VersionAdvisory {
  builder: string;
  /** Versions at or below this are flagged. */
  atOrBelow: string;
  note: string;
}

// A small bundled snapshot. A later follow-up refreshes this from a live advisory feed.
const VERSION_ADVISORIES: VersionAdvisory[] = [
  { builder: 'WordPress', atOrBelow: '6.4.2', note: 'Versions up to 6.4.2 have publicly known security fixes available in later releases.' },
];

/** Reads "WordPress 6.3" style strings from a generator meta tag. */
export function readGenerator(html: string): { builder: string; version?: string } | null {
  const m = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (!m) return null;
  const content = m[1].trim();
  const vm = content.match(/^([A-Za-z][A-Za-z ]*?)\s+([\d.]+)/);
  if (vm) return { builder: vm[1].trim(), version: vm[2] };
  return { builder: content };
}

/** Compares dotted versions: -1 if a<b, 0 if equal, 1 if a>b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function versionIssues(origin: string, html: string): Issue[] {
  const issues: Issue[] = [];
  const gen = readGenerator(html);
  if (!gen || !gen.version) return issues;
  for (const adv of VERSION_ADVISORIES) {
    if (gen.builder.toLowerCase() === adv.builder.toLowerCase() && cmpVersion(gen.version, adv.atOrBelow) <= 0) {
      add(issues, {
        check: `outdated-${adv.builder.toLowerCase()}`,
        severity: 'high',
        area: 'security',
        url: origin,
        title: `${adv.builder} ${gen.version} is out of date`,
        why: `${adv.note} Your pages still advertise version ${gen.version}.`,
        steps: [`Update ${adv.builder} to the latest version from its dashboard, then update your plugins/themes too.`],
      });
    }
  }
  return issues;
}

/** Response headers use a canonical capitalisation in the fix snippet, for copy-paste. */
function headerName(lower: string): string {
  const special: Record<string, string> = {
    'strict-transport-security': 'Strict-Transport-Security',
    'content-security-policy': 'Content-Security-Policy',
    'x-content-type-options': 'X-Content-Type-Options',
    'x-frame-options': 'X-Frame-Options',
    'referrer-policy': 'Referrer-Policy',
  };
  return special[lower] ?? lower;
}
