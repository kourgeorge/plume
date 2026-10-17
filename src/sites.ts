import fs from 'fs';
import { closeSiteDb, getDb, getGlobalDb } from './db';
import { currentSiteOrNull, siteDir, slugFor, withSite } from './site';
import { PROFILE_DOCS, readDoc } from './context/profile';

export interface Site {
  slug: string;
  url: string;
  name: string;
  createdAt: string;
  lastOpenedAt: string | null;
}

export interface SiteSummary extends Site {
  docsWritten: number;
  docsTotal: number;
  waiting: number;
  published: number;
}

function row(r: any): Site {
  return { slug: r.slug, url: r.url, name: r.name, createdAt: r.created_at, lastOpenedAt: r.last_opened_at };
}

export function listSites(): Site[] {
  return getGlobalDb().prepare('SELECT * FROM sites ORDER BY COALESCE(last_opened_at, created_at) DESC').all().map(row);
}

export function getSite(slug: string): Site | undefined {
  const r = getGlobalDb().prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
  return r ? row(r) : undefined;
}

/** Each site with a few numbers for the site list. Reads every site's own database. */
export function siteSummaries(): SiteSummary[] {
  return listSites().map((s) =>
    withSite(s.slug, () => {
      const count = (status: string) => (getDb().prepare('SELECT COUNT(*) n FROM drafts WHERE status = ?').get(status) as { n: number }).n;
      return { ...s, docsWritten: PROFILE_DOCS.filter((d) => readDoc(d.id) !== null).length, docsTotal: PROFILE_DOCS.length, waiting: count('draft'), published: count('published') };
    }),
  );
}

/** Register a website and give it its own folder. Adding one that exists returns the existing one. */
export function addSite(rawUrl: string): { site: Site; created: boolean } {
  const slug = slugFor(rawUrl);
  const existing = getSite(slug);
  if (existing) return { site: existing, created: false };
  const u = new URL(/^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`);
  const url = `${u.protocol}//${u.hostname.toLowerCase()}`;
  getGlobalDb().prepare('INSERT INTO sites (slug, url, name, created_at) VALUES (?, ?, ?, ?)').run(slug, url, slug, new Date().toISOString());
  return { site: getSite(slug)!, created: true };
}

/** The current site's address, from the site list (the only place it is stored). */
export function siteUrl(): string | null {
  const slug = currentSiteOrNull();
  return slug ? (getSite(slug)?.url ?? null) : null;
}

export function touchSite(slug: string): void {
  getGlobalDb().prepare('UPDATE sites SET last_opened_at = ? WHERE slug = ?').run(new Date().toISOString(), slug);
}

export function renameSite(slug: string, name: string): Site {
  if (!getSite(slug)) throw new Error(`no site ${slug}`);
  getGlobalDb().prepare('UPDATE sites SET name = ? WHERE slug = ?').run(name.trim() || slug, slug);
  return getSite(slug)!;
}

/** Remove a site and delete its folder (documents, drafts, results). AI usage and logs stay, for the budget. */
export function removeSite(slug: string): void {
  if (!getSite(slug)) throw new Error(`no site ${slug}`);
  closeSiteDb(slug);
  fs.rmSync(siteDir(slug), { recursive: true, force: true });
  getGlobalDb().prepare('DELETE FROM sites WHERE slug = ?').run(slug);
}
