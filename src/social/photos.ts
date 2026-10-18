import fs from 'fs';
import path from 'path';
import { MODELS } from '../config';
import { agentSystem } from '../context/profile';
import { OwnTool, askJson, recordFlatCost } from '../llm/client';
import { checkBudget } from '../llm/budget';
import { getLlmConfig, providerOf } from '../llm/settings';
import { log } from '../log';
import { Draft, editDraft, getDraft } from '../queue';
import { MAX_IMAGE_BYTES, MAX_IMAGES, PostImage, addImage, imageDir, listImages, postVideo, sniffImage } from './images';

/**
 * Photos the agents choose for their own drafts: one found online that may be reused (Openverse always,
 * Pexels when the site has a key), or one made by an image model when one is set up. The photo is attached
 * to the draft like an upload, with who made it and under what licence, so the owner can keep or remove it.
 */

/** Drafts that get a photo suggested: social posts, and articles (as the picture at the top). */
export const ARTICLE_KINDS = ['article', 'blog_post', 'landing_page'];

export interface PhotoHit {
  id: string;
  /** What the photo shows, from its title, tags or alt text. The model can't see the photo itself. */
  about: string;
  width: number;
  height: number;
  license: string;
  credit: string;
  /** The page about the photo, for the credit. */
  page: string;
  /** The file to download. */
  file: string;
}

export interface PhotoCredit {
  name: string;
  how: 'found' | 'made';
  credit: string;
  license: string;
  page?: string;
  prompt?: string;
}

export const PHOTO_API = {
  openverse: 'https://api.openverse.org',
  pexels: 'https://api.pexels.com',
};

const UA = 'PlumeBot/0.1 (+local marketing assistant)';

/** Openverse: openly licensed photos (Creative Commons, public domain). Only licences that allow business use. */
async function openverse(query: string, orientation?: string): Promise<PhotoHit[]> {
  const q = new URLSearchParams({ q: query, license_type: 'commercial', category: 'photograph', page_size: '12', mature: 'false' });
  if (orientation === 'wide') q.set('aspect_ratio', 'wide');
  if (orientation === 'tall') q.set('aspect_ratio', 'tall');
  if (orientation === 'square') q.set('aspect_ratio', 'square');
  const res = await fetch(`${PHOTO_API.openverse}/v1/images/?${q}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Openverse said ${res.status}`);
  const data: any = await res.json();
  return (data.results ?? []).map((r: any) => ({
    id: `openverse:${r.id}`,
    about: [r.title, (r.tags ?? []).slice(0, 8).map((t: any) => t.name).join(', ')].filter(Boolean).join(' — '),
    width: Number(r.width ?? 0),
    height: Number(r.height ?? 0),
    license: `${String(r.license ?? '').toUpperCase()} ${r.license_version ?? ''}`.trim(),
    credit: r.attribution ?? `${r.title ?? 'Photo'} by ${r.creator ?? 'unknown'}`,
    page: r.foreign_landing_url ?? '',
    file: r.url,
  }));
}

