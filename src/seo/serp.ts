import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';
import { getDb, getSetting, setSetting } from '../db';
import { contentLanguage, contentLanguages, pageLanguageOf } from '../context/language';
import { siteUrl } from '../sites';
import { listTracked } from './rankings';

/**
 * "Who outranks you": the top Google results for each tracked search. Google doesn't offer this,
 * so it uses DataForSEO (pay per lookup, roughly $0.002 each). Off until the owner adds a login.
 * The login is an account the owner pays for, so it is shared by all sites, like the AI connection.
 */

export const SERP_API = { base: 'https://api.dataforseo.com' };

interface Creds {
  login: string;
  password: string;
}

const credsFile = () => path.join(DATA_DIR, 'tokens', 'dataforseo.json');

export function serpCreds(env = process.env): Creds | null {
  try {
    const c = JSON.parse(fs.readFileSync(credsFile(), 'utf8'));
    if (c?.login && c?.password) return c;
  } catch {
    /* nothing saved */
  }
  return env.DATAFORSEO_LOGIN && env.DATAFORSEO_PASSWORD ? { login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD } : null;
}

export function saveSerpCreds(login: string, password: string): void {
  const l = String(login ?? '').trim();
  const p = String(password ?? '').trim() || serpCreds()?.password || '';
  if (!l || !p) throw new Error('enter the DataForSEO login (your account email) and API password');
  fs.mkdirSync(path.dirname(credsFile()), { recursive: true });
  fs.writeFileSync(credsFile(), JSON.stringify({ login: l, password: p }, null, 2), { mode: 0o600 });
  fs.chmodSync(credsFile(), 0o600);
}

export function clearSerpCreds(): void {
  fs.rmSync(credsFile(), { force: true });
}

/** Safe to show: whether it's on and the login, never the password. */
export function describeSerp() {
  const c = serpCreds();
  return { connected: !!c, login: c?.login ?? null, location: serpLocation() };
}

// Countries Google results are fetched for, by site language. The owner can change it per site.
const LOCATION_BY_LANGUAGE: Record<string, string> = {
  he: 'Israel', ar: 'Israel', en: 'United States', fr: 'France', de: 'Germany', es: 'Spain', it: 'Italy', pt: 'Brazil',
  nl: 'Netherlands', pl: 'Poland', ru: 'Russia', tr: 'Turkey', ja: 'Japan', ko: 'South Korea', zh: 'Taiwan',
};

export function serpLocation(): string {
  return getSetting<string>('serpLocation', '') || LOCATION_BY_LANGUAGE[contentLanguage()] || 'United States';
}

