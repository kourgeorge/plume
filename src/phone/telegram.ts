import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDb, getGlobalDb, getSetting, setSetting } from '../db';
import { siteEnv } from '../integrations';
import { log } from '../log';
import { currentSite, withSite } from '../site';
import { getSite, listSites } from '../sites';
import { Draft, editDraft, getDraft, listDrafts, moveDraft } from '../queue';
import { countDone, notUseful, preview } from '../today';
import { checkTarget, getPublisher, targetsFor } from '../publish';
import { publishOne } from '../publish/runner';
import { PORT } from '../config';

/**
 * Approve drafts from your phone with a Telegram bot. Each website can have its own bot (BotFather token,
 * saved under Settings). Plume asks Telegram for new messages every few seconds ("long polling"), so it
 * needs no public address — it works on a laptop.
 *
 * Safety: the bot answers one chat only — the one that sent the one-time link code shown in Settings.
 * Everyone else is ignored. Approving does exactly what the Today card does: publish to the first
 * connected place that fits the draft, or save files when none is connected.
 */

export const TELEGRAM_API = { base: (process.env.TELEGRAM_API_URL || 'https://api.telegram.org').replace(/\/$/, '') };

const TABLES = `
CREATE TABLE IF NOT EXISTS telegram_sent (
  draft_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS telegram_sent_by_draft ON telegram_sent (draft_id);
`;
const ready = new WeakSet<Database.Database>();
function tdb(): Database.Database {
  const d = getDb();
  if (!ready.has(d)) {
    d.exec(TABLES);
    ready.add(d);
  }
  return d;
}

export interface Link {
  chatId: string | null;
  /** Who linked, as Telegram reports it — for the Settings page. */
  name: string | null;
  linkedAt: string | null;
  /** One-time code to send as "/start <code>". Replaced after use. */
  code: string;
}

export function telegramLink(): Link {
  const l = getSetting<Link | null>('telegramLink', null);
  if (l?.code) return l;
  const fresh: Link = { chatId: l?.chatId ?? null, name: l?.name ?? null, linkedAt: l?.linkedAt ?? null, code: crypto.randomBytes(6).toString('hex') };
  setSetting('telegramLink', fresh);
  return fresh;
}

export function unlinkTelegram(): Link {
  setSetting('telegramLink', null);
  return telegramLink();
}

/**
 * This website's bot token — only one saved on its own Settings page, never one from the environment.
 * Other tools set TELEGRAM_BOT_TOKEN in the shell for their own bot; Telegram hands each message to
 * whoever asks first, so reading that bot would steal its messages and post drafts into it.
 */
export function telegramToken(env = siteEnv()): string {
  return (env.TELEGRAM_BOT_TOKEN ?? '').trim();
}

