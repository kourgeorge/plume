import fs from 'fs';
import path from 'path';
import { siteDir } from './site';

/**
 * Connection details for each website's publishing destinations. They live in that site's own folder
 * (integrations.json, owner-only), so two sites can publish to two different places.
 * Anything not set here falls back to the .env file, so older setups keep working.
 */
export interface Field {
  key: string;
  /** The environment variable the publisher reads. */
  env: string;
  label: string;
  secret?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
}

export interface IntegrationDef {
  id: string;
  label: string;
  blurb: string;
  group?: 'analytics';
  fields: Field[];
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'google',
    label: 'Google Analytics and Search Console',
    group: 'analytics',
    blurb: "This website's own Google Cloud OAuth client (type: Desktop app). Plume only ever reads your data.",
    fields: [
      { key: 'clientId', env: 'GOOGLE_CLIENT_ID', label: 'Client ID', placeholder: '123456-abc.apps.googleusercontent.com' },
      { key: 'clientSecret', env: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', secret: true },
    ],
  },
  {
    id: 'wordpress',
    label: 'WordPress',
    blurb: 'Publish to a WordPress site with an application password (Users → Profile → Application Passwords).',
    fields: [
      { key: 'url', env: 'WP_URL', label: 'Site address', placeholder: 'https://yourblog.com' },
      { key: 'user', env: 'WP_USER', label: 'Username' },
      { key: 'password', env: 'WP_APP_PASSWORD', label: 'Application password', secret: true },
      { key: 'status', env: 'WP_POST_STATUS', label: 'Post status', optional: true, placeholder: 'draft', help: 'Leave empty to save as drafts. Type "publish" to go live straight away.' },
    ],
  },
  {
    id: 'webflow',
    label: 'Webflow',
    blurb: 'Add items to a Webflow CMS collection (your blog).',
    fields: [
      { key: 'token', env: 'WEBFLOW_TOKEN', label: 'API token', secret: true },
      { key: 'collection', env: 'WEBFLOW_COLLECTION_ID', label: 'Collection ID' },
      { key: 'body', env: 'WEBFLOW_BODY_FIELD', label: 'Body field name', optional: true, placeholder: 'post-body' },
      { key: 'summary', env: 'WEBFLOW_SUMMARY_FIELD', label: 'Summary field name', optional: true },
      { key: 'siteUrl', env: 'WEBFLOW_SITE_URL', label: 'Public site address', optional: true, placeholder: 'https://yoursite.com' },
      { key: 'path', env: 'WEBFLOW_PATH', label: 'Blog path', optional: true, placeholder: 'blog' },
      { key: 'live', env: 'WEBFLOW_LIVE', label: 'Go live straight away', optional: true, placeholder: '1 = yes, empty = save as draft' },
    ],
  },
  {
    id: 'sanity',
    label: 'Sanity',
    blurb: 'Create a draft document in your Sanity dataset. Someone publishes it from Studio.',
    fields: [
      { key: 'project', env: 'SANITY_PROJECT_ID', label: 'Project ID' },
      { key: 'dataset', env: 'SANITY_DATASET', label: 'Dataset', placeholder: 'production' },
      { key: 'token', env: 'SANITY_TOKEN', label: 'API token (with write access)', secret: true },
      { key: 'type', env: 'SANITY_TYPE', label: 'Document type', optional: true, placeholder: 'post' },
      { key: 'body', env: 'SANITY_BODY_FIELD', label: 'Body field name', optional: true, placeholder: 'body' },
      { key: 'summary', env: 'SANITY_SUMMARY_FIELD', label: 'Summary field name', optional: true },
    ],
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    blurb: 'Create draft posts on your HubSpot blog. Use a private app token with the "content" permission.',
    fields: [
      { key: 'token', env: 'HUBSPOT_TOKEN', label: 'Private app token', secret: true },
      { key: 'blog', env: 'HUBSPOT_BLOG_ID', label: 'Blog ID' },
    ],
  },
  {
    id: 'github',
    label: 'GitHub',
    blurb: 'Open a pull request that adds each article as a Markdown file. Nothing changes until you merge it.',
    fields: [
      { key: 'repo', env: 'GITHUB_REPO', label: 'Repository', placeholder: 'owner/name' },
      { key: 'token', env: 'GITHUB_TOKEN', label: 'Access token (needs repo write access)', secret: true },
      { key: 'branch', env: 'GITHUB_BRANCH', label: 'Base branch', optional: true, placeholder: "the repository's main branch" },
      { key: 'path', env: 'GITHUB_PATH', label: 'Folder for articles', optional: true, placeholder: 'content/blog' },
    ],
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    blurb:
      'Post and thread on X. In the X developer portal, open your app → "Keys and tokens", give the app "Read and write" permission, then copy the four values below. X charges for posting through its API.',
    fields: [
      { key: 'apiKey', env: 'X_API_KEY', label: 'API key (consumer key)', secret: true },
      { key: 'apiSecret', env: 'X_API_SECRET', label: 'API key secret', secret: true },
      { key: 'accessToken', env: 'X_ACCESS_TOKEN', label: 'Access token', secret: true },
      { key: 'accessSecret', env: 'X_ACCESS_SECRET', label: 'Access token secret', secret: true },
    ],
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    blurb:
      'Post to LinkedIn as yourself or as a company page. Needs an access token from your LinkedIn developer app with the "w_member_social" permission (or "w_organization_social" for a page). Tokens last about two months.',
    fields: [
      { key: 'token', env: 'LINKEDIN_TOKEN', label: 'Access token', secret: true },
      {
        key: 'author',
        env: 'LINKEDIN_AUTHOR',
        label: 'Who posts',
        optional: true,
        placeholder: 'leave empty for yourself, or urn:li:organization:12345',
        help: 'Empty = your own profile. For a company page, paste its URN (the number is in the page admin address).',
      },
    ],
  },
  {
    id: 'reddit',
    label: 'Reddit',
    blurb:
      'Reply to threads and post in subreddits. At reddit.com/prefs/apps create an app of type "script", then use its ID and secret with the Reddit account that will post. Plume posts at most a few times a day and only what you approve.',
    fields: [
      { key: 'clientId', env: 'REDDIT_CLIENT_ID', label: 'App ID (under the app name)' },
      { key: 'clientSecret', env: 'REDDIT_CLIENT_SECRET', label: 'App secret', secret: true },
      { key: 'username', env: 'REDDIT_USERNAME', label: 'Reddit username' },
      { key: 'password', env: 'REDDIT_PASSWORD', label: 'Reddit password', secret: true },
      { key: 'daily', env: 'REDDIT_DAILY_LIMIT', label: 'Posts per day, at most', optional: true, placeholder: '2', help: 'Approved Reddit posts beyond this wait for the next day.' },
    ],
  },
];

