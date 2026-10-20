import type { Issue } from '../agents/seoAudit';

/**
 * Active, NON-DESTRUCTIVE testing. This is the only part of Plume-Red that sends input the site
 * didn't already answer for, so it runs only when ownership is verified (Search Console) AND the
 * user approved it for this scan (see scan.ts).
 *
 * It DETECTS vulnerability classes (reflected XSS, SQL injection, open redirect, CORS, cookie flags)
 * using safe signals, and reports what it finds. The line it does not cross: it never sends a payload
 * that changes or reads data, times the server, fuzzes, or brute-forces. The difference between
 * detection and exploitation is the whole point — we confirm a hole exists from how the page reacts
 * to benign input (an unbalanced quote, a reflected marker, a made-up origin), not by making the
 * site do something it shouldn't. That boundary holds even with ownership verified: an unattended
 * marketing tool must not be able to damage the very site it is checking, and deeper confirmation is
 * a job for a scoped pentest with a human watching, not for this.
 *
 * Each check makes one or two requests and stops.
 */

const add = (issues: Issue[], i: Omit<Issue, 'id'>) => issues.push({ ...i, id: `${i.check}:${i.url}` });

/** A marker that is obvious in a page and can't be mistaken for anything else, but does nothing if run. */
const MARKER = 'plumeRedCheck1337';

/**
 * Reflected-input check: ask the home page with a query value and see if it comes back into the HTML
 * without being escaped. Unescaped reflection is the tell-tale of a cross-site-scripting hole. We
 * look for the bare marker inside an HTML context, not for a working script — we never send one.
 */
async function reflectedInput(origin: string, fetchFn: typeof fetch): Promise<Issue[]> {
  const issues: Issue[] = [];
  const probe = `${origin.replace(/\/$/, '')}/?q=<${MARKER}>`;
  let html = '';
  try {
    const res = await fetchFn(probe, { signal: AbortSignal.timeout(15_000) });
    html = (await res.text()).slice(0, 500_000);
  } catch {
    return issues;
  }
  // Reflected and NOT escaped: the raw "<plumeRedCheck1337>" appears. An escaped site shows "&lt;plumeRedCheck1337&gt;".
  if (html.includes(`<${MARKER}>`)) {
    add(issues, {
      check: 'reflected-input',
      severity: 'high',
      area: 'security',
      url: origin,
      title: 'The page echoes part of the web address back without escaping it',
      why: 'When a page puts something from the address straight into the HTML without escaping it, an attacker can craft a link that runs their script in your visitors’ browsers (cross-site scripting).',
      steps: [
        'Escape any value from the query string before putting it in the page (most frameworks do this if you use their templating instead of building HTML by hand).',
        'Add a Content-Security-Policy header as a second line of defence.',
      ],
    });
  }
  return issues;
}

/**
 * Open-redirect check: many sites take a "next"/"url" parameter to send the visitor on after an
 * action. If it will send them to any outside address, it can be used in phishing. We point it at a
 * harmless marker host and see whether the site is willing to redirect there — we do not actually
 * follow it anywhere.
 */
