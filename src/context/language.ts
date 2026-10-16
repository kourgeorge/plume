import { getSetting, setSetting } from '../db';

const NAMES: Record<string, string> = {
  en: 'English', he: 'Hebrew', ar: 'Arabic', ru: 'Russian', fr: 'French', de: 'German', es: 'Spanish',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
};

/** Right-to-left scripts: the editors switch direction for these. */
export const RTL = new Set(['he', 'ar', 'fa', 'ur']);

/**
 * The site's language: the most common <html lang> across crawled pages, else a guess from the
 * script of the text itself (a Hebrew page with no lang attribute is still Hebrew).
 */
export function detectLanguage(pages: { lang: string; text: string }[]): string {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const code = p.lang.toLowerCase().split(/[-_]/)[0];
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) return top;
  const sample = pages.map((p) => p.text).join(' ').slice(0, 20000);
  const share = (re: RegExp) => (sample.match(re) ?? []).length / Math.max(sample.replace(/\s/g, '').length, 1);
  if (share(/[\u0590-\u05FF]/g) > 0.3) return 'he';
  if (share(/[\u0600-\u06FF]/g) > 0.3) return 'ar';
  if (share(/[\u0400-\u04FF]/g) > 0.3) return 'ru';
  return 'en';
}

export function languageName(code: string): string {
  return NAMES[code] ?? code;
}

export function contentLanguage(): string {
  return getSetting<string>('contentLanguage', 'en');
}

export function setContentLanguage(code: string): void {
  setSetting('contentLanguage', code);
}

/** The instruction every content-writing agent gets. */
export function languageRule(code = contentLanguage()): string {
  const name = languageName(code);
  return code === 'en'
    ? 'Write all customer-facing content in English.'
    : `Write all customer-facing content (titles, posts, articles, replies, meta descriptions) in ${name}, ` +
        `the language of the site and its customers — natural, native ${name}, not a translation. ` +
        `Use ${name} search terms when choosing keywords. Slugs stay in lowercase Latin letters.`;
}