export const getIntegration = (id: string) => INTEGRATIONS.find((i) => i.id === id);

type Saved = Record<string, Record<string, string>>;

const file = (slug?: string) => path.join(siteDir(slug), 'integrations.json');

function readAll(slug?: string): Saved {
  try {
    return JSON.parse(fs.readFileSync(file(slug), 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(all: Saved, slug?: string): void {
  fs.mkdirSync(path.dirname(file(slug)), { recursive: true });
  fs.writeFileSync(file(slug), JSON.stringify(all, null, 2), { mode: 0o600 });
}

/** Save the values for one destination. A blank secret keeps the saved one; a blank plain field clears it. */
export function saveIntegration(id: string, values: Record<string, unknown>): void {
  const def = getIntegration(id);
  if (!def) throw new Error(`unknown integration ${id}`);
  const all = readAll();
  const next = { ...(all[id] ?? {}) };
  for (const f of def.fields) {
    if (!(f.key in values)) continue;
    const v = String(values[f.key] ?? '').trim();
    if (v) next[f.key] = v;
    else if (!f.secret) delete next[f.key];
  }
  const missing = def.fields.filter((f) => !f.optional && !next[f.key]).map((f) => f.label);
  if (missing.length) throw new Error(`still needed: ${missing.join(', ')}`);
  if (id === 'wordpress' || id === 'webflow') {
    const url = id === 'wordpress' ? next.url : next.siteUrl;
    if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw new Error(`"${url}" should start with https://`);
  }
  if (id === 'google' && !/\.apps\.googleusercontent\.com$/.test(next.clientId)) throw new Error('the client ID should end in .apps.googleusercontent.com');
  if (id === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(next.repo)) throw new Error('the repository should look like owner/name');
  writeAll({ ...all, [id]: next });
}

export function removeIntegration(id: string): void {
  const all = readAll();
  delete all[id];
  writeAll(all);
}

/** What the page shows: never the secrets themselves, only whether one is saved and its last characters. */
export function describeIntegrations() {
  const all = readAll();
  return INTEGRATIONS.map((def) => {
    const saved = all[def.id] ?? {};
    return {
      id: def.id,
      label: def.label,
      blurb: def.blurb,
      group: def.group ?? 'publishing',
      connected: def.fields.every((f) => f.optional || saved[f.key]),
      fields: def.fields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: !!f.secret,
        optional: !!f.optional,
        placeholder: f.placeholder ?? '',
        help: f.help ?? '',
        value: f.secret ? '' : (saved[f.key] ?? ''),
        hint: f.secret && saved[f.key] ? saved[f.key].slice(-4) : '',
      })),
    };
  });
}

/** The environment a publisher reads: .env as the base, this site's saved details on top. */
export function siteEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let saved: Saved;
  try {
    saved = readAll();
  } catch {
    return base;
  }
  const env: NodeJS.ProcessEnv = { ...base };
  for (const def of INTEGRATIONS) {
    const mine = saved[def.id];
    if (!mine) continue;
    for (const f of def.fields) if (mine[f.key]) env[f.env] = mine[f.key];
  }
  return env;
}

