import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';

/**
 * Google sign-in for a desktop app: the browser comes back to 127.0.0.1 with a code,
 * which we swap for tokens. Read-only scopes only — Plume never changes anything in Google.
 */
export const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];

/** Overridable so tests can point at a fake server. */
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

const tokenFile = () => path.join(DATA_DIR, 'tokens', 'google.json');

export function googleConfigured(env = process.env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function googleConnected(): boolean {
  return fs.existsSync(tokenFile());
}

function saveTokens(t: Tokens): void {
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), JSON.stringify(t, null, 2), { mode: 0o600 });
}

export function disconnectGoogle(): void {
  fs.rmSync(tokenFile(), { force: true });
}

// One sign-in in flight at a time; state + PKCE verifier live only in memory.
let pending: { state: string; verifier: string; redirectUri: string; at: number } | null = null;

export function authUrl(redirectUri: string, env = process.env): string {
  if (!googleConfigured(env)) throw new Error('set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  pending = { state, verifier, redirectUri, at: Date.now() };
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

export async function finishAuth(code: string, state: string, env = process.env): Promise<void> {
  const p = pending;
  pending = null;
  if (!p || p.state !== state || Date.now() - p.at > 10 * 60_000) throw new Error('sign-in expired or did not start here; try Connect again');
  const t = await tokenRequest(
    { code, grant_type: 'authorization_code', redirect_uri: p.redirectUri, code_verifier: p.verifier },
    env,
  );
  if (!t.refresh_token) throw new Error('Google did not return a refresh token; remove Plume from your Google account permissions and connect again');
  saveTokens(t);
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
export async function accessToken(env = process.env): Promise<string> {
  if (!googleConnected()) throw new Error('Google is not connected');
  const t: Tokens = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
  if (t.expires_at - 60_000 > Date.now()) return t.access_token;
  if (!t.refresh_token) throw new Error('Google connection has no refresh token; connect again');
  const fresh = await tokenRequest({ refresh_token: t.refresh_token, grant_type: 'refresh_token' }, env);
  saveTokens({ ...fresh, refresh_token: fresh.refresh_token ?? t.refresh_token });
  return fresh.access_token;
}

/** Authenticated JSON call to a Google API. */
export async function googleApi<T>(url: string, body?: unknown, env = process.env): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${await accessToken(env)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${data.error?.message ?? res.statusText}`);
  return data as T;
}
