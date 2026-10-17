import { marked, Token, Tokens } from 'marked';
import type { Publisher } from './index';

/**
 * Wix Blog (REST, API key). Wix doesn't take HTML: post bodies are "Ricos" documents, so the Markdown is
 * converted here — headings, paragraphs, lists, quotes, code, bold/italic/links. Images and tables are
 * left out (Wix needs images uploaded to its media library first); their text is kept.
 * Posts are created as drafts unless WIX_LIVE=1. An API key acts as the site, not a person, so Wix needs
 * the member who will be shown as the author (WIX_MEMBER_ID).
 */

export const WIX_API = { base: (process.env.WIX_API_URL || 'https://www.wixapis.com').replace(/\/$/, '') };

type Decoration = { type: 'BOLD'; fontWeightValue: number } | { type: 'ITALIC'; italicData: boolean } | { type: 'LINK'; linkData: { link: { url: string; target: 'BLANK' } } };
interface RicosNode {
  type: string;
  id: string;
  nodes: RicosNode[];
  [data: string]: unknown;
}

let seq = 0;
const nid = () => `p${(++seq).toString(36)}`;
const text = (t: string, decorations: Decoration[] = []): RicosNode => ({ type: 'TEXT', id: '', nodes: [], textData: { text: t, decorations } });

/** Inline Markdown (bold, italic, links, code) → TEXT nodes with decorations. */
function inline(tokens: Token[] | undefined, deco: Decoration[] = []): RicosNode[] {
  const out: RicosNode[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case 'strong':
        out.push(...inline((t as Tokens.Strong).tokens, [...deco, { type: 'BOLD', fontWeightValue: 700 }]));
        break;
      case 'em':
        out.push(...inline((t as Tokens.Em).tokens, [...deco, { type: 'ITALIC', italicData: true }]));
        break;
      case 'link': {
        const l = t as Tokens.Link;
        // Only real web links; anything else (javascript:, relative paths Wix can't resolve) stays plain text.
        const ok = /^https?:\/\//i.test(l.href);
        out.push(...inline(l.tokens, ok ? [...deco, { type: 'LINK', linkData: { link: { url: l.href, target: 'BLANK' } } }] : deco));
        break;
      }
      case 'image':
        if ((t as Tokens.Image).text) out.push(text((t as Tokens.Image).text, deco));
        break;
      case 'br':
        out.push(text('\n', deco));
        break;
      case 'text':
        if ((t as Tokens.Text).tokens) out.push(...inline((t as Tokens.Text).tokens, deco));
        else out.push(text(unescape((t as Tokens.Text).text), deco));
        break;
      case 'codespan':
        out.push(text(unescape((t as Tokens.Codespan).text), deco));
        break;
      default:
        if ('text' in t && typeof t.text === 'string') out.push(text(unescape(t.text), deco));
    }
  }
  return out;
}

/** marked HTML-escapes inline text; Ricos wants it raw. */
function unescape(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e as string]!);
}

const para = (nodes: RicosNode[]): RicosNode => ({ type: 'PARAGRAPH', id: nid(), nodes, paragraphData: {} });

function blocks(tokens: Token[]): RicosNode[] {
  const out: RicosNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        out.push({ type: 'HEADING', id: nid(), nodes: inline(h.tokens), headingData: { level: Math.min(6, Math.max(2, h.depth)) } });
        break;
      }
      case 'paragraph':
        out.push(para(inline((t as Tokens.Paragraph).tokens)));
        break;
      case 'list': {
        const l = t as Tokens.List;
        out.push({
          type: l.ordered ? 'ORDERED_LIST' : 'BULLETED_LIST',
          id: nid(),
          [l.ordered ? 'orderedListData' : 'bulletedListData']: { indentation: 0 },
          nodes: l.items.map((item) => ({
            type: 'LIST_ITEM',
            id: nid(),
            // A list item holds paragraphs (and maybe a nested list); loose text becomes one paragraph.
            nodes: item.tokens.some((x) => x.type === 'paragraph' || x.type === 'list') ? blocks(item.tokens) : [para(inline(item.tokens))],
          })),
        });
        break;
      }
      case 'blockquote':
        out.push({ type: 'BLOCKQUOTE', id: nid(), nodes: blocks((t as Tokens.Blockquote).tokens).filter((n) => n.type === 'PARAGRAPH'), blockquoteData: { indentation: 1 } });
        break;
      case 'code':
        out.push({ type: 'CODE_BLOCK', id: nid(), nodes: [text((t as Tokens.Code).text)], codeBlockData: { textStyle: { textAlignment: 'AUTO' } } });
        break;
      case 'hr':
        out.push({ type: 'DIVIDER', id: nid(), nodes: [], dividerData: { lineStyle: 'SINGLE', width: 'LARGE', alignment: 'CENTER' } });
        break;
      case 'table': {
        // Kept as plain rows rather than dropped: a Wix table needs a fixed layout this can't guess.
        const tb = t as Tokens.Table;
        for (const row of [tb.header, ...tb.rows]) out.push(para(row.flatMap((c, i) => [...(i ? [text(' · ')] : []), ...inline(c.tokens)])));
        break;
      }
      case 'html':
      case 'space':
        break;
      default:
        if ('text' in t && typeof t.text === 'string' && t.text.trim()) out.push(para([text(unescape(t.text))]));
    }
  }
  return out;
}

