import { USER_AGENT } from '../research/fetchPage';

/**
 * A fetch that keeps the response headers. The normal crawl throws them away (it only needs the
 * HTML), but the security header and TLS checks are entirely about the headers, so Plume-Red does
 * its own small request — one per origin plus a couple of key pages — rather than re-reading the
 * whole site.
 *
 * This only ever reads what the server already sends to every visitor. It follows redirects (so an
 * http:// → https:// hop is seen) and never sends a body.
 */
export interface HeadResult {
  ok: boolean;
  url: string; // after redirects
  status: number;
  headers: Record<string, string>;
  /** Set when the request itself failed (DNS, timeout) rather than returning a status. */
  error?: string;
}

function flatten(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export async function fetchHeaders(url: string, fetchFn: typeof fetch = fetch): Promise<HeadResult> {
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    return { ok: res.ok, url: res.url || url, status: res.status, headers: flatten(res.headers) };
  } catch (e) {
    return { ok: false, url, status: 0, headers: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Does the plain-http address get sent on to https? A security check (not just SEO): a site served
 * over http with no redirect leaks every request in clear text. Returns undefined when http can't be
 * reached at all, so the check is skipped rather than guessed.
 */
export async function httpRedirectsToHttps(origin: string, fetchFn: typeof fetch = fetch): Promise<boolean | undefined> {
  const httpUrl = origin.replace(/^https:/, 'http:');
  const r = await fetchHeaders(httpUrl, fetchFn);
  if (!r.ok && r.status === 0) return undefined;
  return r.url.startsWith('https:');
}
