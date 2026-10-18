import crypto from 'crypto';
import fs from 'fs';
import type { Publisher, PublishResult } from '../publish';
import type { Draft } from '../queue';
import { captionFromMarkdown, footagePath } from '../video/agent';
import { IMAGE_MIME, PostImage, listImages } from './images';
import { describeProblems, lengthProblems, linkedinEscape, plainText, splitThread } from './text';

/** Overridable so tests can point at a fake server. */
export const SOCIAL_API = {
  x: 'https://api.x.com',
  linkedin: 'https://api.linkedin.com',
  facebook: 'https://graph.facebook.com',
  /** Where Meta takes video bytes for Reels (both Facebook and Instagram). */
  rupload: 'https://rupload.facebook.com',
  redditAuth: 'https://www.reddit.com',
  reddit: 'https://oauth.reddit.com',
};

const tooLong = (channel: 'x' | 'linkedin' | 'facebook' | 'reddit', body: string) => {
  const p = lengthProblems(channel, body);
  if (p.length) throw new Error(`too long to publish: ${describeProblems(channel, p)}. Edit it shorter, then approve again.`);
};

/** A photo as a file part for a multipart upload. */
const photoBlob = (img: PostImage) => new Blob([fs.readFileSync(img.file)], { type: IMAGE_MIME[img.type] });

/** The draft's photos, in order. Only post drafts have any. */
const photosOf = (draft: Draft) => (draft.id ? listImages(draft.id) : []);

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

