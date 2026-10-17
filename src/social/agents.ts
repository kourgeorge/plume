import { MODELS } from '../config';
import { agentSystem } from '../context/profile';
import { listPeople } from '../context/extra';
import { askJson } from '../llm/client';
import { createDraft, listDrafts } from '../queue';
import { siteEnv } from '../integrations';
import { siteUrl } from '../sites';
import type { Agent, Opportunity } from '../agents/types';
import { SOCIAL_API, facebookPublisher, linkedinPublisher, redditCall, redditPublisher, redditUserAgent, xPublisher } from './publishers';
import { FACEBOOK_LIMIT, LINKEDIN_LIMIT, X_LIMIT, X_THREAD_MAX, describeProblems, joinThread, lengthProblems, xLength } from './text';

const brandName = () => {
  const u = siteUrl();
  return u ? new URL(u).hostname.replace(/^www\./, '') : 'our product';
};

// ================================================================ X, LinkedIn and Facebook

type Channel = 'x' | 'linkedin' | 'facebook';
const CHANNEL_LABEL: Record<Channel, string> = { x: 'X', linkedin: 'LinkedIn', facebook: 'Facebook' };

const SOCIAL_ROLE = `You are the social media lead. You write posts people stop scrolling for: one clear idea each,
a concrete detail or number, and a reason to reply. No hashtag walls (two at most, only when they help), no emoji
confetti, no "In today's fast-paced world". Sound like the brand voice — or like the person you write as.
Plain text only: no Markdown, no headings.`;

const OPP_SCHEMA = (authors: string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['channel', 'format', 'angle', 'reason', 'author'],
        properties: {
          channel: { type: 'string', enum: ['x', 'linkedin', 'facebook'] },
          format: { type: 'string', enum: ['post', 'thread'], description: 'thread only for X' },
          angle: { type: 'string', description: 'The one idea of the post, in a sentence.' },
          reason: { type: 'string', description: 'Why this, why now — shown to the owner.' },
          author: { type: 'string', enum: authors, description: '"brand" or the name of a person from the profile.' },
        },
      },
    },
  },
});

const POST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'posts'],
  properties: {
    title: { type: 'string', description: 'A short label for the owner, not part of the post.' },
    posts: { type: 'array', items: { type: 'string' }, description: 'For an X thread, one item per post in order. Otherwise exactly one item.' },
  },
};

/**
 * Channels to write for: the ones connected for this site. When none are, X and LinkedIn (drafts then publish
 * as a dry run); Facebook only once a page is connected, since many businesses have none.
 */
export function socialChannels(env = siteEnv()): Channel[] {
  const on = ([['x', xPublisher], ['linkedin', linkedinPublisher], ['facebook', facebookPublisher]] as const).filter(([, p]) => p.configured(env)).map(([c]) => c);
  return on.length ? [...on] : ['x', 'linkedin'];
}