async function openRedirect(origin: string, fetchFn: typeof fetch): Promise<Issue[]> {
  const issues: Issue[] = [];
  const target = `https://${MARKER}.example.com/`;
  for (const param of ['next', 'url', 'redirect', 'return']) {
    const probe = `${origin.replace(/\/$/, '')}/?${param}=${encodeURIComponent(target)}`;
    let location: string | null = null;
    try {
      const res = await fetchFn(probe, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      location = res.headers.get('location');
    } catch {
      continue;
    }
    if (location && location.includes(`${MARKER}.example.com`)) {
      add(issues, {
        check: `open-redirect-${param}`,
        severity: 'medium',
        area: 'security',
        url: origin,
        title: `The "${param}" parameter will redirect visitors to any outside site`,
        why: 'An open redirect lets an attacker send a link that looks like it goes to your site but bounces the visitor to theirs — handy for phishing, and it borrows your site’s good name.',
        steps: [`Only allow "${param}" to redirect to paths on your own site, or to an allowed list of addresses.`],
      });
      break; // one finding is enough to make the point
    }
  }
  return issues;
}

/**
 * SQL-injection DETECTION, not exploitation. The difference matters: an exploit confirms a hole by
 * making the database do something (return extra rows, sleep, error out in a way that dumps data) —
 * which changes or leaks data. Here we only compare how the page answers a single unbalanced quote
 * against a balanced pair. A page that breaks on the odd quote (a database error signature, or a
 * 500) but is fine with the balanced one is passing our input into a query unsafely. We never send a
 * payload that would change data, read other rows, or time-delay the server.
 */
async function sqlInjection(origin: string, fetchFn: typeof fetch): Promise<Issue[]> {
  const issues: Issue[] = [];
  const base = origin.replace(/\/$/, '');
  const get = async (q: string): Promise<{ status: number; body: string } | null> => {
    try {
      const res = await fetchFn(`${base}/?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(15_000) });
      return { status: res.status, body: (await res.text()).slice(0, 20_000) };
    } catch {
      return null;
    }
  };
  // One unbalanced quote vs. the same input with the quote balanced. Benign either way.
  const odd = await get(`${MARKER}'`);
  const even = await get(`${MARKER}''`);
  if (!odd || !even) return issues;

  const DB_ERROR = /SQL syntax|mysql_fetch|ORA-\d{5}|PostgreSQL.*ERROR|SQLiteException|syntax error at or near|Unclosed quotation mark|System\.Data\.SqlClient/i;
  const oddBroke = DB_ERROR.test(odd.body) || (odd.status >= 500 && even.status < 500);
  const evenFine = !DB_ERROR.test(even.body) && even.status < 500;
  if (oddBroke && evenFine) {
    add(issues, {
      check: 'sql-injection',
      severity: 'critical',
      area: 'security',
      url: origin,
      title: 'A value from the web address reaches the database unsafely (SQL injection)',
      why: 'The page breaks on a single quote in the address but not on a balanced pair — the tell-tale that your input is dropped straight into a database query. An attacker could read or change data this way. (Plume only detected this; it did not read or change anything.)',
      steps: [
        'Use parameterised queries / prepared statements so input is never part of the SQL text. Most frameworks and ORMs do this for you.',
        'This finding is worth a careful look by whoever maintains the site’s code.',
      ],
    });
  }
  return issues;
}

/**
 * CORS misconfiguration: does the site reflect ANY origin back as allowed, with credentials? That
 * combination lets any website read a logged-in user's private responses. One request, reading only
 * the response headers.
 */
async function corsCheck(origin: string, fetchFn: typeof fetch): Promise<Issue[]> {
  const issues: Issue[] = [];
  const evil = `https://${MARKER}.example.com`;
  try {
    const res = await fetchFn(origin, { headers: { origin: evil }, signal: AbortSignal.timeout(15_000) });
    const allow = res.headers.get('access-control-allow-origin');
    const creds = res.headers.get('access-control-allow-credentials');
    if (allow === evil && creds === 'true') {
      add(issues, {
        check: 'cors-reflects-origin',
        severity: 'high',
        area: 'security',
        url: origin,
        title: 'The site tells any website it may read private responses (CORS)',
        why: 'The site echoed back a made-up website as an allowed origin and said credentials are allowed. Together, that lets any site a logged-in visitor opens read their private data from yours.',
        steps: ['Only allow the specific sites you trust in Access-Control-Allow-Origin — never reflect whatever origin asked, together with credentials.'],
      });
    }
  } catch {
    /* unreachable */
  }
  return issues;
}

/** Login/session cookies without Secure/HttpOnly flags, read from the home-page response. */
async function cookieFlags(origin: string, fetchFn: typeof fetch): Promise<Issue[]> {
  const issues: Issue[] = [];
  try {
    const res = await fetchFn(origin, { signal: AbortSignal.timeout(15_000) });
    // Node's fetch joins multiple Set-Cookie headers; getSetCookie keeps them separate when available.
    const cookies: string[] = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : [res.headers.get('set-cookie') ?? ''].filter(Boolean);
    for (const c of cookies) {
      const name = c.split('=')[0].trim();
      const looksSession = /sess|auth|token|login|sid/i.test(name);
      if (!looksSession) continue;
      const missing = [!/;\s*Secure/i.test(c) && 'Secure', !/;\s*HttpOnly/i.test(c) && 'HttpOnly'].filter(Boolean);
      if (missing.length) {
        add(issues, {
          check: `cookie-flags-${name}`,
          severity: 'medium',
          area: 'security',
          url: origin,
          title: `The "${name}" cookie is missing ${missing.join(' and ')}`,
          why: 'A session cookie without Secure can be sent over plain http where it can be stolen; without HttpOnly a script on the page can read it. Either one makes hijacking a logged-in session easier.',
          steps: [`Set ${missing.join(' and ')} on the "${name}" cookie wherever your app creates it.`],
        });
      }
    }
  } catch {
    /* unreachable */
  }
  return issues;
}

export async function runActiveTests(origin: string, fetchFn: typeof fetch = fetch): Promise<Issue[]> {
  if (!origin) return [];
  const issues: Issue[] = [];
  issues.push(...(await reflectedInput(origin, fetchFn)));
  issues.push(...(await openRedirect(origin, fetchFn)));
  issues.push(...(await sqlInjection(origin, fetchFn)));
  issues.push(...(await corsCheck(origin, fetchFn)));
  issues.push(...(await cookieFlags(origin, fetchFn)));
  return issues;
}
