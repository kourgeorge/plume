import * as cheerio from 'cheerio';
import { getDb } from '../db';
import { brandProfiles, listPeople } from '../context/extra';
import { getSite, siteUrl } from '../sites';
import { currentSite } from '../site';
import { AI_CRAWLERS } from '../research/aiCrawlers';
import { fetchPage } from '../research/fetchPage';
import { MODELS } from '../config';
import { ask } from '../llm/client';

/**
 * Free tools & growth utilities: meta tag checker, robots.txt, sitemap, UTM links, structured data, and AI humanizer.
 * Each one builds or checks something the owner then copies to their site or uses in their workflow.
 */

// ---------------------------------------------------------------- meta tag checker

export interface MetaCheck {
  url: string;
  status: number | null;
  title: string;
  description: string;
  canonical: string;
  robots: string;
  lang: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  problems: string[];
  good: string[];
}

/** Read one page's head the way search engines and link previews do, and say what's missing. */
export function checkMeta(html: string, url: string, status: number | null = 200): MetaCheck {
  const $ = cheerio.load(html);
  const meta = (sel: string) => ($(sel).first().attr('content') ?? '').trim();
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  $('meta[property^="og:"]').each((_, el) => void (og[String($(el).attr('property')).slice(3)] ||= String($(el).attr('content') ?? '').trim()));
  $('meta[name^="twitter:"]').each((_, el) => void (twitter[String($(el).attr('name')).slice(8)] ||= String($(el).attr('content') ?? '').trim()));
  const r: MetaCheck = {
    url,
    status,
    title: $('head title').first().text().trim() || $('title').first().text().trim(),
    description: meta('meta[name="description"]'),
    canonical: ($('link[rel="canonical"]').first().attr('href') ?? '').trim(),
    robots: meta('meta[name="robots"]'),
    lang: ($('html').attr('lang') ?? '').trim(),
    og,
    twitter,
    problems: [],
    good: [],
  };
  const p = r.problems;
  const g = r.good;
  if (status && status >= 400) p.push(`The page answered ${status}, so search engines won't show it.`);
  if (!r.title) p.push('No title. Search results will make one up.');
  else if (r.title.length > 60) p.push(`The title is ${r.title.length} characters; Google cuts it at about 60.`);
  else if (r.title.length < 15) p.push(`The title is only ${r.title.length} characters — say what the page is about.`);
  else g.push(`Title is ${r.title.length} characters.`);
  if (!r.description) p.push('No meta description. Google will pick some text from the page instead.');
  else if (r.description.length > 160) p.push(`The description is ${r.description.length} characters; Google cuts it at about 155.`);
  else if (r.description.length < 70) p.push(`The description is only ${r.description.length} characters — use the space to say why to click.`);
  else g.push(`Description is ${r.description.length} characters.`);
  if (/noindex/i.test(r.robots)) p.push('This page tells search engines not to list it (noindex).');
  if (!r.canonical) p.push('No canonical link. If the page is reachable at several addresses, Google may split its ranking between them.');
  else {
    try {
      const c = new URL(r.canonical, url);
      if (c.origin !== new URL(url).origin) p.push(`The canonical link points to another site (${c.origin}).`);
      else g.push('Has a canonical link.');
    } catch {
      p.push(`The canonical link "${r.canonical}" isn't a valid address.`);
    }
  }
  if (!r.lang) p.push('The page does not say what language it is in (<html lang="…">).');
  const missingOg = ['title', 'description', 'image'].filter((k) => !og[k]);
  if (missingOg.length) p.push(`Shared links (WhatsApp, LinkedIn, Facebook) lack og:${missingOg.join(', og:')} — previews will look bare.`);
  else g.push('Has a share preview (title, description, image).');
  if (!twitter.card) p.push('No twitter:card — links shared on X show as plain text.');
  return r;
}

export async function checkMetaUrl(raw: string, fetchFn: typeof fetch = fetch): Promise<MetaCheck> {
  const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`).toString();
  const r = await fetchPage(url, { fetchFn, browserFn: null });
  if (!r.ok) throw new Error(`Couldn't read ${url}: ${r.reason}`);
  return checkMeta(r.html, r.url || url, r.status);
}

// ---------------------------------------------------------------- robots.txt

