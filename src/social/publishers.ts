import crypto from 'crypto';
import type { Publisher, PublishResult } from '../publish';
import type { Draft } from '../queue';
import { describeProblems, lengthProblems, linkedinEscape, plainText, splitThread } from './text';

/** Overridable so tests can point at a fake server. */
export const SOCIAL_API = {
  x: 'https://api.x.com',
  linkedin: 'https://api.linkedin.com',
  facebook: 'https://graph.facebook.com',
  redditAuth: 'https://www.reddit.com',
  reddit: 'https://oauth.reddit.com',
};

const tooLong = (channel: 'x' | 'linkedin' | 'facebook' | 'reddit', body: string) => {
  const p = lengthProblems(channel, body);
  if (p.length) throw new Error(`too long to publish: ${describeProblems(channel, p)}. Edit it shorter, then approve again.`);
};

// ---------------------------------------------------------------- X

/**
 * OAuth 1.0a "HMAC-SHA1" signature header for one request (X's user-context auth).
 * Query and form fields are signed; JSON bodies are not (X's v2 API takes JSON).
 */
export function oauth1Header(
  method: string,
  url: string,
  keys: { apiKey: string; apiSecret: string; accessToken: string; accessSecret: string },
  opts: { nonce?: string; timestamp?: string; form?: Record<string, string> } = {},
): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const u = new URL(url);
  const params: [string, string][] = [
    ['oauth_consumer_key', keys.apiKey],
    ['oauth_nonce', opts.nonce ?? crypto.randomBytes(16).toString('hex')],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', opts.timestamp ?? Math.floor(Date.now() / 1000).toString()],
    ['oauth_token', keys.accessToken],
    ['oauth_version', '1.0'],
    ...[...u.searchParams.entries()],
    ...Object.entries(opts.form ?? {}),
  ];
  const paramString = params
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(paramString)].join('&');
  const signature = crypto.createHmac('sha1', `${enc(keys.apiSecret)}&${enc(keys.accessSecret)}`).update(base).digest('base64');
  const header = params.filter(([k]) => k.startsWith('oauth_')).concat([['oauth_signature', signature]]);
  return 'OAuth ' + header.map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}

const xKeys = (env: NodeJS.ProcessEnv) => ({ apiKey: env.X_API_KEY!, apiSecret: env.X_API_SECRET!, accessToken: env.X_ACCESS_TOKEN!, accessSecret: env.X_ACCESS_SECRET! });

async function xCall(env: NodeJS.ProcessEnv, method: string, path: string, body?: unknown): Promise<any> {
  const url = `${SOCIAL_API.x}${path}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: oauth1Header(method, url, xKeys(env)), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data.detail ?? data.title ?? data.errors?.[0]?.message ?? res.statusText;
    if (res.status === 402) throw new Error(`X says this account's API plan doesn't allow posting (${why})`);
    if (res.status === 403) throw new Error(`X refused: ${why}. Check the app has "Read and write" permission and regenerate the access token after changing it.`);
    if (res.status === 429) throw new Error('X rate limit reached — it will be retried later');
    throw new Error(`X said ${res.status}: ${why}`);
  }
  return data;
}

export const xPublisher: Publisher = {
  id: 'x',
  label: 'X (Twitter)',
  needs: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'],
  configured: (env = process.env) => !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET),
  async publish(draft: Draft, _html: string, env = process.env): Promise<PublishResult> {
    const posts = splitThread(plainText(draft.body));
    tooLong('x', posts.join('\n\n---\n\n'));
    // A thread is a chain of replies. If a later post fails, the earlier ones stay up and the error says how far it got.
    const ids: string[] = [];
    for (const [i, text] of posts.entries()) {
      try {
        const r = await xCall(env, 'POST', '/2/tweets', { text, ...(ids.length ? { reply: { in_reply_to_tweet_id: ids[ids.length - 1] } } : {}) });
        ids.push(r.data.id);
      } catch (err: any) {
        if (!ids.length) throw err;
        throw new Error(`posted ${i} of ${posts.length} (first: https://x.com/i/status/${ids[0]}), then: ${err.message}`);
      }
    }
    return { url: `https://x.com/i/status/${ids[0]}`, externalId: ids.join(','), dryRun: false };
  },
};

// ---------------------------------------------------------------- LinkedIn

