import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { MODELS } from '../config';
import { agentSystem, readDoc } from '../context/profile';
import { askJson } from '../llm/client';
import { createDraft, getDraft, listDrafts } from '../queue';
import { siteDir } from '../site';
import { siteUrl } from '../sites';
import { escapeHtml } from '../render';
import type { Agent, Opportunity } from '../agents/types';

/**
 * Short-video scripts (for Reels, TikTok, Shorts and LinkedIn video): a hook, scenes with what to film and the
 * words on screen, and a caption. A script can be turned into a simple preview video — the on-screen text as
 * slides in the brand's colours, in three sizes — to check pacing before anyone films. It is not AI footage.
 */

export interface Scene {
  seconds: number;
  shot: string; // what to film
  onScreen: string; // words shown on screen
  voiceover: string;
}

export interface Script {
  hook: string;
  scenes: Scene[];
  caption: string;
  hashtags: string[];
}

export const SIZES = {
  vertical: { w: 1080, h: 1920, label: '9:16 (Reels, TikTok, Shorts)' },
  square: { w: 1080, h: 1080, label: '1:1 (feed)' },
  wide: { w: 1920, h: 1080, label: '16:9 (YouTube, LinkedIn)' },
} as const;
export type SizeId = keyof typeof SIZES;

const ROLE = `You write short-form video scripts that hold attention: the first two seconds say why to keep watching,
every scene earns its place, and the words on screen are short enough to read in the time given (about 3 words per second).
Only things the business can actually film — no stock-footage fantasies, no claims the profile doesn't support.`;

const SCRIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'hook', 'scenes', 'caption', 'hashtags'],
  properties: {
    title: { type: 'string', description: 'A short label for the owner.' },
    hook: { type: 'string', description: 'The first line said or shown, under 10 words.' },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['seconds', 'shot', 'onScreen', 'voiceover'],
        properties: {
          seconds: { type: 'integer', minimum: 1, maximum: 15 },
          shot: { type: 'string', description: 'What to film, concretely.' },
          onScreen: { type: 'string', description: 'Words on screen, under 12 words.' },
          voiceover: { type: 'string' },
        },
      },
    },
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
};

/** The script as readable Markdown, so it can be edited like any draft. */
export function scriptToMarkdown(title: string, s: Script): string {
  const total = s.scenes.reduce((a, b) => a + b.seconds, 0);
  return [
    `# ${title}`,
    '',
    `**Hook:** ${s.hook}`,
    `**Length:** about ${total} seconds`,
    '',
    ...s.scenes.flatMap((sc, i) => [`## Scene ${i + 1} — ${sc.seconds}s`, `- **Film:** ${sc.shot}`, `- **On screen:** ${sc.onScreen}`, `- **Say:** ${sc.voiceover}`, '']),
    '## Caption',
    s.caption,
    '',
    s.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' '),
  ].join('\n');
}

