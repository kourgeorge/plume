import * as cheerio from 'cheerio';
import { MODELS } from '../config';
import { agentSystem } from '../context/profile';
import { listCompetitors } from '../context/extra';
import { askJson } from '../llm/client';
import { createDraft } from '../queue';
import { siteUrl } from '../sites';
import { fetchPage } from '../research/fetchPage';
import { brandNames, textMentions } from '../geo/visibility';
import type { Agent, Opportunity } from '../agents/types';
import { Contact, absUrl, addContact, cleanUrl, declinedEmails, getContact, listContacts, readyToDraft, updateContact } from './store';
import { findEmail, pageText, senderName } from './creators';

/**
 * Link building: pages that should link to the business but don't. A page counts only if Plume reads it and
 * sees, in code, either that it names the business without linking to it, or that it links to competitors
 * and not to the business. The AI suggests where to look; it never decides that a page qualifies.
 */

const bare = (h: string) => h.toLowerCase().replace(/^www\./, '');
const sameSite = (host: string, site: string) => bare(host) === bare(site) || bare(host).endsWith(`.${bare(site)}`);

export interface PageCheck {
  qualifies: boolean;
  opportunity: 'unlinked-mention' | 'lists-competitors' | null;
  mentionsUs: boolean;
  linksUs: boolean;
  competitorsLinked: string[];
  title: string;
  /** Why it doesn't qualify, in plain words. */
  reason: string;
}

/** Look at one page: does it name us, link to us, link to competitors? */
export function checkLinkPage(html: string, pageUrl: string, ours: string, competitors: { name: string; host: string }[], names: string[]): PageCheck {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  const pageHost = new URL(pageUrl).hostname;
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    try {
      links.push(new URL(String($(el).attr('href')), pageUrl).hostname);
    } catch {
      /* skip a broken link */
    }
  });
  $('nav, footer').remove();
  const text = pageText($);
  const linksUs = links.some((h) => sameSite(h, ours));
  const mentionsUs = textMentions(text, names);
  const competitorsLinked = competitors.filter((c) => links.some((h) => sameSite(h, c.host))).map((c) => c.name);
  const no = (reason: string): PageCheck => ({ qualifies: false, opportunity: null, mentionsUs, linksUs, competitorsLinked, title, reason });
  if (sameSite(pageHost, ours)) return no('it is your own site');
  if (competitors.some((c) => sameSite(pageHost, c.host))) return no("it is a competitor's site");
  if (linksUs) return no('it already links to you');
  if (mentionsUs) return { qualifies: true, opportunity: 'unlinked-mention', mentionsUs, linksUs, competitorsLinked, title, reason: '' };
  if (competitorsLinked.length) return { qualifies: true, opportunity: 'lists-competitors', mentionsUs, linksUs, competitorsLinked, title, reason: '' };
  return no('it neither names you nor links to your competitors');
}

const ROLE = `You build links for this business the honest way: you find pages whose readers would genuinely be helped
by a link to it, and you ask the person who runs the page politely, once. No link schemes, no paid links, no pressure.`;

const WHERE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pages'],
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'why'],
        properties: { url: { type: 'string', description: 'A page address that appears in the search results.' }, why: { type: 'string' } },
      },
    },
  },
};

const MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: { subject: { type: 'string' }, body: { type: 'string', description: 'Plain text, under 120 words.' } },
};