/** LinkedIn wants an API version (YYYYMM) it still supports; two months back is always within its window. */
export function linkedinVersion(env = process.env, now = new Date()): string {
  if (env.LINKEDIN_VERSION) return env.LINKEDIN_VERSION;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function linkedinAuthor(env: NodeJS.ProcessEnv): Promise<string> {
  const set = (env.LINKEDIN_AUTHOR ?? '').trim();
  if (set) {
    if (!/^urn:li:(person|organization):[\w-]+$/.test(set)) throw new Error(`"${set}" is not a LinkedIn author — use urn:li:organization:<number>, or leave it empty to post as yourself`);
    return set;
  }
  const res = await fetch(`${SOCIAL_API.linkedin}/v2/userinfo`, { headers: { authorization: `Bearer ${env.LINKEDIN_TOKEN}` }, signal: AbortSignal.timeout(20_000) });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('LinkedIn refused the token — it may have expired (they last about two months). Make a new one and save it in Settings.');
  if (!res.ok || !data.sub) throw new Error(`LinkedIn did not say who this token belongs to (${res.status}). The token needs the "openid" and "profile" permissions to post as yourself.`);
  return `urn:li:person:${data.sub}`;
}

export const linkedinPublisher: Publisher = {
  id: 'linkedin',
  label: 'LinkedIn',
  needs: ['LINKEDIN_TOKEN'],
  configured: (env = process.env) => !!env.LINKEDIN_TOKEN,
  async publish(draft: Draft, _html: string, env = process.env): Promise<PublishResult> {
    const text = plainText(draft.body);
    tooLong('linkedin', text);
    const author = await linkedinAuthor(env);
    const res = await fetch(`${SOCIAL_API.linkedin}/rest/posts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.LINKEDIN_TOKEN}`,
        'content-type': 'application/json',
        'linkedin-version': linkedinVersion(env),
        'x-restli-protocol-version': '2.0.0',
      },
      body: JSON.stringify({
        author,
        commentary: linkedinEscape(text),
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('LinkedIn refused the token — it may have expired. Make a new one and save it in Settings.');
      if (res.status === 403) throw new Error(`LinkedIn says this token may not post as ${author} (${data.message ?? 'missing permission'})`);
      if (res.status === 426 || /version/i.test(data.message ?? '')) throw new Error(`LinkedIn no longer accepts API version ${linkedinVersion(env)} — set LINKEDIN_VERSION to a newer month (YYYYMM)`);
      throw new Error(`LinkedIn said ${res.status}: ${data.message ?? res.statusText}`);
    }
    const urn = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id') ?? '';
    return { url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null, externalId: urn || null, dryRun: false };
  },
};

// ---------------------------------------------------------------- Facebook

/** Meta retires each Graph API version about two years after release; FACEBOOK_GRAPH_VERSION moves to a newer one. */
export const facebookVersion = (env = process.env) => env.FACEBOOK_GRAPH_VERSION || 'v23.0';

async function facebookCall(env: NodeJS.ProcessEnv, method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<any> {
  const url = `${SOCIAL_API.facebook}/${facebookVersion(env)}${path}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${env.FACEBOOK_PAGE_TOKEN}`, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error ?? {};
    const why = e.message ?? res.statusText;
    if (e.code === 190) throw new Error(`Facebook refused the token — it may have expired or been for a different page (${why}). Make a new Page token and save it in Settings.`);
    if (e.code === 10 || e.code === 200 || (e.code >= 200 && e.code < 300)) throw new Error(`Facebook says this token may not post to the page (${why}). It needs the "pages_manage_posts" and "pages_read_engagement" permissions, and must be a Page token, not your personal one.`);
    if (e.code === 803 || e.code === 100) throw new Error(`Facebook could not find that page (${why}). Check the Page ID in Settings.`);
    if (e.code === 4 || e.code === 17 || e.code === 32 || e.code === 368 || res.status === 429) throw new Error(`Facebook asks you to slow down (${why}) — it will be retried later`);
    throw new Error(`Facebook said ${res.status}: ${why}`);
  }
  return data;
}

const pageId = (env: NodeJS.ProcessEnv) => {
  const id = (env.FACEBOOK_PAGE_ID ?? '').trim();
  if (!/^\d{5,25}$/.test(id)) throw new Error(`"${id}" is not a Facebook Page ID — it is a long number, shown under the page's About → Page transparency`);
  return id;
};

export const facebookPublisher: Publisher = {
  id: 'facebook',
  label: 'Facebook Page',
  needs: ['FACEBOOK_PAGE_ID', 'FACEBOOK_PAGE_TOKEN'],
  configured: (env = process.env) => !!(env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_TOKEN),
  async publish(draft: Draft, _html: string, env = process.env): Promise<PublishResult> {
    const text = plainText(draft.body);
    tooLong('facebook', text);
    const r = await facebookCall(env, 'POST', `/${pageId(env)}/feed`, { message: text });
    // The id is "<page>_<post>"; facebook.com/<id> opens the post.
    return { url: r.id ? `https://www.facebook.com/${r.id}` : null, externalId: r.id ?? null, dryRun: false };
  },
};

// ---------------------------------------------------------------- Reddit

export const redditUserAgent = (env: NodeJS.ProcessEnv) => `plume-marketing/0.1 (by /u/${env.REDDIT_USERNAME ?? 'unknown'})`;

let redditToken: { key: string; token: string; until: number } | null = null;

export async function redditAccessToken(env: NodeJS.ProcessEnv): Promise<string> {
  const key = `${env.REDDIT_CLIENT_ID}|${env.REDDIT_USERNAME}`;
  if (redditToken && redditToken.key === key && redditToken.until > Date.now() + 60_000) return redditToken.token;
  const res = await fetch(`${SOCIAL_API.redditAuth}/api/v1/access_token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': redditUserAgent(env),
    },
    body: new URLSearchParams({ grant_type: 'password', username: env.REDDIT_USERNAME ?? '', password: env.REDDIT_PASSWORD ?? '' }),
    signal: AbortSignal.timeout(20_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const why = data.error === 'invalid_grant' ? 'wrong username or password (accounts with two-factor sign-in need it turned off for script apps)' : data.error ?? res.statusText;
    throw new Error(`Reddit sign-in failed: ${why}`);
  }
  redditToken = { key, token: data.access_token, until: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

export function resetRedditTokenForTests(): void {
  redditToken = null;
}

/** An authenticated Reddit API call. Reddit reports problems inside a 200 reply, so those are checked too. */
export async function redditCall(env: NodeJS.ProcessEnv, method: 'GET' | 'POST', path: string, form?: Record<string, string>): Promise<any> {
  const token = await redditAccessToken(env);
  const res = await fetch(`${SOCIAL_API.reddit}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'user-agent': redditUserAgent(env), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error('Reddit rate limit reached — it will be retried later');
  if (!res.ok) throw new Error(`Reddit said ${res.status}: ${data.message ?? res.statusText}`);
  const errors: any[] = data?.json?.errors ?? [];
  if (errors.length) {
    const [code, msg] = errors[0];
    const plain: Record<string, string> = {
      RATELIMIT: `Reddit asks you to wait before posting again (${msg})`,
      THREAD_LOCKED: 'that thread is locked, so it no longer takes replies',
      DELETED_LINK: 'that thread was deleted',
      SUBREDDIT_NOTALLOWED: 'this account is not allowed to post in that subreddit',
      NO_SELFS: 'that subreddit only takes links, not text posts',
      SUBMIT_VALIDATION_FLAIR_REQUIRED: 'that subreddit requires a flair on new posts — post it from Reddit instead',
    };
    throw new Error(plain[code] ?? `Reddit: ${msg ?? code}`);
  }
  return data;
}

export const redditPublisher: Publisher = {
  id: 'reddit',
  label: 'Reddit',
  needs: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD'],
  configured: (env = process.env) => !!(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET && env.REDDIT_USERNAME && env.REDDIT_PASSWORD),
  async publish(draft: Draft, _html: string, env = process.env): Promise<PublishResult> {
    tooLong('reddit', draft.body);
    const m = draft.meta as any;
    if (draft.kind === 'reddit_reply') {
      if (!/^t[13]_[a-z0-9]+$/.test(m.thingId ?? '')) throw new Error('this reply does not say which thread it answers');
      const r = await redditCall(env, 'POST', '/api/comment', { api_type: 'json', thing_id: m.thingId, text: draft.body.trim() });
      const c = r?.json?.data?.things?.[0]?.data;
      return { url: c?.permalink ? `https://www.reddit.com${c.permalink}` : (m.threadUrl ?? null), externalId: c?.name ?? null, dryRun: false };
    }
    const sr = String(m.subreddit ?? '').replace(/^\/?r\//, '');
    if (!/^[A-Za-z0-9_]{2,21}$/.test(sr)) throw new Error('this post does not say which subreddit it is for');
    const r = await redditCall(env, 'POST', '/api/submit', { api_type: 'json', sr, kind: 'self', title: draft.title.slice(0, 300), text: draft.body.trim(), resubmit: 'true' });
    return { url: r?.json?.data?.url ?? null, externalId: r?.json?.data?.name ?? null, dryRun: false };
  },
};

export const SOCIAL_PUBLISHERS = [xPublisher, linkedinPublisher, facebookPublisher, redditPublisher];

/** The Settings "Test" button: one harmless read that proves the keys work. */
export async function testSocial(id: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }> {
  try {
    if (id === 'x') {
      const r = await xCall(env, 'GET', '/2/users/me');
      return { ok: true, message: `Signed in as @${r.data?.username}.` };
    }
    if (id === 'linkedin') {
      const author = await linkedinAuthor(env);
      return { ok: true, message: `Will post as ${author.includes('organization') ? 'the company page' : 'you'} (${author}). Posting permission is only checked on the first post.` };
    }
    if (id === 'facebook') {
      const p = await facebookCall(env, 'GET', `/${pageId(env)}?fields=name`);
      return { ok: true, message: `Will post to the page "${p.name}". Posting permission is only checked on the first post.` };
    }
    if (id === 'reddit') {
      const me = await redditCall(env, 'GET', '/api/v1/me');
      return { ok: true, message: `Signed in as u/${me.name} (${me.link_karma + me.comment_karma} karma).${me.link_karma + me.comment_karma < 50 ? ' New or low-karma accounts are often blocked by subreddits — build some history first.' : ''}` };
    }
    return { ok: false, message: `unknown channel ${id}` };
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}