/** Pexels: free stock photos, fine for business use, no credit required. Needs a free key. */
async function pexels(query: string, key: string, orientation?: string): Promise<PhotoHit[]> {
  const q = new URLSearchParams({ query, per_page: '12' });
  const o = { wide: 'landscape', tall: 'portrait', square: 'square' }[orientation ?? ''];
  if (o) q.set('orientation', o);
  const res = await fetch(`${PHOTO_API.pexels}/v1/search?${q}`, { headers: { authorization: key, 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401) throw new Error('Pexels refused the key (PEXELS_API_KEY)');
  if (!res.ok) throw new Error(`Pexels said ${res.status}`);
  const data: any = await res.json();
  return (data.photos ?? []).map((p: any) => ({
    id: `pexels:${p.id}`,
    about: p.alt || 'photo',
    width: Number(p.width ?? 0),
    height: Number(p.height ?? 0),
    license: 'Pexels licence (free to use)',
    credit: `Photo by ${p.photographer} on Pexels`,
    page: p.url ?? '',
    // "large2x" is about 1880 px wide: sharp in a post, well under 5 MB.
    file: p.src?.large2x ?? p.src?.large ?? p.src?.original,
  }));
}

/** Search every photo source this site can use. A source that fails is skipped, as long as another answers. */
export async function searchPhotos(query: string, orientation?: string, env = process.env): Promise<PhotoHit[]> {
  if (!query.trim()) throw new Error('say what to search for');
  const sources = [env.PEXELS_API_KEY ? pexels(query, env.PEXELS_API_KEY, orientation) : null, openverse(query, orientation)].filter(Boolean) as Promise<PhotoHit[]>[];
  const got = await Promise.allSettled(sources);
  const hits = got.flatMap((g) => (g.status === 'fulfilled' ? g.value : []));
  if (!hits.length) {
    const failed = got.find((g): g is PromiseRejectedResult => g.status === 'rejected');
    if (failed) throw failed.reason;
  }
  return hits.filter((h) => h.file && (allowLocal || /^https:\/\//.test(h.file)));
}

let allowLocal = false;
/** Tests serve photos from a local fake server. */
export function allowLocalPhotosForTests(): void {
  allowLocal = true;
}

/** Never let a model-chosen address reach this computer or the local network. */
function publicHttps(raw: string): URL {
  const u = new URL(raw);
  if (allowLocal) return u;
  if (u.protocol !== 'https:') throw new Error('only https photos can be downloaded');
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(u.hostname)) throw new Error('local addresses are not allowed');
  return u;
}

/** Download a photo into the draft's folder and attach it. Refuses anything that isn't a JPG, PNG or GIF under 5 MB. */
export async function attachFromUrl(draftId: number, url: string): Promise<PostImage> {
  const res = await fetch(publicHttps(url), { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw new Error(`the photo could not be downloaded (${res.status})`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw new Error('the photo is over 5 MB');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of res.body as any as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > MAX_IMAGE_BYTES) throw new Error('the photo is over 5 MB');
    chunks.push(Buffer.from(c));
  }
  return attachBytes(draftId, Buffer.concat(chunks));
}

function attachBytes(draftId: number, bytes: Buffer): PostImage {
  if (!sniffImage(bytes.subarray(0, 8))) throw new Error('that is not a JPG, PNG or GIF photo');
  fs.mkdirSync(imageDir(draftId), { recursive: true });
  const part = path.join(imageDir(draftId), `upload-${Date.now()}.part`);
  fs.writeFileSync(part, bytes);
  return addImage(draftId, part);
}

// ---------------------------------------------------------------- making a photo

export interface ImageService {
  url: string;
  key: string;
  model: string;
}

/**
 * Where images are made: IMAGE_API_URL / IMAGE_API_KEY / IMAGE_MODEL when set (any service that speaks
 * OpenAI's images API), else OpenAI with OPENAI_API_KEY, else the AI connection itself when it is OpenAI.
 */
export function imageService(env = process.env): ImageService | null {
  if (env.PLUME_IMAGES === 'off') return null;
  const model = env.IMAGE_MODEL || 'gpt-image-1';
  if (env.IMAGE_API_KEY) return { url: (env.IMAGE_API_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''), key: env.IMAGE_API_KEY, model };
  if (env.OPENAI_API_KEY) return { url: 'https://api.openai.com/v1', key: env.OPENAI_API_KEY, model };
  const cfg = getLlmConfig(env);
  if (providerOf(cfg).id === 'openai' && cfg.apiKey) return { url: 'https://api.openai.com/v1', key: cfg.apiKey, model };
  return null;
}

/** What one made image costs, roughly, for the budget: medium quality at gpt-image-1 prices. */
export const IMAGE_COST_USD = 0.07;

const SIZES = { square: '1024x1024', wide: '1536x1024', tall: '1024x1536' } as const;

export async function makeImage(prompt: string, shape: keyof typeof SIZES = 'square', svc = imageService()): Promise<Buffer> {
  if (!svc) throw new Error('no image service is set up (add OPENAI_API_KEY, or IMAGE_API_KEY and IMAGE_API_URL, to .env)');
  checkBudget('photo:make');
  const gpt = /^gpt-image/i.test(svc.model);
  const res = await fetch(`${svc.url}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${svc.key}` },
    body: JSON.stringify({
      model: svc.model,
      prompt,
      n: 1,
      size: gpt ? SIZES[shape] : '1024x1024',
      // JPEG keeps it well under the 5 MB the social networks take.
      ...(gpt ? { quality: 'medium', output_format: 'jpeg' } : { response_format: 'b64_json' }),
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`the image service said ${res.status}: ${String(data?.error?.message ?? res.statusText).slice(0, 200)}`);
  recordFlatCost('photo:make', svc.model, IMAGE_COST_USD);
  const item = data?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) {
    const r = await fetch(publicHttps(item.url), { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`the made image could not be downloaded (${r.status})`);
    return Buffer.from(await r.arrayBuffer());
  }
  throw new Error('the image service sent no image');
}

// ---------------------------------------------------------------- the agent's choice

const PHOTO_ROLE = `You are the photo editor. You pick the one picture that makes a post or article worth stopping for:
it shows something concrete from the text (a place, an object, a person at work), not a generic "business people
shaking hands" stock shot. No pictures with text in them, no logos or brands that aren't ours, no recognisable
famous people. When nothing found fits well, a made picture is better than a poor match — if making is allowed.
When the text works better without a picture, say so.`;

const CHOICE_SCHEMA = (canMake: boolean) => ({
  type: 'object',
  additionalProperties: false,
  required: ['choice', 'photo_id', 'image_prompt', 'shape', 'why'],
  properties: {
    choice: { type: 'string', enum: canMake ? ['found', 'make', 'none'] : ['found', 'none'] },
    photo_id: { type: 'string', description: 'For "found": the id from search_photos. Otherwise empty.' },
    image_prompt: {
      type: 'string',
      description: canMake ? 'For "make": a detailed description of the picture to make — subject, setting, light, style (a natural photo unless an illustration fits better). No text in the picture. Otherwise empty.' : 'Always empty.',
    },
    shape: { type: 'string', enum: ['square', 'wide', 'tall'] },
    why: { type: 'string', description: 'One sentence for the owner: why this picture.' },
  },
});

const SEARCH_TOOL = (seen: Map<string, PhotoHit>): OwnTool => ({
  def: {
    name: 'search_photos',
    description: 'Search for photos that may be used in business posts (free stock and openly licensed photos). Returns ids and what each photo shows. Search with 1–4 plain words, in English.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string' },
        orientation: { type: 'string', enum: ['wide', 'tall', 'square'] },
      },
    },
  },
  async run(input) {
    const hits = await searchPhotos(String(input?.query ?? ''), input?.orientation);
    for (const h of hits) seen.set(h.id, h);
    if (!hits.length) return 'No photos found. Try other, simpler words.';
    return JSON.stringify(hits.map((h) => ({ id: h.id, shows: h.about.slice(0, 200), size: `${h.width}x${h.height}`, license: h.license })));
  },
});

export interface PhotoResult {
  attached: PostImage | null;
  /** Plain words for the owner: what was chosen, or why nothing was. */
  note: string;
}

/**
 * Let the photo editor pick a picture for a draft and attach it. Never throws for "no photo": a draft without
 * a picture is still a draft, so problems come back as a note instead.
 */
export async function suggestPhoto(draftId: number, opts: { canMake?: boolean } = {}): Promise<PhotoResult> {
  const d = getDraft(draftId);
  if (!d) throw new Error('no such draft');
  if (postVideo(d.id)) return { attached: null, note: 'This post has a video, so no photo was added.' };
  if (listImages(d.id).length >= (ARTICLE_KINDS.includes(d.kind) ? 1 : MAX_IMAGES)) return { attached: null, note: 'This draft already has its photos.' };
  const svc = opts.canMake === false ? null : imageService();
  const seen = new Map<string, PhotoHit>();
  const article = ARTICLE_KINDS.includes(d.kind);
  const choice = await askJson<{ choice: 'found' | 'make' | 'none'; photo_id: string; image_prompt: string; shape: 'square' | 'wide' | 'tall'; why: string }>({
    purpose: 'photo:pick',
    model: MODELS.draft,
    effort: 'low',
    maxTokens: 4000,
    system: agentSystem(PHOTO_ROLE),
    schema: CHOICE_SCHEMA(!!svc),
    tools: [SEARCH_TOOL(seen)],
    prompt:
      `Pick one picture for this ${article ? 'article (it goes at the top)' : `${channelOf(d)} post`}. ` +
      `Search first; ${svc ? 'if nothing fits, describe one to make.' : 'making a picture is not available here.'} ` +
      `${article ? 'Articles want a wide picture.' : d.kind === 'linkedin_post' || d.kind === 'facebook_post' ? 'Wide or square works best here.' : ''}\n\n` +
      `<draft title="${d.title.replace(/"/g, "'")}">\n${d.body.slice(0, 6000)}\n</draft>`,
  });
  try {
    if (choice.choice === 'found') {
      const hit = seen.get(choice.photo_id);
      if (!hit) return { attached: null, note: 'The photo editor picked a photo that was not in the search results, so none was added.' };
      const img = await attachFromUrl(d.id, hit.file);
      remember(d, { name: img.name, how: 'found', credit: hit.credit, license: hit.license, page: hit.page }, choice.why);
      return { attached: img, note: `Added a photo: ${hit.credit} (${hit.license}). ${choice.why}` };
    }
    if (choice.choice === 'make' && svc && choice.image_prompt.trim()) {
      const img = attachBytes(d.id, await makeImage(choice.image_prompt, choice.shape, svc));
      remember(d, { name: img.name, how: 'made', credit: `Made with ${svc.model}`, license: 'made for you', prompt: choice.image_prompt }, choice.why);
      return { attached: img, note: `Made a picture for it. ${choice.why}` };
    }
    return { attached: null, note: choice.why || 'No picture suits this one.' };
  } catch (err) {
    const msg = String((err as any)?.message ?? err);
    log('warn', 'photos', `draft ${d.id}: ${msg}`);
    return { attached: null, note: `No photo added: ${msg}.` };
  }
}

const channelOf = (d: Draft) => (d.kind.startsWith('x_') ? 'X' : d.kind.startsWith('linkedin') ? 'LinkedIn' : d.kind.startsWith('facebook') ? 'Facebook' : 'social');

/** Keep the credit with the draft: openly licensed photos must name who took them when they are used. */
function remember(d: Draft, credit: PhotoCredit, why: string): void {
  editDraft(d.id, { meta: { photoCredits: [...photoCredits(d.id).filter((c) => c.name !== credit.name), credit], photoNote: why } });
}

/** Credits for the photos still on the draft. A removed photo's credit goes with it; an uploaded one has none. */
export function photoCredits(draftId: number): PhotoCredit[] {
  const have = new Set(listImages(draftId).map((i) => i.name));
  return ((getDraft(draftId)?.meta.photoCredits as PhotoCredit[] | undefined) ?? []).filter((c) => have.has(c.name));
}

/** Turned off with PLUME_AGENT_PHOTOS=0, e.g. to save on calls. */
export const agentPhotosOn = (env = process.env) => env.PLUME_AGENT_PHOTOS !== '0';