/** Upload one photo to X; returns its media id. The multipart body is not part of the OAuth signature. */
async function xUpload(env: NodeJS.ProcessEnv, img: PostImage): Promise<string> {
  const url = `${SOCIAL_API.x}/2/media/upload`;
  const form = new FormData();
  form.append('media', photoBlob(img), img.name);
  form.append('media_category', img.type === 'gif' ? 'tweet_gif' : 'tweet_image');
  const res = await fetch(url, { method: 'POST', headers: { authorization: oauth1Header('POST', url, xKeys(env)) }, body: form, signal: AbortSignal.timeout(60_000) });
  const data: any = await res.json().catch(() => ({}));
  const id = data.data?.id ?? data.media_id_string;
  if (!res.ok || !id) {
    const why = data.detail ?? data.title ?? data.errors?.[0]?.message ?? res.statusText;
    if (res.status === 403) throw new Error(`X refused the photo: ${why}. Check the app has "Read and write" permission.`);
    if (res.status === 429) throw new Error('X rate limit reached — it will be retried later');
    throw new Error(`X did not take photo ${img.name} (${res.status}: ${why})`);
  }
  return String(id);
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
    // Photos go on the first post, which is the one people see in their feed.
    const mediaIds: string[] = [];
    for (const img of photosOf(draft)) mediaIds.push(await xUpload(env, img));
    const ids: string[] = [];
    for (const [i, text] of posts.entries()) {
      try {
        const media = i === 0 && mediaIds.length ? { media: { media_ids: mediaIds } } : {};
        const r = await xCall(env, 'POST', '/2/tweets', { text, ...media, ...(ids.length ? { reply: { in_reply_to_tweet_id: ids[ids.length - 1] } } : {}) });
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

const linkedinHeaders = (env: NodeJS.ProcessEnv) => ({
  authorization: `Bearer ${env.LINKEDIN_TOKEN}`,
  'linkedin-version': linkedinVersion(env),
  'x-restli-protocol-version': '2.0.0',
});

/** LinkedIn photos: ask for an upload address, send the bytes there, then use the image's id in the post. */
async function linkedinUpload(env: NodeJS.ProcessEnv, author: string, img: PostImage): Promise<string> {
  const res = await fetch(`${SOCIAL_API.linkedin}/rest/images?action=initializeUpload`, {
    method: 'POST',
    headers: { ...linkedinHeaders(env), 'content-type': 'application/json' },
    body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    signal: AbortSignal.timeout(30_000),
  });
  const data: any = await res.json().catch(() => ({}));
  const { uploadUrl, image } = data.value ?? {};
  if (res.status === 401) throw new Error('LinkedIn refused the token — it may have expired. Make a new one and save it in Settings.');
  if (!res.ok || !uploadUrl || !image) throw new Error(`LinkedIn would not take photo ${img.name} (${res.status}: ${data.message ?? res.statusText})`);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { authorization: `Bearer ${env.LINKEDIN_TOKEN}`, 'content-type': IMAGE_MIME[img.type] }, body: fs.readFileSync(img.file), signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw new Error(`LinkedIn did not accept photo ${img.name} (${put.status})`);
  return image;
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
    const images: string[] = [];
    for (const img of photosOf(draft)) images.push(await linkedinUpload(env, author, img));
    const content = images.length === 1 ? { content: { media: { id: images[0] } } } : images.length ? { content: { multiImage: { images: images.map((id) => ({ id })) } } } : {};
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
        ...content,
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

async function facebookCall(env: NodeJS.ProcessEnv, method: 'GET' | 'POST', path: string, form?: Record<string, string> | FormData): Promise<any> {
  const url = `${SOCIAL_API.facebook}/${facebookVersion(env)}${path}`;
  // A FormData body (a photo) sets its own multipart content type.
  const multipart = form instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${env.FACEBOOK_PAGE_TOKEN}`, ...(form && !multipart ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? (multipart ? form : new URLSearchParams(form)) : undefined,
    signal: AbortSignal.timeout(multipart ? 60_000 : 30_000),
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
    const page = pageId(env);
    // Photos are uploaded unpublished first, then attached to one post, so several show together with the text.
    const attached: Record<string, string> = {};
    for (const [i, img] of photosOf(draft).entries()) {
      const form = new FormData();
      form.append('source', photoBlob(img), img.name);
      form.append('published', 'false');
      const p = await facebookCall(env, 'POST', `/${page}/photos`, form);
      if (!p.id) throw new Error(`Facebook did not take photo ${img.name}`);
      attached[`attached_media[${i}]`] = JSON.stringify({ media_fbid: String(p.id) });
    }
    const r = await facebookCall(env, 'POST', `/${page}/feed`, { message: text, ...attached });
    // The id is "<page>_<post>"; facebook.com/<id> opens the post.
    return { url: r.id ? `https://www.facebook.com/${r.id}` : null, externalId: r.id ?? null, dryRun: false };
  },
};

// ---------------------------------------------------------------- Reels (Facebook and Instagram)

/** The owner's filmed video for a script draft, or a plain message saying to upload it. */
function reelFile(draft: Draft): string {
  if (draft.kind !== 'video_script') throw new Error('only a video script can be posted as a Reel');
  const f = footagePath(draft.id);
  if (!fs.existsSync(f) || !fs.statSync(f).size) throw new Error('Upload your filmed video to this draft first. The slide preview is not posted.');
  return f;
}

/** Send a whole video file to Meta's upload server in one go. Used by both kinds of Reel. */
async function ruploadFile(env: NodeJS.ProcessEnv, url: string, file: string): Promise<void> {
  const bytes = fs.readFileSync(file);
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `OAuth ${env.FACEBOOK_PAGE_TOKEN}`, offset: '0', file_size: String(bytes.length), 'content-type': 'application/octet-stream' },
    body: bytes,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.error || data.success === false) {
    const why = data.error?.message ?? data.debug_info?.message ?? res.statusText;
    throw new Error(`Meta did not accept the video upload (${res.status}: ${why})`);
  }
}

export const facebookReelPublisher: Publisher = {
  id: 'facebook_reel',
  label: 'Facebook Page — Reel',
  needs: ['FACEBOOK_PAGE_ID', 'FACEBOOK_PAGE_TOKEN'],
  configured: (env = process.env) => !!(env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_TOKEN),
  async publish(draft: Draft, _html: string, env = process.env): Promise<PublishResult> {
    const file = reelFile(draft);
    const caption = plainText(captionFromMarkdown(draft.body));
    const page = pageId(env);
    const start = await facebookCall(env, 'POST', `/${page}/video_reels`, { upload_phase: 'start' });
    if (!start.video_id) throw new Error('Facebook did not start the Reel upload');
    await ruploadFile(env, `${SOCIAL_API.rupload}/video-upload/${facebookVersion(env)}/${start.video_id}`, file);
    await facebookCall(env, 'POST', `/${page}/video_reels`, { upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: caption });
    // Facebook keeps processing for a minute or two after this; the link works once it is done.
    return { url: `https://www.facebook.com/reel/${start.video_id}`, externalId: String(start.video_id), dryRun: false };
  },
};

/** Instagram allows 2,200 characters and 30 hashtags in a caption. */
export function instagramCaptionProblems(caption: string): string[] {
  const out: string[] = [];
  const n = [...caption].length;
  if (n > 2200) out.push(`the caption is ${n} characters; Instagram allows 2,200`);
  const tags = (caption.match(/(^|\s)#[^\s#]+/g) ?? []).length;
  if (tags > 30) out.push(`the caption has ${tags} hashtags; Instagram allows 30`);
  return out;
}

const igAccounts = new Map<string, string>();

/** The Instagram account linked to the Facebook Page: typed in Settings, or asked from Facebook once. */
export async function instagramAccount(env: NodeJS.ProcessEnv): Promise<string> {
  const typed = (env.INSTAGRAM_ACCOUNT_ID ?? '').trim();
  if (typed) {
    if (!/^\d{5,25}$/.test(typed)) throw new Error(`"${typed}" is not an Instagram account ID — it is a long number. Leave it empty and Plume finds it from the Facebook Page.`);
    return typed;
  }
  const page = pageId(env);
  const key = `${page}|${env.FACEBOOK_PAGE_TOKEN}`;
  const known = igAccounts.get(key);
  if (known) return known;
  const r = await facebookCall(env, 'GET', `/${page}?fields=instagram_business_account`);
  const id = r.instagram_business_account?.id;
  if (!id) throw new Error('No Instagram account is linked to this Facebook Page. In Instagram, switch to a Business or Creator account and link it to the Page (Instagram settings → Accounts Centre, or the Page settings → Linked accounts).');
  igAccounts.set(key, String(id));
  return String(id);
}

export function resetInstagramForTests(): void {
  igAccounts.clear();
}

/** How long to wait between checks while Instagram processes a video. Overridable so tests run fast. */
export const INSTAGRAM_WAIT = { everyMs: 5000, maxMs: 5 * 60_000 };

export const instagramReelPublisher: Publisher = {
  id: 'instagram',
  label: 'Instagram — Reel',
  needs: ['FACEBOOK_PAGE_ID', 'FACEBOOK_PAGE_TOKEN'],
  configured: (env = process.env) => !!(env.FACEBOOK_PAGE_ID && env.FACEBOOK_PAGE_TOKEN),
  async publish(draft: Draft, _html: string, env = process.env): Promise<PublishResult> {
    const file = reelFile(draft);
    const caption = plainText(captionFromMarkdown(draft.body));
    const problems = instagramCaptionProblems(caption);
    if (problems.length) throw new Error(`too long to publish: ${problems.join('; ')}. Edit the caption, then approve again.`);
    const ig = await instagramAccount(env);
    const box = await facebookCall(env, 'POST', `/${ig}/media`, { media_type: 'REELS', upload_type: 'resumable', caption });
    if (!box.id) throw new Error('Instagram did not start the Reel upload');
    await ruploadFile(env, `${SOCIAL_API.rupload}/ig-api-upload/${facebookVersion(env)}/${box.id}`, file);
    // Instagram has to process the video before it can be published.
    const until = Date.now() + INSTAGRAM_WAIT.maxMs;
    for (;;) {
      const st = await facebookCall(env, 'GET', `/${box.id}?fields=status_code,status`);
      if (st.status_code === 'FINISHED') break;
      if (st.status_code === 'ERROR') throw new Error(`Instagram could not use this video (${st.status ?? 'no reason given'}). Reels must be MP4 or MOV, 3 seconds to 15 minutes, ideally 9:16.`);
      if (st.status_code === 'EXPIRED') throw new Error('Instagram gave up on this upload because it took too long. Approve again to retry.');
      if (Date.now() > until) throw new Error('Instagram is still processing the video — it will be retried later');
      await new Promise((r) => setTimeout(r, INSTAGRAM_WAIT.everyMs));
    }
    const done = await facebookCall(env, 'POST', `/${ig}/media_publish`, { creation_id: String(box.id) });
    const link = done.id ? await facebookCall(env, 'GET', `/${done.id}?fields=permalink`).catch(() => ({})) : {};
    return { url: link.permalink ?? null, externalId: done.id ?? null, dryRun: false };
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

export const SOCIAL_PUBLISHERS = [xPublisher, linkedinPublisher, facebookPublisher, facebookReelPublisher, instagramReelPublisher, redditPublisher];

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
    if (id === 'instagram') {
      const ig = await instagramAccount(env);
      const a = await facebookCall(env, 'GET', `/${ig}?fields=username`);
      return { ok: true, message: `Will post Reels to @${a.username}. Posting permission ("instagram_content_publish") is only checked on the first post.` };
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