export interface RobotsOptions {
  /** search: let AI answer engines read the site (recommended); training: also allow model-training crawlers. */
  aiSearch: boolean;
  aiTraining: boolean;
  /** Paths no crawler should read, e.g. /admin, /cart. */
  disallow: string[];
  sitemap: string;
}

export function buildRobots(o: RobotsOptions): string {
  const paths = [...new Set(o.disallow.map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith('/') ? p : `/${p}`)))];
  const lines = ['# Built with Plume', 'User-agent: *', ...(paths.length ? paths.map((p) => `Disallow: ${p}`) : ['Allow: /']), ''];
  const blocked = AI_CRAWLERS.filter((c) => (c.kind === 'search' ? !o.aiSearch : !o.aiTraining));
  if (blocked.length) {
    lines.push(`# AI crawlers you chose to keep out`);
    for (const c of blocked) lines.push(`User-agent: ${c.agent}`);
    lines.push('Disallow: /', '');
  }
  if (o.sitemap.trim()) lines.push(`Sitemap: ${o.sitemap.trim()}`);
  return lines.join('\n').trim() + '\n';
}

// ---------------------------------------------------------------- sitemap

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

/** The pages Plume read on this site that are worth listing: answered 200, not noindex, canonical to themselves. */
export function sitemapPages(): { url: string; lastmod: string | null }[] {
  const rows = getDb().prepare('SELECT url, status, canonical, page_date, crawled_at FROM pages ORDER BY url').all() as { url: string; status: number | null; canonical: string | null; page_date: string | null; crawled_at: string | null }[];
  return rows
    .filter((r) => r.status === 200)
    .filter((r) => {
      if (!r.canonical) return true;
      try {
        return new URL(r.canonical, r.url).toString().replace(/\/$/, '') === r.url.replace(/\/$/, '');
      } catch {
        return true;
      }
    })
    .map((r) => ({ url: r.url, lastmod: r.page_date ? r.page_date.slice(0, 10) : null }));
}

export function buildSitemap(pages: { url: string; lastmod: string | null }[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map((p) => `  <url><loc>${xmlEsc(p.url)}</loc>${p.lastmod ? `<lastmod>${p.lastmod}</lastmod>` : ''}</url>`),
    '</urlset>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- UTM links

export interface UtmInput {
  url: string;
  source: string;
  medium: string;
  campaign: string;
  term?: string;
  content?: string;
}

/** Campaign tracking link. Values are lower-cased and spaces become dashes, so reports don't split "Email" and "email". */
export function buildUtm(i: UtmInput): string {
  const u = new URL(/^https?:\/\//i.test(i.url.trim()) ? i.url.trim() : `https://${i.url.trim()}`);
  const clean = (s?: string) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  for (const k of ['source', 'medium', 'campaign'] as const) if (!clean(i[k])) throw new Error(`utm_${k} is needed`);
  for (const [k, v] of Object.entries({ source: i.source, medium: i.medium, campaign: i.campaign, term: i.term, content: i.content })) {
    if (clean(v)) u.searchParams.set(`utm_${k}`, clean(v));
    else u.searchParams.delete(`utm_${k}`);
  }
  return u.toString();
}

// ---------------------------------------------------------------- structured data

export type SchemaKind = 'organization' | 'faq' | 'article';

export interface SchemaInput {
  kind: SchemaKind;
  name?: string;
  url?: string;
  logo?: string;
  description?: string;
  sameAs?: string[];
  faq?: { q: string; a: string }[];
  headline?: string;
  author?: string;
  datePublished?: string;
  image?: string;
}

/** JSON-LD to paste into the page's <head> as a <script type="application/ld+json"> block. Empty fields are left out. */
export function buildSchema(i: SchemaInput): string {
  const drop = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
  let data: Record<string, unknown>;
  if (i.kind === 'organization') {
    if (!i.name?.trim()) throw new Error('the business name is needed');
    data = drop({ '@context': 'https://schema.org', '@type': 'Organization', name: i.name.trim(), url: i.url, logo: i.logo, description: i.description, sameAs: (i.sameAs ?? []).map((s) => s.trim()).filter(Boolean) });
  } else if (i.kind === 'faq') {
    const qa = (i.faq ?? []).filter((x) => x.q?.trim() && x.a?.trim());
    if (!qa.length) throw new Error('add at least one question with an answer');
    data = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q.trim(), acceptedAnswer: { '@type': 'Answer', text: x.a.trim() } })) };
  } else {
    if (!i.headline?.trim()) throw new Error('the headline is needed');
    if (i.datePublished && isNaN(Date.parse(i.datePublished))) throw new Error(`"${i.datePublished}" isn't a date`);
    data = drop({
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: i.headline.trim().slice(0, 110),
      image: i.image,
      datePublished: i.datePublished,
      author: i.author ? { '@type': 'Person', name: i.author } : undefined,
      publisher: i.name ? drop({ '@type': 'Organization', name: i.name, logo: i.logo ? { '@type': 'ImageObject', url: i.logo } : undefined }) : undefined,
    });
  }
  // "</" inside a script block would end it early; JSON allows the escaped form.
  return `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/<\//g, '<\\/')}\n</script>\n`;
}

