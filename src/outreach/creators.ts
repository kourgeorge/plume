import * as cheerio from 'cheerio';
import { MODELS } from '../config';
import { agentSystem } from '../context/profile';
import { listPeople } from '../context/extra';
import { askJson } from '../llm/client';
import { createDraft } from '../queue';
import { siteEnv } from '../integrations';
import { siteUrl } from '../sites';
import { fetchPage } from '../research/fetchPage';
import type { Agent, Opportunity } from '../agents/types';
import { Contact, absUrl, addContact, cleanUrl, declinedEmails, getContact, isEmail, listContacts, readyToDraft, updateContact } from './store';

/**
 * Influencer outreach: find creators who talk to the business's customers, read their own pages for a
 * public contact address, and draft a short, personal first message. Plume never guesses an address:
 * one is kept only if it appears on the creator's own page, or the owner types it.
 */

export const YOUTUBE_API = { base: 'https://www.googleapis.com/youtube/v3' };

// ---------------------------------------------------------------- finding addresses on a page

/**
 * A page's visible text with a space between elements. cheerio's .text() runs neighbouring paragraphs
 * together ("…creator.example" + "noreply@…"), which breaks addresses and names at element edges.
 */
export function pageText($: cheerio.CheerioAPI): string {
  $('script, style, noscript, template').remove();
  $('body *').append(' ');
  return $('body').text().replace(/\s+/g, ' ').trim();
}

const JUNK_EMAIL =/(example\.|sentry|wixpress|@2x|\.png|\.jpe?g|\.gif|\.webp|noreply|no-reply|donotreply|privacy@|abuse@|postmaster@|support@youtube|@google\.com)/i;

/** Public contact addresses on a page: mailto links first, then addresses written in the text. */
export function emailsOnPage(html: string): string[] {
  const $ = cheerio.load(html);
  const found: string[] = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const addr = decodeURIComponent(String($(el).attr('href')).slice(7).split('?')[0]).trim().toLowerCase();
    if (addr) found.push(addr);
  });
  const text = pageText($).replace(/\s*(\[at\]|\(at\)| at )\s*/gi, (m) => (/\[|\(/.test(m) ? '@' : m)).replace(/\s*(\[dot\]|\(dot\))\s*/gi, '.');
  for (const m of text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) found.push(m.toLowerCase());
  return [...new Set(found)].filter((e) => isEmail(e) && !JUNK_EMAIL.test(e)).slice(0, 5);
}

/** Look for a contact address on the creator's page and, if they have a website, its contact page. */
export async function findEmail(urls: string[], fetchFn: typeof fetch = fetch): Promise<{ email: string; source: string } | null> {
  const tries: string[] = [];
  for (const u of urls) {
    try {
      const base = absUrl(u);
      tries.push(base);
      if (!/youtube\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|linkedin\.com|facebook\.com/.test(new URL(base).hostname)) {
        tries.push(`${new URL(base).origin}/contact`, `${new URL(base).origin}/about`);
      }
    } catch {
      /* skip a malformed address */
    }
  }
  for (const u of [...new Set(tries)].slice(0, 5)) {
    const r = await fetchPage(u, { fetchFn, browserFn: null });
    if (!r.ok) continue;
    const e = emailsOnPage(r.html)[0];
    if (e) return { email: e, source: u };
  }
  return null;
}

// ---------------------------------------------------------------- YouTube (optional, real numbers)

export async function testYouTube(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${YOUTUBE_API.base}/search?part=snippet&type=channel&maxResults=1&q=test&key=${encodeURIComponent(env.YOUTUBE_API_KEY ?? '')}`, { signal: AbortSignal.timeout(20_000) });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, message: 'YouTube search works.' };
    return { ok: false, message: `YouTube said ${res.status}: ${data.error?.message ?? res.statusText}${res.status === 403 ? ' — turn on "YouTube Data API v3" for this key' : ''}` };
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Channels for a search, with real subscriber counts. Empty when there is no key. */
export async function youtubeChannels(query: string, env = siteEnv(), limit = 8): Promise<{ name: string; url: string; audience: string; about: string }[]> {
  if (!env.YOUTUBE_API_KEY) return [];
  const key = encodeURIComponent(env.YOUTUBE_API_KEY);
  const s = await fetch(`${YOUTUBE_API.base}/search?part=snippet&type=channel&maxResults=${limit}&q=${encodeURIComponent(query)}&key=${key}`, { signal: AbortSignal.timeout(20_000) });
  const sd: any = await s.json().catch(() => ({}));
  if (!s.ok) throw new Error(`YouTube search failed (${s.status}): ${sd.error?.message ?? s.statusText}`);
  const ids = (sd.items ?? []).map((i: any) => i.id?.channelId).filter(Boolean);
  if (!ids.length) return [];
  const c = await fetch(`${YOUTUBE_API.base}/channels?part=snippet,statistics&id=${ids.join(',')}&key=${key}`, { signal: AbortSignal.timeout(20_000) });
  const cd: any = await c.json().catch(() => ({}));
  return (cd.items ?? []).map((ch: any) => ({
    name: String(ch.snippet?.title ?? ''),
    url: ch.snippet?.customUrl ? `https://www.youtube.com/${ch.snippet.customUrl}` : `https://www.youtube.com/channel/${ch.id}`,
    audience: ch.statistics?.hiddenSubscriberCount ? '' : `${fmt(Number(ch.statistics?.subscriberCount ?? 0))} subscribers`,
    about: String(ch.snippet?.description ?? '').slice(0, 400),
  }));
}

