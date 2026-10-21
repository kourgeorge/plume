import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';
import { currentSite, siteDir } from '../site';
import { GLOBAL_MIGRATIONS, Migration, SITE_MIGRATIONS } from './schema';

let globalDb: Database.Database | null = null;
const siteDbs = new Map<string, Database.Database>();

/** Bring a database up to the newest version of its tables. Each step is all or nothing. */
export function migrate(d: Database.Database, steps: Migration[]): void {
  const have = d.pragma('user_version', { simple: true }) as number;
  for (const step of steps) {
    if (step.version <= have) continue;
    d.transaction(() => {
      d.exec(step.sql);
      d.pragma(`user_version = ${step.version}`);
    })();
  }
}

function open(file: string, steps: Migration[]): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  migrate(d, steps);
  return d;
}

/** The shared database (site list, AI usage, logs, app-wide settings). */
export function getGlobalDb(): Database.Database {
  if (globalDb) return globalDb;
  globalDb = open(path.join(DATA_DIR, 'plume.db'), GLOBAL_MIGRATIONS);
  return globalDb;
}

/** The database of the site this request or job is for (see `withSite`). */
export function getDb(slug = currentSite()): Database.Database {
  let d = siteDbs.get(slug);
  if (!d) {
    d = open(path.join(siteDir(slug), 'site.db'), SITE_MIGRATIONS);
    siteDbs.set(slug, d);
  }
  return d;
}

/** Close a site's database (before deleting its folder). */
export function closeSiteDb(slug: string): void {
  siteDbs.get(slug)?.close();
  siteDbs.delete(slug);
}

export function resetDbForTests(): void {
  for (const d of siteDbs.values()) d.close();
  siteDbs.clear();
  globalDb?.close();
  globalDb = null;
}

/** Settings for the current site. */
export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

/** Settings shared by all sites (e.g. the monthly AI budget). */
export function getGlobalSetting<T>(key: string, fallback: T): T {
  const row = getGlobalDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}

export function setGlobalSetting(key: string, value: unknown): void {
  getGlobalDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