/** Markdown → a Ricos document Wix's blog accepts. */
export function toRicos(markdown: string): { nodes: RicosNode[] } {
  seq = 0;
  return { nodes: blocks(marked.lexer(markdown)) };
}

/** Drop a leading "# Title" line: Wix shows the title itself. (Same as index.ts; not imported, as index.ts imports this file.) */
const stripTitle = (md: string) => md.replace(/^\s*#\s+[^\n]*\n+/, '');

const wixHeaders = (env: NodeJS.ProcessEnv) => ({ authorization: String(env.WIX_API_KEY), 'wix-site-id': String(env.WIX_SITE_ID), 'content-type': 'application/json' });

async function wixCall(env: NodeJS.ProcessEnv, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${WIX_API.base}${path}`, { method: 'POST', headers: wixHeaders(env), body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data.message ?? data.details?.applicationError?.description ?? res.statusText;
    if (res.status === 401 || res.status === 403) throw new Error(`Wix refused the key (${res.status}): ${why}. Check the API key, the site ID, and that the key has the Wix Blog and Members permissions for this site.`);
    throw new Error(`Wix said ${res.status}: ${why}`);
  }
  return data;
}

export const wix: Publisher = {
  id: 'wix',
  label: 'Wix',
  needs: ['WIX_API_KEY', 'WIX_SITE_ID', 'WIX_MEMBER_ID'],
  configured: (env = process.env) => !!(env.WIX_API_KEY && env.WIX_SITE_ID && env.WIX_MEMBER_ID),
  async publish(draft, _html, env = process.env) {
    const live = env.WIX_LIVE === '1';
    const m = draft.meta;
    const data = await wixCall(env, '/blog/v3/draft-posts', {
      draftPost: {
        title: draft.title.slice(0, 200),
        memberId: env.WIX_MEMBER_ID,
        richContent: toRicos(stripTitle(draft.body)),
        ...(m.slug ? { seoSlug: String(m.slug).slice(0, 100) } : {}),
        ...(m.metaDescription
          ? { excerpt: String(m.metaDescription).slice(0, 500), seoData: { tags: [{ type: 'meta', props: { name: 'description', content: String(m.metaDescription) }, children: '' }] } }
          : {}),
      },
      publish: live,
      fieldsets: ['URL'],
    });
    const u = data.draftPost?.url;
    const url = u?.base && u?.path ? `${/^https?:\/\//.test(u.base) ? '' : 'https://'}${String(u.base).replace(/\/$/, '')}${u.path}` : null;
    // A draft's address doesn't open until it's published; don't present it as live.
    return { url: live ? url : null, externalId: data.draftPost?.id ?? null, dryRun: false };
  },
};

/** The Settings "Test" button: check the key and list who can be the author. */
export async function testWix(env: NodeJS.ProcessEnv): Promise<{ ok: boolean; message: string }> {
  if (!env.WIX_API_KEY || !env.WIX_SITE_ID) return { ok: false, message: 'Save the API key and site ID first.' };
  try {
    const data = await wixCall(env, '/members/v1/members/query', { fieldsets: ['FULL'], query: { paging: { limit: 20 } } });
    const members: { id: string; name: string }[] = (data.members ?? []).map((m: any) => ({ id: m.id, name: m.profile?.nickname || m.loginEmail || m.id }));
    if (env.WIX_MEMBER_ID) {
      const me = members.find((m) => m.id === env.WIX_MEMBER_ID);
      return me || members.length >= 20
        ? { ok: true, message: `Connected. Posts will be by ${me?.name ?? env.WIX_MEMBER_ID}${live(env)}.` }
        : { ok: false, message: `Connected, but ${env.WIX_MEMBER_ID} isn't a member of this site. Members: ${members.map((m) => `${m.name} (${m.id})`).join(', ') || 'none'}.` };
    }
    if (!members.length) return { ok: false, message: 'Connected, but this site has no members. Log in to your Wix site once as the owner, then test again.' };
    return { ok: false, message: `Connected. Now paste the member ID of the author: ${members.map((m) => `${m.name} — ${m.id}`).join('; ')}.` };
  } catch (err: any) {
    return { ok: false, message: String(err?.message ?? err) };
  }
}

const live = (env: NodeJS.ProcessEnv) => (env.WIX_LIVE === '1' ? ', published straight away' : ', saved as drafts in Wix');
