import type { FastifyInstance } from 'fastify';
import { getSetting } from '../db';
import { Link, sendNewDrafts, telegramLink, telegramToken, tg, unlinkTelegram, wakeTelegram, weeklyReport } from '../phone/telegram';

/** Phone approvals (Telegram). Registered from the main route file. */
export function registerPhoneRoutes(app: FastifyInstance): void {
  const bad = (reply: any, err: any) => reply.code(400).send({ error: String(err?.message ?? err) });

  // A saved or removed bot token applies at once, instead of after the current wait for messages.
  app.addHook('onResponse', async (req, reply) => {
    if ((req.method === 'PUT' || req.method === 'DELETE') && req.url.split('?')[0] === '/api/integrations/telegram' && reply.statusCode < 300) wakeTelegram();
  });

  // The bot's name per token, for a minute: the Settings page asks every few seconds while waiting for a link.
  const names = new Map<string, { at: number; bot: string | null; problem: string | null }>();

  /** The link code and who is linked. The bot's own name comes from Telegram when a token is saved. */
  app.get('/api/telegram', async () => {
    const token = telegramToken();
    const link = telegramLink();
    let bot: string | null = null;
    let problem: string | null = null;
    if (token) {
      const hit = names.get(token);
      if (hit && Date.now() - hit.at < 60_000) ({ bot, problem } = hit);
      else {
        try {
          bot = (await tg(token, 'getMe', {}, 10_000)).username;
        } catch (err: any) {
          problem = err.message;
        }
        names.set(token, { at: Date.now(), bot, problem });
      }
    }
    return { connected: !!token, bot, problem, linked: !!link.chatId, name: link.name, linkedAt: link.linkedAt, code: link.code, lastReport: getSetting<string>('telegramReportWeek', '') || null };
  });

  app.post('/api/telegram/unlink', async () => {
    const l: Link = unlinkTelegram();
    return { linked: false, code: l.code };
  });

  /** Send the weekly report now, to check it arrives. */
  app.post('/api/telegram/test', async (_req, reply) => {
    const token = telegramToken();
    const chat = telegramLink().chatId;
    if (!token || !chat) return reply.code(400).send({ error: 'Save a bot token and link your chat first' });
    try {
      await tg(token, 'sendMessage', { chat_id: chat, text: weeklyReport(), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      return { ok: true, sent: await sendNewDrafts() };
    } catch (err) {
      return bad(reply, err);
    }
  });
}
