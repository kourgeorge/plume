import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';
import { DATA_DIR } from './config';

/**
 * Which website the current request or background job belongs to. Every database call reads it,
 * so two sites' jobs running at the same time never mix their data.
 */
const als = new AsyncLocalStorage<{ slug: string }>();

/** Run `fn` (and everything it starts, awaited or not) as work for this site. */
export function withSite<T>(slug: string, fn: () => T): T {
  return als.run({ slug }, fn);
}

export function currentSiteOrNull(): string | null {
  return als.getStore()?.slug ?? process.env.PLUME_SITE ?? null;
}

export function currentSite(): string {
  const s = currentSiteOrNull();
  if (!s) throw new Error('no website selected');
  return s;
}

/** Folder name for a site: its hostname without "www.", e.g. "acme.co.il". */
export function slugFor(url: string): string {
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    throw new Error(`"${url}" is not a website address`);
  }
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) throw new Error(`"${url}" is not a website address`);
  return host;
}

export function isSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9.-]*$/.test(s) && !s.includes('..');
}

export function siteDir(slug = currentSite()): string {
  if (!isSlug(slug)) throw new Error(`bad site name "${slug}"`);
  return path.join(DATA_DIR, 'sites', slug);
}

export function profileDir(slug = currentSite()): string {
  return path.join(siteDir(slug), 'profile');
}
