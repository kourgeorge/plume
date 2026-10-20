import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { siteDir, withSite } from '../site';
import { siteEnv } from '../integrations';

/**
 * Google sign-in for a desktop app: the browser comes back to 127.0.0.1 with a code,
 * which we swap for tokens. Read-only scopes only — Plume never changes anything in Google.
 */
export const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];

/**
 * Overridable so tests can point at a fake server. One Google app (GOOGLE_CLIENT_ID/SECRET in .env) serves every website;
 * a website can still save its own under Settings → Advanced. Each website keeps its own sign-in in its folder.
 */
export const GOOGLE = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  gsc: 'https://www.googleapis.com/webmasters/v3',
  gaAdmin: 'https://analyticsadmin.googleapis.com/v1beta',
  gaData: 'https://analyticsdata.googleapis.com/v1beta',
};

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // ms
  scope?: string;
}

const tokenFile = () => path.join(siteDir(), 'google-token.json');

export function googleConfigured(env: NodeJS.ProcessEnv = siteEnv()): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function googleConnected(): boolean {
  return fs.existsSync(tokenFile());
}

/**
 * Which read-only scopes the signed-in user actually granted. Plume-Red uses this: an Analytics
 * connection switches the feature on, but only a Search Console grant (which Google gives after it
 * has verified the person controls the domain) is treated as proof of ownership.
 */
export function googleScopes(): string[] {
  if (!googleConnected()) return [];
  try {
    const t: Tokens = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    return (t.scope ?? '').split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/** True when the connection includes Search Console, which Google grants only for a verified property. */
export function searchConsoleVerified(): boolean {
  return googleScopes().some((s) => s.includes('webmasters'));
}

function saveTokens(t: Tokens): void {
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(t, null, 2), { mode: 0o600 });
}

export function disconnectGoogle(): void {
  fs.rmSync(tokenFile(), { force: true });
}

// One sign-in in flight at a time; state + PKCE verifier live only in memory.
// `site` is which website started the sign-in, so the user lands back on that site's dashboard.
let pending: { state: string; verifier: string; redirectUri: string; site: string; at: number } | null = null;

export function authUrl(redirectUri: string, site: string, env: NodeJS.ProcessEnv = siteEnv()): string {
  if (!googleConfigured(env)) throw new Error('Google sign-in is not set up: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  pending = { state, verifier, redirectUri, site, at: Date.now() };
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `${GOOGLE.auth}?${q}`;
}

/** Swap the code for tokens. Returns the site that started the sign-in; the tokens are saved in that site's folder. */
export async function finishAuth(code: string, state: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const p = pending;
  pending = null;
  if (!p || p.state !== state || Date.now() - p.at > 10 * 60_000) throw new Error('sign-in expired or did not start here; try Connect again');
  await withSite(p.site, async () => {
    const t = await tokenRequest(
      { code, grant_type: 'authorization_code', redirect_uri: p.redirectUri, code_verifier: p.verifier },
      env ?? siteEnv(),
    );
    if (!t.refresh_token) throw new Error('Google did not return a refresh token; remove Plume from your Google account permissions and connect again');
    saveTokens(t);
  });
  return p.site;
}

async function tokenRequest(params: Record<string, string>, env: NodeJS.ProcessEnv): Promise<Tokens> {
  const res = await fetch(GOOGLE.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, ...params }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description ?? data.error ?? res.status}`);
  return { access_token: data.access_token, refresh_token: data.refresh_token, scope: data.scope, expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 };
}

/** A valid access token, refreshed when it's within a minute of expiring. */
export async function accessToken(env: NodeJS.ProcessEnv = siteEnv()): Promise<string> {
  if (!googleConnected()) throw new Error('Google is not connected');
  const t: Tokens = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
  if (t.expires_at - 60_000 > Date.now()) return t.access_token;
  if (!t.refresh_token) throw new Error('Google connection has no refresh token; connect again');
  const fresh = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' }, env);
  saveTokens({ ...fresh, refresh_token: fresh.refresh_token ?? t.refresh_token });
  return fresh.access_token;
}

/** Authenticated JSON call to a Google API. */
export async function googleApi<T>(url: string, body?: unknown, env: NodeJS.ProcessEnv = siteEnv()): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${await accessToken(env)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${data.error?.message ?? res.statusText}`);
  return data as T;
}