/** One Bot API call. Errors come back in plain words. */
export async function tg(token: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 20_000, stop?: AbortSignal): Promise<any> {
  const res = await fetch(`${TELEGRAM_API.base}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: stop ? AbortSignal.any([AbortSignal.timeout(timeoutMs), stop]) : AbortSignal.timeout(timeoutMs),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!data.ok) {
    if (res.status === 401 || res.status === 404) throw new Error('Telegram does not recognise this bot token — copy it again from @BotFather');
    throw new Error(`Telegram said ${res.status}: ${data.description ?? res.statusText}`);
  }
  return data.result;
}

export async function testTelegram(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }> {
  if (!telegramToken(env)) return { ok: false, message: 'No bot token saved for this website yet.' };
  try {
    const me = await tg(telegramToken(env), 'getMe');
    return { ok: true, message: `Connected to @${me.username}. Send it the link code shown below to start.` };
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------- messages

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const KIND: Record<string, string> = {
  blog_post: 'Blog post', landing_page: 'Landing page', article: 'Article', social_post: 'Social post', x_post: 'X post', x_thread: 'X thread',
  linkedin_post: 'LinkedIn post', facebook_post: 'Facebook post', reddit_reply: 'Reddit reply', reddit_post: 'Reddit post', outreach_email: 'Email', outreach_message: 'Message', video_script: 'Video script',
};

/** Where Approve sends a draft: the first connected place that fits, as the Today card picks; else files. */
export function defaultTarget(d: Draft, env = siteEnv()): string {
  const fits = targetsFor(d.kind);
  return fits.find((id) => id !== 'export' && getPublisher(id)?.configured(env)) ?? 'export';
}

export function dashboardUrl(draftId?: number): string {
  return `http://127.0.0.1:${PORT}/s/${encodeURIComponent(currentSite())}/${draftId ? `#draft/${draftId}` : '#today'}`;
}

/** The text of a draft message. Short posts in full; articles as a preview — Telegram caps a message at 4096 characters. */
export function draftMessage(d: Draft, env = siteEnv()): string {
  const site = getSite(currentSite())?.name ?? currentSite();
  const short = /^(x_|linkedin|facebook|social|reddit|outreach)/.test(d.kind);
  const body = short && d.body.length <= 2500 ? d.body.trim() : preview(d.body, 80);
  const m = d.meta as any;
  const target = defaultTarget(d, env);
  const where = target === 'export' ? 'Approve saves it as files (nothing is connected for this yet).' : `Approve publishes it to ${getPublisher(target)!.label}.`;
  return [
    `<b>${esc(site)}</b> · ${esc(KIND[d.kind] ?? d.kind)}`,
    `<b>${esc(d.title)}</b>`,
    m.reason ? `<i>${esc(String(m.reason))}</i>` : '',
    m.to ? `To: ${esc(String(m.to))} · ${esc(String(m.subject ?? ''))}` : m.howToSend ? esc(String(m.howToSend)) : '',
    '',
    esc(body),
    '',
    `${esc(where)} Reply to this message with new text to replace it.`,
  ]
    .filter((l, i, a) => l !== '' || (a[i - 1] ?? '') !== '')
    .join('\n')
    .slice(0, 4000);
}

function buttons(d: Draft) {
  return {
    inline_keyboard: [
      [
        { text: '✓ Approve', callback_data: `a:${d.id}` },
        { text: '✗ Not useful', callback_data: `n:${d.id}` },
      ],
    ],
  };
}

/** Send drafts that are waiting and haven't been sent yet. Returns how many went out. */
export async function sendNewDrafts(env = siteEnv(), max = 5): Promise<number> {
  const token = telegramToken(env);
  const chat = getSetting<Link | null>('telegramLink', null)?.chatId;
  if (!token || !chat) return 0;
  const sent = new Set((tdb().prepare('SELECT draft_id FROM telegram_sent').all() as { draft_id: number }[]).map((r) => r.draft_id));
  // Only drafts made after linking: linking a busy site shouldn't flood the phone with its backlog.
  const since = getSetting<Link | null>('telegramLink', null)?.linkedAt ?? '';
  const todo = listDrafts({ status: 'draft' })
    .filter((d) => !sent.has(d.id) && d.createdAt >= since)
    .sort((a, b) => a.id - b.id)
    .slice(0, max);
  for (const d of todo) {
    const msg = await tg(token, 'sendMessage', { chat_id: chat, text: draftMessage(d, env), parse_mode: 'HTML', reply_markup: buttons(d), link_preview_options: { is_disabled: true } });
    tdb().prepare('INSERT OR IGNORE INTO telegram_sent (draft_id, chat_id, message_id, sent_at) VALUES (?, ?, ?, ?)').run(d.id, String(chat), msg.message_id, new Date().toISOString());
  }
  return todo.length;
}

// ---------------------------------------------------------------- handling what comes back

/** What happened, in words for the chat. Exported for tests: `update` is one Telegram update. */
export async function handleUpdate(update: any, env = siteEnv()): Promise<string | null> {
  const token = telegramToken(env);
  const link = telegramLink();
  const msg = update.message;
  const cb = update.callback_query;
  const fromChat = String(msg?.chat?.id ?? cb?.message?.chat?.id ?? '');
  if (!fromChat) return null;

  // Linking: "/start <code>" from any chat, if the code is right. A wrong code gets no detail.
  const start = typeof msg?.text === 'string' && /^\/start(?:@\w+)?\s+(\S+)/.exec(msg.text.trim());
  if (start) {
    if (start[1] !== link.code) return reply(token, fromChat, "That link code isn't right. Copy it again from Plume's Settings.");
    const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'you';
    setSetting('telegramLink', { chatId: fromChat, name, linkedAt: new Date().toISOString(), code: crypto.randomBytes(6).toString('hex') });
    return reply(token, fromChat, `Linked to ${getSite(currentSite())?.name ?? currentSite()}. New drafts will arrive here with Approve and Not useful buttons.`);
  }
  if (!link.chatId && typeof msg?.text === 'string' && /^\/start\b/.test(msg.text.trim())) {
    return reply(token, fromChat, 'To link this chat, send /start followed by the link code shown in Plume under Settings → Phone approvals.');
  }
  // Everything else only from the linked chat.
  if (!link.chatId || fromChat !== link.chatId) return null;

  if (cb) {
    const [, action, idText] = /^([an]):(\d+)$/.exec(String(cb.data ?? '')) ?? [];
    const d = idText ? getDraft(Number(idText)) : undefined;
    let note: string;
    if (!d) note = 'That draft no longer exists.';
    else if (d.status !== 'draft' && d.status !== 'failed') note = `Already ${d.status}.`;
    else if (action === 'n') {
      notUseful(d.id, 'from Telegram');
      note = 'Marked not useful. The agent will learn from it.';
    } else {
      const target = defaultTarget(d, env);
      checkTarget(d.kind, target);
      moveDraft(d.id, 'approved', { target, scheduledFor: null, note: 'approved from Telegram' });
      countDone();
      const after = await publishOne(d.id);
      note =
        after.status === 'published'
          ? after.dryRun || target === 'export'
            ? 'Approved and saved as files.'
            : `Published${after.publishedUrl ? `: ${after.publishedUrl}` : ` to ${getPublisher(target)!.label}`}.`
          : after.status === 'approved'
            ? 'Approved. It goes out as soon as today\'s limit allows.'
            : `Approved, but publishing failed: ${after.error}`;
    }
    await tg(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: note.slice(0, 190) }).catch(() => {});
    if (d && cb.message?.message_id) {
      await tg(token, 'editMessageReplyMarkup', { chat_id: fromChat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    }
    return reply(token, fromChat, note, cb.message?.message_id);
  }

  if (typeof msg?.text === 'string') {
    // A reply to a draft message replaces that draft's text.
    const to = msg.reply_to_message?.message_id;
    if (to) {
      const row = tdb().prepare('SELECT draft_id FROM telegram_sent WHERE chat_id = ? AND message_id = ?').get(fromChat, to) as { draft_id: number } | undefined;
      const d = row ? getDraft(row.draft_id) : undefined;
      if (!d) return reply(token, fromChat, "I can't tell which draft that reply is for. Reply to a draft's own message.");
      if (d.status !== 'draft' && d.status !== 'failed') return reply(token, fromChat, `"${d.title}" is already ${d.status}, so it can't be edited.`);
      const after = editDraft(d.id, { body: msg.text });
      const sent = await tg(token, 'sendMessage', { chat_id: fromChat, text: `Saved your text for "${esc(after.title)}". Approve it here when ready.`, parse_mode: 'HTML', reply_markup: buttons(after) });
      tdb().prepare('INSERT OR IGNORE INTO telegram_sent (draft_id, chat_id, message_id, sent_at) VALUES (?, ?, ?, ?)').run(d.id, fromChat, sent.message_id, new Date().toISOString());
      return `edited draft ${d.id}`;
    }
    if (/^\/(report|today)\b/.test(msg.text.trim())) return reply(token, fromChat, weeklyReport(), undefined, true);
    return reply(
      token,
      fromChat,
      `Drafts arrive here as agents finish them. Tap Approve or Not useful, or reply to a draft with new text. /report shows the last 7 days. Everything else: ${dashboardUrl()}`,
    );
  }
  return null;
}

async function reply(token: string, chat: string, text: string, replyTo?: number, html = false): Promise<string> {
  await tg(token, 'sendMessage', { chat_id: chat, text, ...(html ? { parse_mode: 'HTML' } : {}), ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}), link_preview_options: { is_disabled: true } }).catch((err) =>
    log('warn', 'telegram', `couldn't reply: ${err.message}`),
  );
  return text;
}