export function setSerpLocation(name: string): string {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (n && !/^[\p{L} ,.'-]{2,60}$/u.test(n)) throw new Error('write the country name, e.g. "Israel" or "United Kingdom"');
  setSetting('serpLocation', n);
  return serpLocation();
}

export interface SerpResult {
  position: number;
  url: string;
  domain: string;
  title: string;
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

/** Where our site sits in a result list (by domain, with or without www), or null if it isn't there. */
export function ourPosition(results: SerpResult[], site: string | null): number | null {
  if (!site) return null;
  const mine = bareHost(new URL(site).hostname);
  const hit = results.find((r) => bareHost(r.domain) === mine || bareHost(r.domain).endsWith(`.${mine}`));
  return hit ? hit.position : null;
}

/** Pull organic results out of a DataForSEO response, ignoring ads, maps, videos and the like. */
export function parseSerp(data: any): { results: SerpResult[]; cost: number } {
  const task = data?.tasks?.[0];
  if (!task) throw new Error(data?.status_message ?? 'DataForSEO returned no result');
  if (task.status_code !== 20000) throw new Error(`DataForSEO: ${task.status_message ?? `error ${task.status_code}`}`);
  const items: any[] = task.result?.[0]?.items ?? [];
  const results = items
    .filter((i) => i.type === 'organic' && i.url)
    .map((i) => ({ position: Number(i.rank_group ?? i.rank_absolute), url: String(i.url), domain: String(i.domain ?? new URL(i.url).hostname), title: String(i.title ?? '') }))
    .sort((a, b) => a.position - b.position)
    .slice(0, 20);
  return { results, cost: Number(task.cost ?? data.cost ?? 0) };
}

/**
 * The language to ask Google in for one search. On a site in several languages, a search written in Hebrew
 * letters is a Hebrew search even when the site is mainly English. Latin letters can't tell English from French,
 * so those use the main language.
 */
export function keywordLanguage(keyword: string): string {
  const byScript = pageLanguageOf({ lang: '', text: keyword });
  return byScript && contentLanguages().includes(byScript) ? byScript : contentLanguage();
}

/**
 * One call to DataForSEO with the saved login. Account problems (wrong login, no money) become plain errors;
 * a problem with the request itself is left to the caller, which reads the task status.
 */
export async function dfsPost(apiPath: string, task: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<any> {
  const c = serpCreds();
  if (!c) throw new Error('add a DataForSEO login under Rankings first');
  const auth = Buffer.from(`${c.login}:${c.password}`).toString('base64');
  const res = await fetchFn(`${SERP_API.base}${apiPath}`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify([task]),
    signal: AbortSignal.timeout(60_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('DataForSEO refused the login — check the email and API password');
  if (res.status === 402 || data?.status_code === 40200) throw new Error('the DataForSEO account is out of money — top it up to keep checking');
  if (!res.ok) throw new Error(`DataForSEO said ${res.status}: ${data?.status_message ?? res.statusText}`);
  return data;
}

/** One live lookup for one search. Saves the snapshot and returns it. */
export async function checkSerp(keyword: string, fetchFn: typeof fetch = fetch): Promise<{ results: SerpResult[]; ourPosition: number | null; cost: number }> {
  if (!serpCreds()) throw new Error('add a DataForSEO login under Rankings to see who outranks you');
  const data = await dfsPost('/v3/serp/google/organic/live/advanced', { keyword, location_name: serpLocation(), language_code: keywordLanguage(keyword), depth: 20 }, fetchFn);
  const { results, cost } = parseSerp(data);
  const pos = ourPosition(results, siteUrl());
  getDb()
    .prepare('INSERT OR REPLACE INTO serp_snapshots (keyword, at, location, results, our_position, cost) VALUES (?, ?, ?, ?, ?, ?)')
    .run(keyword, new Date().toISOString(), serpLocation(), JSON.stringify(results), pos, cost);
  return { results, ourPosition: pos, cost };
}

export function latestSerp(keyword: string): { at: string; location: string; results: SerpResult[]; ourPosition: number | null } | null {
  const r = getDb().prepare('SELECT * FROM serp_snapshots WHERE keyword = ? ORDER BY at DESC LIMIT 1').get(keyword) as any;
  return r ? { at: r.at, location: r.location, results: JSON.parse(r.results), ourPosition: r.our_position } : null;
}

/** The weekly task: one lookup per tracked search, oldest snapshot first. Stops at the first account-level error. */
export async function checkAllSerps(fetchFn: typeof fetch = fetch): Promise<{ checked: number; cost: number; failed: string | null }> {
  if (!serpCreds()) return { checked: 0, cost: 0, failed: null };
  const last = new Map((getDb().prepare('SELECT keyword, MAX(at) at FROM serp_snapshots GROUP BY keyword').all() as any[]).map((r) => [r.keyword, r.at]));
  const order = listTracked().sort((a, b) => String(last.get(a.keyword) ?? '').localeCompare(String(last.get(b.keyword) ?? '')));
  let checked = 0;
  let cost = 0;
  for (const t of order) {
    try {
      cost += (await checkSerp(t.keyword, fetchFn)).cost;
      checked++;
    } catch (err: any) {
      return { checked, cost, failed: String(err?.message ?? err) };
    }
  }
  // Keep a year of weekly snapshots per search.
  const cutoff = new Date(Date.now() - 366 * 86400e3).toISOString();
  getDb().prepare('DELETE FROM serp_snapshots WHERE at < ?').run(cutoff);
  return { checked, cost, failed: null };
}
