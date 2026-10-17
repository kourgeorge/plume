import nodemailer from 'nodemailer';
import type { Publisher, PublishResult } from '../publish';
import type { Draft } from '../queue';
import { listDrafts } from '../queue';
import { declinedEmails, getContact, isEmail, markEmailed } from './store';

/**
 * Outreach email through the owner's own mail account (SMTP). Approving an email draft sends it.
 * Built-in limits, because a mailbox that sends too much gets blocked and people who said no stay no:
 * - never to an address that declined, and never twice to one address within 30 days;
 * - only to addresses Plume saw on the person's own page, or that the owner typed;
 * - a daily cap (default 10); extra approved emails wait for the next day;
 * - every email ends with a plain way to opt out.
 */

export function emailDailyLimit(env: NodeJS.ProcessEnv): number {
  const n = Number(env.SMTP_DAILY_LIMIT);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 10;
}

export function emailsSentToday(now = new Date()): number {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  return listDrafts({ status: 'published' }).filter((d) => d.target === 'email' && !d.dryRun && d.updatedAt >= since).length;
}

export const OPT_OUT = 'If you would rather not hear from me again, just reply "no thanks" and I won\'t write again.';

/** The body as sent: the draft text, then the opt-out line (added if the draft doesn't already say it). */
export function finalBody(body: string): string {
  const t = body.trim();
  return /no thanks|unsubscribe|won.t write again|not hear from me/i.test(t) ? t : `${t}\n\n${OPT_OUT}`;
}

let testTransport: { sendMail(m: any): Promise<any>; verify(): Promise<any> } | null = null;
/** Tests capture messages instead of sending them. */
export function setTransportForTests(t: typeof testTransport): void {
  testTransport = t;
}

function transport(env: NodeJS.ProcessEnv) {
  if (testTransport) return testTransport;
  const port = Number(env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
  });
}

/** Why this email must not go out, or null when it may. Checked again at send time, not only when drafted. */
export function blockReason(draft: Draft, now = new Date()): string | null {
  const m = draft.meta as any;
  const to = String(m.to ?? '').trim().toLowerCase();
  if (!isEmail(to)) return 'this email has no valid address to send to';
  if (!m.subject || String(m.subject).length > 200) return 'this email needs a subject under 200 characters';
  if (declinedEmails().has(to)) return `${to} said no before — Plume won't write to them again`;
  const contact = m.contactId ? getContact(Number(m.contactId)) : undefined;
  if (contact && contact.email && contact.email !== to) return `the address changed since this was drafted (now ${contact.email}) — check it`;
  if (contact && !contact.emailVerified) return `Plume didn't see ${to} on their own page. Check it and save it on the contact before sending.`;
  const cutoff = new Date(now.getTime() - 30 * 86400e3).toISOString();
  const recent = listDrafts({ status: 'published' }).some((d) => d.id !== draft.id && d.target === 'email' && !d.dryRun && String((d.meta as any).to ?? '').toLowerCase() === to && d.updatedAt >= cutoff);
  if (recent) return `you already emailed ${to} in the last 30 days`;
  return null;
}

export const emailPublisher: Publisher = {
  id: 'email',
  label: 'Email (your mail account)',
  needs: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'],
  configured: (env = process.env) => !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD && env.SMTP_FROM),
  async publish(draft: Draft, _html: string, env = process.env): Promise<PublishResult> {
    const why = blockReason(draft);
    if (why) throw new Error(why);
    const m = draft.meta as any;
    const info = await transport(env).sendMail({
      from: env.SMTP_FROM,
      to: String(m.to).trim(),
      subject: String(m.subject),
      text: finalBody(draft.body),
      ...(env.SMTP_REPLY_TO ? { replyTo: env.SMTP_REPLY_TO } : {}),
    });
    if (m.contactId) markEmailed(Number(m.contactId));
    return { url: null, externalId: info.messageId ?? null, dryRun: false };
  },
};

/** The Settings "Test" button: sign in to the mail server without sending anything. */
export async function testEmail(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }> {
  try {
    await transport(env).verify();
    return { ok: true, message: `Signed in to ${env.SMTP_HOST} as ${env.SMTP_USER}. Nothing was sent.` };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/auth|535|534|credentials/i.test(msg)) return { ok: false, message: `The mail server refused the login. For Gmail and Outlook use an "app password", not your normal password. (${msg.slice(0, 120)})` };
    if (/ENOTFOUND|getaddrinfo/i.test(msg)) return { ok: false, message: `There's no mail server at ${env.SMTP_HOST} — check the address.` };
    if (/timeout|ETIMEDOUT|ECONNREFUSED/i.test(msg)) return { ok: false, message: `Couldn't reach ${env.SMTP_HOST}:${env.SMTP_PORT || 587} — check the port (usually 587, or 465).` };
    return { ok: false, message: msg.slice(0, 200) };
  }
}
