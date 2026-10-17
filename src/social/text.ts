/**
 * Length rules for social posts. Text is never cut to fit: a post that is too long is sent back to be
 * rewritten, and publishing refuses it with the exact count, so nothing goes out with a sentence missing.
 */

export const X_LIMIT = 280;
export const X_THREAD_MAX = 6;
export const LINKEDIN_LIMIT = 3000;
export const REDDIT_LIMIT = 10000;
/** Separator between posts of an X thread inside one draft body (a line with three dashes). */
export const THREAD_SEPARATOR = /\n\s*---+\s*\n/;

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g;
const URL_WEIGHT = 23;

/** X's "weighted" length: links count as 23; Latin, Hebrew, Arabic, Cyrillic count 1; emoji and CJK count 2. */
export function xLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(URL_RE, () => {
    n += URL_WEIGHT;
    return '';
  });
  for (const ch of withoutUrls.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    const light = cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247);
    n += light ? 1 : 2;
  }
  return n;
}

/** A thread draft → its posts, in order, without empty ones. */
export function splitThread(body: string): string[] {
  return body
    .split(THREAD_SEPARATOR)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function joinThread(posts: string[]): string {
  return posts.map((p) => p.trim()).join('\n\n---\n\n');
}

export type SocialChannel = 'x' | 'linkedin' | 'reddit';

export interface LengthProblem {
  /** 1-based post number within an X thread; 1 for single posts. */
  post: number;
  length: number;
  limit: number;
}

/** Every post that is over its channel's limit. Empty = fits. */
export function lengthProblems(channel: SocialChannel, body: string): LengthProblem[] {
  if (channel === 'x') {
    const posts = splitThread(body);
    const out = posts.map((p, i) => ({ post: i + 1, length: xLength(p), limit: X_LIMIT })).filter((p) => p.length > p.limit);
    if (posts.length > X_THREAD_MAX) out.push({ post: posts.length, length: posts.length, limit: X_THREAD_MAX });
    return out;
  }
  const limit = channel === 'linkedin' ? LINKEDIN_LIMIT : REDDIT_LIMIT;
  const length = [...body.trim()].length;
  return length > limit ? [{ post: 1, length, limit }] : [];
}

/** Plain English for a length problem, used in rewrite prompts and publishing errors. */
export function describeProblems(channel: SocialChannel, problems: LengthProblem[]): string {
  return problems
    .map((p) =>
      channel === 'x' && p.limit === X_THREAD_MAX
        ? `the thread has ${p.length} posts; keep it to ${X_THREAD_MAX}`
        : `${channel === 'x' ? `post ${p.post} is` : 'the text is'} ${p.length} characters; the limit is ${p.limit}`,
    )
    .join('; ');
}

/**
 * LinkedIn reads post text as "little text": these characters have meaning there, and an unescaped one
 * can make LinkedIn drop the rest of the post. Escaping keeps the text exactly as written.
 */
export function linkedinEscape(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);
}

/** Social posts are plain text: take Markdown emphasis and headings off, keep the words and links. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