/** One harmless read-only request, so the user finds out now rather than on the first publish. */
export async function testIntegration(id: string, env = siteEnv()): Promise<{ ok: boolean; message: string }> {
  const get = async (url: string, headers: Record<string, string>) => {
    const res = await fetch(url, { headers: { 'user-agent': 'plume', ...headers } });
    const data: any = await res.json().catch(() => ({}));
    return { res, data };
  };
  try {
    switch (id) {
      case 'wordpress': {
        const auth = Buffer.from(`${env.WP_USER}:${(env.WP_APP_PASSWORD ?? '').replace(/\s/g, '')}`).toString('base64');
        const { res, data } = await get(`${env.WP_URL!.replace(/\/$/, '')}/wp-json/wp/v2/users/me`, { authorization: `Basic ${auth}` });
        return res.ok ? { ok: true, message: `Signed in as ${data.name ?? env.WP_USER}.` } : { ok: false, message: `WordPress said ${res.status}: ${data.message ?? res.statusText}` };
      }
      case 'webflow': {
        const api = (env.WEBFLOW_API_URL ?? 'https://api.webflow.com').replace(/\/$/, '');
        const { res, data } = await get(`${api}/v2/collections/${env.WEBFLOW_COLLECTION_ID}`, { authorization: `Bearer ${env.WEBFLOW_TOKEN}` });
        return res.ok ? { ok: true, message: `Found the collection "${data.displayName ?? data.slug ?? env.WEBFLOW_COLLECTION_ID}".` } : { ok: false, message: `Webflow said ${res.status}: ${data.message ?? res.statusText}` };
      }
      case 'sanity': {
        const api = (env.SANITY_API_URL ?? `https://${env.SANITY_PROJECT_ID}.api.sanity.io`).replace(/\/$/, '');
        const { res, data } = await get(`${api}/v2021-06-07/data/query/${env.SANITY_DATASET}?query=${encodeURIComponent('count(*)')}`, { authorization: `Bearer ${env.SANITY_TOKEN}` });
        return res.ok ? { ok: true, message: 'Connected to the dataset. (Write access is only checked on the first publish.)' } : { ok: false, message: `Sanity said ${res.status}: ${data.error?.description ?? data.message ?? res.statusText}` };
      }
      case 'hubspot': {
        const api = (env.HUBSPOT_API_URL ?? 'https://api.hubapi.com').replace(/\/$/, '');
        const { res, data } = await get(`${api}/cms/v3/blogs/posts?limit=1`, { authorization: `Bearer ${env.HUBSPOT_TOKEN}` });
        return res.ok ? { ok: true, message: 'Connected to HubSpot.' } : { ok: false, message: `HubSpot said ${res.status}: ${data.message ?? res.statusText}` };
      }
      case 'github': {
        const api = (env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
        const { res, data } = await get(`${api}/repos/${env.GITHUB_REPO}`, { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' });
        if (!res.ok) return { ok: false, message: `GitHub said ${res.status}: ${data.message ?? res.statusText}` };
        return data.permissions && !data.permissions.push
          ? { ok: false, message: 'Found the repository, but this token cannot write to it.' }
          : { ok: true, message: `Found ${data.full_name}.` };
      }
      case 'google':
        return { ok: true, message: 'Saved. Use Connect Google to sign in.' };
      case 'x':
      case 'linkedin':
      case 'reddit': {
        const { testSocial } = await import('./social/publishers');
        return await testSocial(id, env);
      }
      default:
        return { ok: false, message: `unknown integration ${id}` };
    }
  } catch (err: any) {
    return { ok: false, message: `Could not reach it: ${err?.message ?? err}` };
  }
}