// ---------------------------------------------------------------- AI Humanizer

export const AI_CLICHES = [
  'delve', 'delving', 'testament', 'tapestry', 'in conclusion', 'moreover', 'furthermore',
  'realm', 'crucial', 'beacon', 'game-changer', 'dive in', 'dive into', 'unwavering',
  'pivotal', "in today's fast-paced world", "in today's digital landscape", "in today's world",
  "it's important to remember", "it is crucial to", "let's explore", "seamlessly",
  'elevate', 'foster', 'fostering', 'harness the power', 'harnessing the power',
  'unlock the potential', 'unlocking the potential', 'embark on', 'a testament to',
  'realm of', 'symphony', 'plethora', 'crucible', 'nestled', 'at the forefront',
  'groundbreaking', 'revolutionize', 'paramount', 'bustling', 'vibrant', 'ever-evolving',
];

export interface AiMarkerAnalysis {
  clichesFound: string[];
  clicheCount: number;
  wordCount: number;
  sentenceCount: number;
  avgSentenceLength: number;
  sentenceStdDev: number;
  /** Estimated likelihood (0–100) that the text exhibits synthetic / AI characteristics. */
  score: number;
}

export function analyzeAiMarkers(text: string): AiMarkerAnalysis {
  const raw = text.trim();
  if (!raw) {
    return { clichesFound: [], clicheCount: 0, wordCount: 0, sentenceCount: 0, avgSentenceLength: 0, sentenceStdDev: 0, score: 0 };
  }
  const lower = raw.toLowerCase();
  const clichesFound = AI_CLICHES.filter((c) => {
    const esc = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`, 'i').test(lower);
  });

  const words = raw.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  const sentences = raw.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const sentenceCount = Math.max(1, sentences.length);
  const sentenceLengths = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  const avgSentenceLength = wordCount / sentenceCount;

  const variance = sentenceLengths.reduce((acc, len) => acc + Math.pow(len - avgSentenceLength, 2), 0) / sentenceCount;
  const sentenceStdDev = Math.sqrt(variance);

  // Heuristic calculation:
  // 1. Cliché density: each cliché adds significant synthetic weight
  const clicheWeight = Math.min(50, (clichesFound.length / Math.max(1, wordCount / 50)) * 25);
  // 2. Uniformity penalty: low standard deviation of sentence lengths indicates robotic cadence
  let uniformityScore = 0;
  if (sentenceCount > 2) {
    if (sentenceStdDev < 3) uniformityScore = 30;
    else if (sentenceStdDev < 5) uniformityScore = 20;
    else if (sentenceStdDev < 7) uniformityScore = 10;
  }
  // 3. Average sentence length penalty: AI often generates 18-28 word balanced sentences
  let cadenceScore = 0;
  if (avgSentenceLength >= 18 && avgSentenceLength <= 26) cadenceScore = 15;

  const rawScore = Math.min(100, Math.round(clicheWeight + uniformityScore + cadenceScore));
  const score = wordCount < 10 ? Math.min(rawScore, 30) : rawScore;

  return {
    clichesFound,
    clicheCount: clichesFound.length,
    wordCount,
    sentenceCount,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    sentenceStdDev: Math.round(sentenceStdDev * 10) / 10,
    score,
  };
}

export type HumanizeTone = 'natural' | 'conversational' | 'professional' | 'casual';
export type HumanizeLevel = 'mild' | 'moderate' | 'aggressive';

export interface HumanizeInput {
  text: string;
  tone?: HumanizeTone;
  level?: HumanizeLevel;
}

export interface HumanizeResult {
  original: string;
  humanized: string;
  scoreBefore: number;
  scoreAfter: number;
  clichesFound: string[];
  stats: {
    wordsBefore: number;
    wordsAfter: number;
    sentencesBefore: number;
    sentencesAfter: number;
    readingTimeSec: number;
  };
}

export async function humanizeText(input: HumanizeInput): Promise<HumanizeResult> {
  const text = (input.text ?? '').trim();
  if (!text) throw new Error('please enter some text to humanize');
  if (text.length > 20000) throw new Error('text is too long (keep under 20,000 characters)');

  const beforeAnalysis = analyzeAiMarkers(text);
  const tone = input.tone ?? 'natural';
  const level = input.level ?? 'moderate';

  const toneInstructions: Record<HumanizeTone, string> = {
    natural: 'Natural, balanced, and direct. Sounds like a thoughtful human writer communicating clearly.',
    conversational: 'Warm, personable, and approachable. Uses conversational flow, contractions, and natural transitions.',
    professional: 'Sharp, executive, and credible. Uses active voice and precise industry vocabulary without corporate jargon.',
    casual: 'Relaxed, friendly, and authentic. Uses conversational phrasing, lively rhythm, and approachable idioms.',
  };

  const levelInstructions: Record<HumanizeLevel, string> = {
    mild: 'Light touch: Remove AI clichés, smoothen transitions, and keep the existing structure mostly intact.',
    moderate: 'Standard rewrite: Eliminate all synthetic markers, vary sentence lengths (mix punchy short sentences with natural longer ones), and replace formulaic vocabulary.',
    aggressive: 'Deep humanization: Restructure sentences and paragraphs freely, inject varied cadence, authentic idiom, and organic rhythm to sound unmistakably human.',
  };

  const prompt = `You are a master human editor. Rewrite the following text to make it sound completely authentic, dynamic, and written by a real human, eliminating all synthetic AI markers and predictable patterns.

Tone: ${toneInstructions[tone]}
Intensity: ${levelInstructions[level]}

Specific Rules:
1. Eliminate all AI clichés and buzzwords (e.g. delve, testament, tapestry, in conclusion, furthermore, moreover, crucial, beacon, game-changer, pivotal, in today's fast-paced world, seamlessly, elevate, foster).
2. Create dynamic burstiness: combine very short punchy statements with rhythmic compound sentences. Avoid monotonous sentence lengths.
3. Use active voice and concrete verbs instead of passive, abstract phrasing.
4. Preserve all original facts, data points, core message, and meaning accurately.
5. Return ONLY the humanized text with no conversational intro, commentary, or quotes.

--- TEXT TO HUMANIZE ---
${text}`;

  const res = await ask({
    purpose: 'tools:humanizer',
    model: MODELS.draft,
    maxTokens: Math.max(1500, Math.ceil(text.length / 2)),
    system: 'You are an expert human copy editor who specializes in rewriting robotic AI text into lively, natural, human prose.',
    prompt,
  });

  const humanized = res.text.trim();
  const afterAnalysis = analyzeAiMarkers(humanized);
  const readingTimeSec = Math.max(1, Math.round((afterAnalysis.wordCount / 200) * 60));

  return {
    original: text,
    humanized,
    scoreBefore: beforeAnalysis.score,
    scoreAfter: afterAnalysis.score,
    clichesFound: beforeAnalysis.clichesFound,
    stats: {
      wordsBefore: beforeAnalysis.wordCount,
      wordsAfter: afterAnalysis.wordCount,
      sentencesBefore: beforeAnalysis.sentenceCount,
      sentencesAfter: afterAnalysis.sentenceCount,
      readingTimeSec,
    },
  };
}

// ---------------------------------------------------------------- what the page starts with

export function toolDefaults() {
  const site = siteUrl() ?? '';
  const b = brandProfiles();
  const sameAs = [b.x ? `https://x.com/${b.x}` : '', b.linkedin ?? '', b.facebook ?? ''].filter(Boolean);
  const pages = sitemapPages();
  return {
    site,
    name: getSite(currentSite())?.name ?? currentSite(),
    author: listPeople()[0]?.name ?? '',
    sameAs,
    sitemapUrl: site ? `${site.replace(/\/$/, '')}/sitemap.xml` : '',
    sitemapPages: pages.length,
    aiCrawlers: AI_CRAWLERS.map((c) => ({ agent: c.agent, owner: c.owner, kind: c.kind, what: c.what })),
  };
}