function recentWork(): string {
  const published = listDrafts({ status: 'published' }).filter((d) => !['x', 'linkedin', 'facebook', 'reddit'].includes(d.target ?? '')).slice(0, 8);
  const social = listDrafts().filter((d) => d.agent === 'social' && d.status !== 'rejected').slice(0, 15);
  return [
    published.length ? `Recently published on the site (worth sharing):\n${published.map((d) => `- "${d.title}"${d.publishedUrl?.startsWith('http') ? ` ${d.publishedUrl}` : ''}`).join('\n')}` : '',
    social.length ? `Social posts already written (don't repeat these angles):\n${social.map((d) => `- ${d.title}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

const channelRules = (channel: Channel, format: string) =>
  channel === 'x'
    ? format === 'thread'
      ? `An X thread of 3–${X_THREAD_MAX} posts. Each post must be under ${X_LIMIT} characters (a link counts as 23). The first post must work alone.`
      : `One X post under ${X_LIMIT} characters (a link counts as 23).`
    : channel === 'linkedin'
      ? `One LinkedIn post, 600–1,500 characters (hard limit ${LINKEDIN_LIMIT}). A strong first line — LinkedIn hides the rest behind "see more". Short paragraphs.`
      : `One Facebook Page post, 80–600 characters (hard limit ${FACEBOOK_LIMIT}). Friendly and direct, like talking to customers; one clear point and, when it fits, one link. Facebook hides long posts behind "See more", so the first two lines carry it.`;

export const socialAgent: Agent = {
  id: 'social',
  label: 'Social',
  description: 'Writes X posts and threads, LinkedIn posts and Facebook Page posts in your voice — as the brand or as one of your people.',
  async findOpportunities({ limit = 3, onProgress }) {
    onProgress?.('Choosing what to post about');
    const channels = socialChannels();
    const people = listPeople();
    const authors = ['brand', ...people.map((p) => p.name)];
    const res = await askJson<{ ideas: { channel: Channel; format: 'post' | 'thread'; angle: string; reason: string; author: string }[] }>({
      purpose: 'social:ideas',
      model: MODELS.draft,
      system: agentSystem(SOCIAL_ROLE, undefined, undefined, 'social'),
      schema: OPP_SCHEMA(authors),
      prompt:
        `Suggest ${limit} social posts for ${channels.map((c) => CHANNEL_LABEL[c]).join(', ')}, spread across those channels. Draw on the content plan, ` +
        `what works in the results, and recent work. ${people.length ? 'Posts can be written as the brand or as one of the people listed in the profile; LinkedIn usually works better from a person; Facebook Page posts always come from the brand.' : ''}\n\n` +
        recentWork(),
    });
    return res.ideas
      .filter((i) => channels.includes(i.channel))
      .slice(0, limit)
      .map<Opportunity>((i) => ({
        title: i.angle,
        reason: i.reason,
        kind: i.channel === 'x' ? (i.format === 'thread' ? 'x_thread' : 'x_post') : `${i.channel}_post`,
        channel: i.channel,
        format: i.channel === 'x' ? i.format : 'post',
        // A Page posts as itself, so a person can't be the author there.
        author: i.channel === 'facebook' ? 'brand' : i.author,
      }));
  },
  async draft(opp) {
    const channel = opp.channel as Channel;
    const author = String(opp.author ?? 'brand');
    const as = author === 'brand' ? `as the brand (${brandName()})` : `as ${author}, in first person, true to what the profile says about them`;
    let prompt = `Write it ${as}. ${channelRules(channel, String(opp.format))}\nThe idea: ${opp.title}\nWhy: ${opp.reason}`;
    let out!: { title: string; posts: string[] };
    let problems: ReturnType<typeof lengthProblems> = [];
    // Too long → ask again with the exact count. Never cut someone's sentence off.
    for (let attempt = 0; attempt < 3; attempt++) {
      out = await askJson<{ title: string; posts: string[] }>({
        purpose: `social:draft`,
        model: MODELS.draft,
        system: agentSystem(SOCIAL_ROLE, undefined, undefined, 'social'),
        schema: POST_SCHEMA,
        prompt,
      });
      const body = channel === 'x' && opp.format === 'thread' ? joinThread(out.posts) : out.posts.join('\n\n');
      problems = lengthProblems(channel, body);
      if (!problems.length) break;
      prompt += `\n\nYour last version was too long: ${describeProblems(channel, problems)}. Rewrite it shorter, keeping the idea. Do not just cut the end off.`;
    }
    const body = channel === 'x' && opp.format === 'thread' ? joinThread(out.posts) : out.posts.join('\n\n');
    const counts = channel === 'x' ? out.posts.map((p) => xLength(p)) : [[...body].length];
    return createDraft({
      agent: 'social',
      kind: String(opp.kind),
      title: out.title,
      body,
      meta: {
        channel,
        author,
        reason: opp.reason,
        lengthNote: problems.length ? `Still too long: ${describeProblems(channel, problems)}. Shorten it before approving.` : `${counts.join(' + ')} characters — fits.`,
      },
    });
  },
};

// ================================================================ Reddit

const REDDIT_ROLE = `You take part in Reddit conversations for this business. Reddit punishes advertising, so your
job is to be genuinely useful to the person asking: answer their actual question with specifics, the way a
knowledgeable member of that community would. Mention the business only when it directly answers the question,
at most once, and then say plainly that you work on it. Never invent experience, customers or numbers. Follow the
subreddit's rules. Plain Reddit Markdown, short paragraphs, no headings, no sign-off.`;

export interface Thread {
  id: string; // t3_…
  title: string;
  text: string;
  subreddit: string;
  url: string;
  comments: number;
  createdUtc: number;
}

/** Reddit search: signed in when the site has Reddit keys, otherwise Reddit's public pages. */
async function redditGet(path: string, query: Record<string, string>, env = siteEnv()): Promise<any> {
  const q = new URLSearchParams({ ...query, raw_json: '1' }).toString();
  if (redditPublisher.configured(env)) return redditCall(env, 'GET', `${path}?${q}`);
  const res = await fetch(`${SOCIAL_API.redditAuth}${path}.json?${q}`, { headers: { 'user-agent': redditUserAgent(env) }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 403 || res.status === 429) throw new Error('Reddit blocked searching from this computer. Add Reddit keys for this website under Settings so Plume can search signed in.');
  if (!res.ok) throw new Error(`Reddit said ${res.status} while searching`);
  return res.json();
}

/** Threads worth looking at: open, recent, not NSFW, and not already answered by a draft. */
export function usableThreads(children: any[], answered: Set<string>, now = Date.now()): Thread[] {
  return children
    .map((c) => c?.data)
    .filter((d) => d && d.name?.startsWith('t3_') && !d.locked && !d.archived && !d.over_18 && !d.stickied && !answered.has(d.name))
    .filter((d) => now / 1000 - Number(d.created_utc) < 30 * 86400)
    .map((d) => ({
      id: d.name,
      title: String(d.title ?? ''),
      text: String(d.selftext ?? '').slice(0, 1500),
      subreddit: String(d.subreddit ?? ''),
      url: `https://www.reddit.com${d.permalink}`,
      comments: Number(d.num_comments ?? 0),
      createdUtc: Number(d.created_utc),
    }));
}

function answeredThreads(): Set<string> {
  return new Set(listDrafts().map((d) => String((d.meta as any).thingId ?? '')).filter(Boolean));
}

const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['searches'],
  properties: {
    searches: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things a potential customer would type into Reddit search when they have the problem this business solves, in the language they would use.',
    },
  },
};

const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['threads'],
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'relevance', 'promo_risk', 'why'],
        properties: {
          id: { type: 'string' },
          relevance: { type: 'integer', minimum: 0, maximum: 10, description: 'How well we can genuinely help this person.' },
          promo_risk: { type: 'integer', minimum: 0, maximum: 10, description: 'How likely a reply from us reads as advertising here.' },
          why: { type: 'string' },
        },
      },
    },
  },
};

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['skip', 'skip_reason', 'reply', 'mentions_business', 'has_disclosure'],
  properties: {
    skip: { type: 'boolean', description: 'True when we have nothing genuinely useful to add, or the rules forbid it.' },
    skip_reason: { type: 'string' },
    reply: { type: 'string' },
    mentions_business: { type: 'boolean' },
    has_disclosure: { type: 'boolean', description: 'True if the reply says plainly that the writer works on the business.' },
  },
};

