/**
 * How every problem gets its id: the kind of check, then the address it is about, written one way.
 * The same problem must get the same id from every scan and every checker, because "fixed",
 * "won't fix" and pull requests are all kept against it.
 */

/** One way to write an address: no #part, no ?query, no trailing slash except on the home page, lower-case host. */
export function cleanUrl(u: string): string {
  // Repository files ("repo:owner/name/path") and other non-web keys are already stable.
  if (!/^https?:\/\//i.test(u)) return u;
  try {
    const x = new URL(u);
    x.hash = '';
    x.search = '';
    let s = x.toString();
    if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return u;
  }
}

export function issueId(check: string, url: string): string {
  return `${check}:${cleanUrl(url)}`;
}

/** Give a problem its id, with its address cleaned the same way. */
export function withId<T extends { check: string; url: string }>(i: T): T & { id: string } {
  const url = cleanUrl(i.url);
  return { ...i, url, id: issueId(i.check, url) };
}