// ---------------------------------------------------------------- the agent

const ROLE = `You find creators (YouTubers, podcasters, bloggers, Instagram and TikTok accounts, newsletter writers)
whose audience is this business's customers, and you write to them like a real person who knows their work.
Never invent follower counts, contact details or past collaborations.`;

const FIND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['youtube_search', 'creators'],
  properties: {
    youtube_search: { type: 'string', description: 'A short YouTube search (2–5 words) for channels this audience watches, in their language.' },
    creators: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'url', 'platform', 'audience', 'why', 'website'],
        properties: {
          name: { type: 'string' },
          url: { type: 'string', description: 'Their profile or channel address, as found in the search results.' },
          platform: { type: 'string', enum: ['youtube', 'instagram', 'tiktok', 'podcast', 'blog', 'newsletter', 'x', 'linkedin', 'other'] },
          audience: { type: 'string', description: 'Audience size only if a search result states it, e.g. "45k subscribers". Otherwise empty.' },
          why: { type: 'string', description: 'One sentence: why their audience fits this business.' },
          website: { type: 'string', description: 'Their own website if the results show one, else empty.' },
        },
      },
    },
  },
};

const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string', description: 'Short and specific, no clickbait.' },
    body: { type: 'string', description: 'Plain text, under 150 words. Signed with the sender name given.' },
  },
};

/** Who signs outreach: the first person in People, else the business itself. */
export function senderName(): string {
  const p = listPeople()[0];
  const site = siteUrl();
  return p ? `${p.name}${p.role ? `, ${p.role}` : ''}` : site ? new URL(site).hostname.replace(/^www\./, '') : 'The team';
}

