import { lookup } from 'dns/promises';
import { isIP } from 'net';

/** True for addresses on this machine or the local network, which a web page or the AI must never make us read. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, '');
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/** Refuse a URL that isn't plain http(s) or that points (by name or by DNS) at this machine or the local network. */
export async function assertPublicUrl(url: string | URL, lookupFn = lookup): Promise<URL> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http(s) pages can be read');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('local addresses are not allowed');
  const ips = isIP(host) ? [host] : (await lookupFn(host, { all: true }).catch(() => [])).map((r) => r.address);
  if (ips.some(isPrivateAddress)) throw new Error('local addresses are not allowed');
  return u;
}

/**
 * fetch() that re-checks every redirect hop, so a public page can't bounce us to localhost or the local network.
 * (A check made only on the first address is not enough: redirects are followed silently.)
 */
export async function fetchPublic(url: string | URL, init: RequestInit = {}, maxHops = 5): Promise<Response> {
  let current = await assertPublicUrl(url);
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc) return res;
    if (hop >= maxHops) throw new Error('too many redirects');
    current = await assertPublicUrl(new URL(loc, current));
  }
}