export const redditAgent: Agent = {
  id: 'reddit',
  label: 'Reddit',
  description: 'Finds Reddit threads where you can genuinely help and drafts helpful replies. You approve every one; a few a day at most.',
  async findOpportunities({ limit = 2, onProgress }) {
    onProgress?.('Working out what people search for on Reddit');
    const q = await askJson<{ searches: string[] }>({
      purpose: 'reddit:searches',
      model: MODELS.score,
      effort: 'low',
      system: agentSystem(REDDIT_ROLE, undefined, undefined, 'reddit'),
      schema: QUERY_SCHEMA,
      prompt: 'Give 5 short Reddit searches (2–5 words each).',
    });
    const answered = answeredThreads();
    const found = new Map<string, Thread>();
    for (const s of q.searches.slice(0, 6)) {
      onProgress?.(`Searching Reddit for "${s}"`);
      const r = await redditGet('/search', { q: s, sort: 'relevance', t: 'month', limit: '15', type: 'link' });
      for (const t of usableThreads(r?.data?.children ?? [], answered)) found.set(t.id, t);
    }
    if (!found.size) return [];
    onProgress?.(`Reading ${found.size} threads to see where we can help`);
    const list = [...found.values()].slice(0, 40);
    const scored = await askJson<{ threads: { id: string; relevance: number; promo_risk: number; why: string }[] }>({
      purpose: 'reddit:score',
      model: MODELS.score,
      effort: 'low',
      system: agentSystem(REDDIT_ROLE, undefined, undefined, 'reddit'),
      schema: SCORE_SCHEMA,
      prompt: `Score each thread.\n\n${list.map((t) => `<thread id="${t.id}" subreddit="r/${t.subreddit}" comments="${t.comments}">\n${t.title}\n${t.text}\n</thread>`).join('\n')}`,
    });
    return scored.threads
      .filter((s) => found.has(s.id) && s.relevance >= 7 && s.promo_risk <= 4)
      .sort((a, b) => b.relevance - a.relevance || a.promo_risk - b.promo_risk)
      .slice(0, limit)
      .map<Opportunity>((s) => {
        const t = found.get(s.id)!;
        return { title: t.title, reason: `r/${t.subreddit}: ${s.why}`, kind: 'reddit_reply', thread: t };
      });
  },
  async draft(opp) {
    const t = opp.thread as Thread;
    const short = t.id.replace(/^t3_/, '');
    const [post, rules] = await Promise.all([
      redditGet(`/comments/${short}`, { limit: '12', depth: '1', sort: 'top' }).catch(() => null),
      redditGet(`/r/${t.subreddit}/about/rules`, {}).catch(() => null),
    ]);
    const comments = (post?.[1]?.data?.children ?? []).map((c: any) => c?.data?.body).filter(Boolean).slice(0, 10);
    const ruleText = (rules?.rules ?? []).map((r: any) => `- ${r.short_name}: ${String(r.description ?? '').slice(0, 300)}`).join('\n');
    const out = await askJson<{ skip: boolean; skip_reason: string; reply: string; mentions_business: boolean; has_disclosure: boolean }>({
      purpose: 'reddit:draft',
      model: MODELS.draft,
      system: agentSystem(REDDIT_ROLE, undefined, undefined, 'reddit'),
      schema: REPLY_SCHEMA,
      prompt:
        `Write a reply to this thread in r/${t.subreddit}. Write in the language the thread is written in — this overrides the language rule above.\n\n` +
        `<thread>\n${t.title}\n\n${t.text}\n</thread>\n\n` +
        (comments.length ? `<existing-replies>\n${comments.map((c: string) => `- ${c.slice(0, 600)}`).join('\n')}\n</existing-replies>\nDon't repeat what is already said.\n\n` : '') +
        (ruleText ? `<subreddit-rules>\n${ruleText}\n</subreddit-rules>\n\n` : '') +
        `If you'd mention ${brandName()}, say you work on it.`,
    });
    if (out.skip || !out.reply.trim()) return null;
    let reply = out.reply.trim();
    // A mention without a disclosure is advertising in disguise: add one rather than trust the model.
    if (out.mentions_business && !out.has_disclosure) reply += `\n\n(Disclosure: I work on ${brandName()}.)`;
    return createDraft({
      agent: 'reddit',
      kind: 'reddit_reply',
      title: `Reply: ${t.title}`.slice(0, 200),
      body: reply,
      meta: {
        channel: 'reddit',
        thingId: t.id,
        threadUrl: t.url,
        subreddit: t.subreddit,
        threadTitle: t.title,
        reason: opp.reason,
        mentionsBusiness: out.mentions_business,
      },
    });
  },
};