// ---------------------------------------------------------------- weekly report

/** The last 7 days in a few lines: what was made, approved, published, turned down, and what's waiting. */
export function weeklyReport(now = new Date()): string {
  const since = new Date(now.getTime() - 7 * 86400e3).toISOString();
  const all = listDrafts();
  const made = all.filter((d) => d.createdAt >= since).length;
  const published = all.filter((d) => d.status === 'published' && d.updatedAt >= since);
  const live = published.filter((d) => !d.dryRun && d.target !== 'export');
  const rejected = all.filter((d) => d.status === 'rejected' && d.updatedAt >= since).length;
  const waiting = all.filter((d) => d.status === 'draft').length;
  const failed = all.filter((d) => d.status === 'failed').length;
  const cost = (getGlobalDb().prepare('SELECT COALESCE(SUM(cost_usd), 0) c FROM llm_calls WHERE site = ? AND at >= ?').get(currentSite(), since) as { c: number }).c;
  const site = getSite(currentSite())?.name ?? currentSite();
  return [
    `<b>${esc(site)} — the last 7 days</b>`,
    `${made} draft(s) written, ${published.length} approved${live.length ? ` (${live.length} published live)` : ''}, ${rejected} turned down.`,
    ...live.slice(0, 5).map((d) => `• ${esc(d.title)}${d.publishedUrl?.startsWith('http') ? ` — ${esc(d.publishedUrl)}` : ''}`),
    waiting ? `${waiting} waiting for you.` : 'Nothing waiting.',
    failed ? `${failed} failed to publish — open Plume to see why.` : '',
    `AI cost: $${cost.toFixed(2)}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Monday mornings, once per week per site. */
export async function sendWeeklyReport(env = siteEnv(), now = new Date()): Promise<boolean> {
  const token = telegramToken(env);
  const chat = getSetting<Link | null>('telegramLink', null)?.chatId;
  if (!token || !chat) return false;
  const week = `${now.getFullYear()}-${Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / (7 * 86400e3))}`;
  if (getSetting<string>('telegramReportWeek', '') === week) return false;
  await tg(token, 'sendMessage', { chat_id: chat, text: weeklyReport(now), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  setSetting('telegramReportWeek', week);
  return true;
}

// ---------------------------------------------------------------- the loop

let running = false;
const offsets = new Map<string, number>();
/** Cut the current wait short (a token was saved or removed), so the change applies at once. */
let wake = new AbortController();
export function wakeTelegram(): void {
  wake.abort();
}

/** One round for one site: fetch what came in (waiting up to `waitS` seconds), handle it, send new drafts. */
export async function pollOnce(waitS = 0, stop?: AbortSignal): Promise<void> {
  const env = siteEnv();
  const token = telegramToken(env);
  if (!token) return;
  const offset = offsets.get(token) ?? 0;
  let updates: any[];
  try {
    updates = await tg(token, 'getUpdates', { offset, timeout: waitS, allowed_updates: ['message', 'callback_query'] }, (waitS + 15) * 1000, stop);
  } catch (err) {
    if (stop?.aborted) return;
    throw err;
  }
  for (const u of updates) {
    offsets.set(token, u.update_id + 1);
    try {
      await handleUpdate(u, env);
    } catch (err: any) {
      log('warn', 'telegram', `couldn't handle a message: ${err.message}`);
    }
  }
  await sendNewDrafts(env);
  const now = new Date();
  if (now.getDay() === 1 && now.getHours() >= 8) await sendWeeklyReport(env, now);
}