/** Read the scenes back from the (possibly edited) Markdown, so the preview matches what the owner changed. */
export function scenesFromMarkdown(md: string): Scene[] {
  const parts = md.split(/^## Scene \d+[^\n]*$/m).slice(1);
  const heads = [...md.matchAll(/^## Scene \d+\s*[—-]\s*(\d+)s/gm)].map((m) => Number(m[1]));
  return parts.map((p, i) => {
    const field = (name: string) => (p.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`)) ?? [])[1]?.trim() ?? '';
    return { seconds: Math.min(15, Math.max(1, heads[i] || 3)), shot: field('Film'), onScreen: field('On screen'), voiceover: field('Say') };
  }).filter((s) => s.onScreen || s.voiceover);
}

export async function writeScript(idea: { angle: string; reason: string }) {
  const out = await askJson<Script & { title: string }>({
    purpose: 'video:script',
    model: MODELS.draft,
    maxTokens: 4000,
    system: agentSystem(ROLE, undefined, undefined, 'video'),
    schema: SCRIPT_SCHEMA,
    prompt: `Write a 20–45 second vertical video script. The idea: ${idea.angle}\nWhy: ${idea.reason}\nWrite in the language of the business's customers.`,
  });
  return createDraft({
    agent: 'video',
    kind: 'video_script',
    title: out.title,
    body: scriptToMarkdown(out.title, out),
    meta: { reason: idea.reason, hook: out.hook, seconds: out.scenes.reduce((a, b) => a + b.seconds, 0) },
  });
}

const IDEAS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ideas'],
  properties: {
    ideas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['angle', 'reason'], properties: { angle: { type: 'string' }, reason: { type: 'string' } } } },
  },
};

export const videoAgent: Agent = {
  id: 'video',
  label: 'Short videos',
  description: 'Writes short video scripts — hook, scenes, what to film, words on screen, caption — and makes a preview in three sizes.',
  async findOpportunities({ limit = 2, onProgress }) {
    onProgress?.('Choosing video ideas');
    const done = listDrafts({ agent: 'video' }).filter((d) => d.status !== 'rejected').map((d) => d.title);
    const r = await askJson<{ ideas: { angle: string; reason: string }[] }>({
      purpose: 'video:ideas',
      model: MODELS.draft,
      maxTokens: 2000,
      system: agentSystem(ROLE, undefined, undefined, 'video'),
      schema: IDEAS_SCHEMA,
      prompt: `Suggest ${limit} short video ideas the business can film itself, from the content plan.${done.length ? `\nAlready written:\n${done.map((t) => `- ${t}`).join('\n')}` : ''}`,
    });
    return r.ideas.slice(0, limit).map<Opportunity>((i) => ({ title: i.angle, reason: i.reason, kind: 'video_script' }));
  },
  draft: (opp) => writeScript({ angle: opp.title, reason: opp.reason }),
};

// ---------------------------------------------------------------- preview render

/** Brand colours from the Design guide's hex codes (first = background, second = accent); safe defaults otherwise. */
export function brandColours(design = readDoc('design') ?? ''): { bg: string; fg: string; accent: string } {
  const hex = [...new Set((design.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase()))];
  const lum = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const bg = hex.find((h) => lum(h) < 0.35) ?? '#1f2a26';
  const accent = hex.find((h) => h !== bg && lum(h) >= 0.35 && lum(h) < 0.9) ?? '#8fd1bd';
  return { bg, fg: '#ffffff', accent };
}

export function slideHtml(text: string, size: { w: number; h: number }, colours: { bg: string; fg: string; accent: string }, footer: string, index: number, total: number): string {
  const base = Math.round(Math.min(size.w, size.h) / 11);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${size.w}px;height:${size.h}px;background:${colours.bg};color:${colours.fg};font-family:-apple-system,"Helvetica Neue","Arial Unicode MS",Arial,sans-serif}
    .wrap{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;padding:${Math.round(base * 1.2)}px}
    .t{font-size:${base}px;font-weight:800;line-height:1.15;letter-spacing:-.01em;unicode-bidi:plaintext}
    .bar{height:${Math.round(base / 5)}px;width:${Math.round(base * 2)}px;background:${colours.accent};margin-bottom:${Math.round(base / 2)}px;border-radius:99px}
    .f{position:absolute;bottom:${Math.round(base * 0.8)}px;left:${Math.round(base * 1.2)}px;right:${Math.round(base * 1.2)}px;display:flex;justify-content:space-between;font-size:${Math.round(base / 2.6)}px;opacity:.75}
  </style></head><body><div class="wrap"><div class="bar"></div><div class="t" dir="auto">${escapeHtml(text)}</div></div>
  <div class="f"><span>${escapeHtml(footer)}</span><span>${index}/${total}</span></div></body></html>`;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => reject(new Error(e.message.includes('ENOENT') ? `${cmd} is not installed — install it (e.g. "brew install ffmpeg") to make previews` : e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.split('\n').filter(Boolean).slice(-2).join(' ')}`))));
  });
}

export function videoDir(draftId: number): string {
  return path.join(siteDir(), 'videos', String(draftId));
}

/** Draw each scene's on-screen text as an image, then join them into MP4s (one per size). Returns file names. */
export async function renderPreview(draftId: number, sizes: SizeId[] = ['vertical', 'square', 'wide']): Promise<string[]> {
  const d = getDraft(draftId);
  if (!d || d.kind !== 'video_script') throw new Error('that is not a video script');
  const scenes = scenesFromMarkdown(d.body);
  if (!scenes.length) throw new Error('the script has no scenes to show — each needs a "## Scene N — 3s" heading with an "On screen" line');
  const colours = brandColours();
  const site = siteUrl();
  const footer = site ? new URL(site).hostname.replace(/^www\./, '') : '';
  const dir = videoDir(draftId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const out: string[] = [];
  try {
    for (const id of sizes) {
      const size = SIZES[id];
      const page = await browser.newPage({ viewport: { width: size.w, height: size.h } });
      const list: string[] = [];
      for (const [i, s] of scenes.entries()) {
        await page.setContent(slideHtml(s.onScreen || s.voiceover, size, colours, footer, i + 1, scenes.length));
        const png = path.join(dir, `${id}-${i}.png`);
        await page.screenshot({ path: png });
        list.push(`file '${png.replace(/'/g, "'\\''")}'`, `duration ${s.seconds}`);
      }
      // The concat format needs the last image repeated for its duration to count.
      list.push(list[list.length - 2]);
      await page.close();
      const listFile = path.join(dir, `${id}.txt`);
      fs.writeFileSync(listFile, list.join('\n'));
      const mp4 = path.join(dir, `${id}.mp4`);
      // -t: the repeated last image would otherwise add its length again at the end.
      const total = scenes.reduce((a, b) => a + b.seconds, 0);
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-t', String(total), '-vf', `fps=30,format=yuv420p,scale=${size.w}:${size.h}`, '-c:v', 'libx264', '-movflags', '+faststart', mp4]);
      out.push(`${id}.mp4`);
    }
  } finally {
    await browser.close();
  }
  for (const f of fs.readdirSync(dir)) if (/\.(png|txt)$/.test(f)) fs.rmSync(path.join(dir, f));
  return out;
}

export function previews(draftId: number): { size: SizeId; label: string; file: string; at: string }[] {
  const dir = videoDir(draftId);
  return (Object.keys(SIZES) as SizeId[])
    .filter((s) => fs.existsSync(path.join(dir, `${s}.mp4`)))
    .map((s) => ({ size: s, label: SIZES[s].label, file: `${s}.mp4`, at: fs.statSync(path.join(dir, `${s}.mp4`)).mtime.toISOString() }));
}