/** Search the web (and YouTube when a key is set), add new creators to the list, look up their addresses. */
export async function discoverCreators(onProgress: (m: string) => void = () => {}, fetchFn: typeof fetch = fetch): Promise<Contact[]> {
  onProgress('Looking for creators your customers follow');
  const known = listContacts('creator').map((c) => c.url);
  const found = await askJson<{ youtube_search: string; creators: { name: string; url: string; platform: string; audience: string; why: string; website: string }[] }>({
    purpose: 'influencer:find',
    model: MODELS.research,
    effort: 'medium',
    webSearches: 6,
    maxTokens: 8000,
    system: agentSystem(ROLE, undefined, undefined, 'influencer'),
    schema: FIND_SCHEMA,
    prompt:
      'Find 8 creators to approach about this business. Prefer smaller, focused creators (a few thousand to a hundred thousand followers) over celebrities — they answer, and their audience trusts them. ' +
      'Use only addresses that appear in the search results.' +
      (known.length ? `\nAlready on the list (skip them):\n${known.slice(0, 40).map((u) => `- ${u}`).join('\n')}` : ''),
  });
  // With a YouTube key, also search YouTube itself for the topic — that gives real subscriber counts.
  const yt: { name: string; url: string; audience: string; about: string }[] = [];
  if (found.youtube_search?.trim()) {
    try {
      onProgress(`Searching YouTube for "${found.youtube_search}"`);
      yt.push(...(await youtubeChannels(found.youtube_search.trim())));
    } catch (err: any) {
      onProgress(`YouTube lookup skipped: ${err.message}`);
    }
  }
  const added: Contact[] = [];
  const candidates = [
    ...found.creators.map((c) => ({ ...c, urls: [c.url, c.website].filter(Boolean) })),
    ...yt.map((c) => ({ name: c.name, url: c.url, platform: 'youtube', audience: c.audience, why: 'found on YouTube for the same topic', website: '', urls: [c.url] })),
  ];
  for (const [i, c] of candidates.entries()) {
    let url: string;
    try {
      url = cleanUrl(c.url);
    } catch {
      continue;
    }
    if (known.includes(url)) continue;
    onProgress(`Checking ${c.name} (${i + 1} of ${candidates.length})`);
    const email = await findEmail(c.urls, fetchFn).catch(() => null);
    const row = addContact({
      kind: 'creator',
      name: c.name,
      url,
      platform: c.platform,
      audience: c.audience,
      email: email?.email,
      emailSource: email?.source,
      emailVerified: !!email,
      why: c.why,
    });
    if (row) added.push(row);
  }
  return added;
}

/** A first message to one creator: an email when Plume found their address, else a message to send by hand. */
export async function draftCreatorMessage(contact: Contact) {
  const m = await askJson<{ subject: string; body: string }>({
    purpose: 'influencer:draft',
    model: MODELS.draft,
    maxTokens: 3000,
    system: agentSystem(ROLE, undefined, undefined, 'influencer'),
    schema: MESSAGE_SCHEMA,
    prompt:
      `Write a first message to ${contact.name} (${contact.platform}, ${contact.url}${contact.audience ? `, ${contact.audience}` : ''}).\n` +
      `Why they fit: ${contact.why}\n` +
      `Say in one line what the business is and why their audience would care, suggest one simple idea (a review, a mention, a giveaway), ` +
      `and ask if they'd be open to it and what they usually charge. Don't flatter, don't overpromise. Sign as ${senderName()}. ` +
      `Write in the language their content uses.`,
  });
  const email = contact.emailVerified && !declinedEmails().has(contact.email) ? contact.email : '';
  const d = createDraft({
    agent: 'influencer',
    kind: email ? 'outreach_email' : 'outreach_message',
    title: `${contact.name}: ${m.subject}`.slice(0, 200),
    body: m.body.trim(),
    meta: {
      reason: contact.why,
      to: email || undefined,
      subject: m.subject,
      contactId: contact.id,
      contactUrl: contact.url,
      ...(email ? {} : { howToSend: `No public email found — send it through ${contact.platform === 'other' ? 'their site' : contact.platform}: ${contact.url}` }),
    },
  });
  updateContact(contact.id, { status: 'drafted' });
  return d;
}

export const influencerAgent: Agent = {
  id: 'influencer',
  label: 'Influencers',
  description: 'Finds creators your customers follow, finds their public contact address, and drafts a personal first message. Track replies, rates and posts under Outreach.',
  async findOpportunities({ limit = 3, onProgress }) {
    if (readyToDraft('creator', limit).length < limit) await discoverCreators(onProgress);
    return readyToDraft('creator', limit).map<Opportunity>((c) => ({ title: c.name, reason: c.why, kind: 'outreach', contactId: c.id }));
  },
  async draft(opp) {
    const c = getContact(Number(opp.contactId));
    return c ? draftCreatorMessage(c) : null;
  },
};