/** Runs for the life of the app. Each site with a bot token gets a round every few seconds. */
export function startTelegram(): void {
  if (running) return;
  running = true;
  const failing = new Map<string, number>();
  const nap = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      wake.signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
  const loop = async () => {
    for (;;) {
      if (wake.signal.aborted) wake = new AbortController();
      // One bot belongs to one website: Telegram hands each message to whoever asks first.
      const owner = new Map<string, string>();
      for (const s of listSites()) {
        const t = withSite(s.slug, () => telegramToken());
        if (!t) continue;
        if (owner.has(t)) {
          if (!failing.has(`dup:${s.slug}`)) log('warn', 'telegram', `${s.slug} uses the same bot as ${owner.get(t)} — make a separate bot for each website. Skipping ${s.slug}.`);
          failing.set(`dup:${s.slug}`, 1);
        } else owner.set(t, s.slug);
      }
      const sites = [...owner.values()].map((slug) => ({ slug }));
      if (!sites.length) {
        await nap(30_000);
        continue;
      }
      let trouble = false;
      for (const s of sites) {
        // Several sites take turns, so none waits long; one site can wait on Telegram for new messages.
        await withSite(s.slug, () => pollOnce(sites.length === 1 ? 25 : 1, wake.signal)).then(
          () => failing.delete(s.slug),
          (err) => {
            trouble = true;
            const n = (failing.get(s.slug) ?? 0) + 1;
            failing.set(s.slug, n);
            if (n === 1 || n % 60 === 0) log('warn', 'telegram', `${s.slug}: ${err.message}`);
          },
        );
      }
      // After an error (bad token, no internet) wait a while instead of asking again at once.
      await nap(trouble ? 30_000 : sites.length === 1 ? 500 : 3000);
    }
  };
  loop();
}