/** Ask the AI where to look, then check every page in code. Only qualifying pages are added. */
export async function discoverLinkPages(onProgress: (m: string) => void = () => {}, fetchFn: typeof fetch = fetch): Promise<{ added: Contact[]; checked: number; rejected: { url: string; reason: string }[] }> {
  const site = siteUrl();
  if (!site) throw new Error('this website has no address yet');
  const ours = new URL(site).hostname;
  const competitors = listCompetitors()
    .filter((c) => c.url)
    .map((c) => ({ name: c.name, host: new URL(c.url!).hostname }));
  const names = brandNames();
  onProgress('Looking for pages that list businesses like yours');
  const where = await askJson<{ pages: { url: string; why: string }[] }>({
    purpose: 'links:find',
    model: MODELS.research,
    effort: 'medium',
    webSearches: 6,
    maxTokens: 6000,
    system: agentSystem(ROLE, undefined, undefined, 'links'),
    schema: WHERE_SCHEMA,
    prompt:
      `Find up to 12 pages worth asking for a link: "best of" and comparison lists, resource and tools pages, directories for this field, ` +
      `and articles that name ${names[0]} or these competitors: ${competitors.map((c) => c.name).join(', ') || '(none listed)'}. ` +
      'Only pages, not social profiles. Use only addresses that appear in the search results.',
  });
  const known = new Set(listContacts('link').map((c) => c.url));
  const added: Contact[] = [];
  const rejected: { url: string; reason: string }[] = [];
  let checked = 0;
  for (const [i, p] of where.pages.entries()) {
    let url: string;
    let read: string;
    try {
      url = cleanUrl(p.url);
      read = absUrl(p.url);
    } catch {
      continue;
    }
    if (known.has(url)) continue;
    onProgress(`Reading ${new URL(url).hostname} (${i + 1} of ${where.pages.length})`);
    const r = await fetchPage(read, { fetchFn, browserFn: null });
    checked++;
    if (!r.ok) {
      rejected.push({ url, reason: r.reason });
      continue;
    }
    const c = checkLinkPage(r.html, r.url || read, ours, competitors, names);
    if (!c.qualifies) {
      rejected.push({ url, reason: c.reason });
      continue;
    }
    const email = await findEmail([read], fetchFn).catch(() => null);
    const why =
      c.opportunity === 'unlinked-mention'
        ? 'Mentions you but does not link to you.'
        : `Links to ${c.competitorsLinked.join(', ')} but not to you.`;
    const row = addContact({
      kind: 'link',
      name: c.title.slice(0, 120) || new URL(url).hostname,
      url,
      platform: new URL(url).hostname.replace(/^www\./, ''),
      email: email?.email,
      emailSource: email?.source,
      emailVerified: !!email,
      why: `${why} ${p.why}`.trim(),
      opportunity: c.opportunity!,
    });
    if (row) added.push(row);
  }
  return { added, checked, rejected };
}

export async function draftLinkRequest(contact: Contact) {
  const site = siteUrl() ?? '';
  const ask =
    contact.opportunity === 'unlinked-mention'
      ? 'They already mention the business; thank them and ask whether they would add a link so readers can find it.'
      : 'They list similar businesses; explain in one line what is different about this one and ask whether it would be useful to their readers.';
  const m = await askJson<{ subject: string; body: string }>({
    purpose: 'links:draft',
    model: MODELS.draft,
    maxTokens: 2000,
    system: agentSystem(ROLE, undefined, undefined, 'links'),
    schema: MESSAGE_SCHEMA,
    prompt: `Write a short email to whoever runs ${contact.url} ("${contact.name}"). ${ask} Our site: ${site}. One request, no follow-up threats, no flattery. Sign as ${senderName()}. Write in the language of their page.`,
  });
  const email = contact.emailVerified && !declinedEmails().has(contact.email) ? contact.email : '';
  const d = createDraft({
    agent: 'links',
    kind: email ? 'outreach_email' : 'outreach_message',
    title: `${new URL(contact.url).hostname}: ${m.subject}`.slice(0, 200),
    body: m.body.trim(),
    meta: {
      reason: contact.why,
      to: email || undefined,
      subject: m.subject,
      contactId: contact.id,
      contactUrl: contact.url,
      ...(email ? {} : { howToSend: `No public email found on the page — use the site's contact form: ${new URL(contact.url).origin}` }),
    },
  });
  updateContact(contact.id, { status: 'drafted' });
  return d;
}

export const linksAgent: Agent = {
  id: 'links',
  label: 'Links',
  description: 'Finds pages that mention you without a link, or list your competitors but not you, and drafts a polite request. Every page is checked, not guessed.',
  async findOpportunities({ limit = 3, onProgress }) {
    if (readyToDraft('link', limit).length < limit) await discoverLinkPages(onProgress);
    return readyToDraft('link', limit).map<Opportunity>((c) => ({ title: c.name, reason: c.why, kind: 'outreach', contactId: c.id }));
  },
  async draft(opp) {
    const c = getContact(Number(opp.contactId));
    return c ? draftLinkRequest(c) : null;
  },
};
