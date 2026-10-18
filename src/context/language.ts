import { getSetting, setSetting } from '../db';

const NAMES: Record<string, string> = {
  en: 'English', he: 'Hebrew', ar: 'Arabic', ru: 'Russian', fr: 'French', de: 'German', es: 'Spanish',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
  fa: 'Persian', uk: 'Ukrainian', el: 'Greek', hi: 'Hindi', th: 'Thai', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish',
};

/** Right-to-left scripts: the editors switch direction for these. */
export const RTL = new Set(['he', 'ar', 'fa', 'ur']);

/** Scripts that name their language on sight. Latin text could be English, French or Dutch, so it decides nothing. */
const SCRIPTS: [string, RegExp][] = [
  ['he', /[֐-׿]/g],
  ['ar', /[؀-ۿ]/g],
  ['ru', /[Ѐ-ӿ]/g],
  ['el', /[Ͱ-Ͽ]/g],
  ['ja', /[぀-ヿ]/g],
  ['ko', /[가-힯]/g],
  ['zh', /[一-鿿]/g],
  ['th', /[฀-๿]/g],
];

function scriptLanguage(text: string): string | null {
  const sample = text.slice(0, 5000);
  const letters = sample.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
  if (!letters) return null;
  for (const [code, re] of SCRIPTS) if ((sample.match(re) ?? []).length / letters > 0.3) return code;
  return null;
}

/** "he-IL" → "he". */
function baseCode(tag: string): string {
  return tag.toLowerCase().trim().split(/[-_]/)[0];
}

/**
 * One page's language. The text's own script beats <html lang>, because some builders mark every page "en"
 * whatever it says. Then <html lang>, then a language folder in the address (/fr/, /en-us/). Empty if unknown.
 */
export function pageLanguageOf(p: { lang: string; text: string; url?: string }): string {
  const byScript = scriptLanguage(p.text);
  if (byScript) return byScript;
  const declared = baseCode(p.lang);
  // A page of Latin text declared as Hebrew is a template default, not the truth.
  const hasText = /\p{L}{3}/u.test(p.text);
  if (declared && !(hasText && SCRIPTS.some(([c]) => c === declared))) return declared;
  const folder = p.url ? /^\/([a-z]{2})(?:[-_][a-z]{2})?(?:\/|$)/i.exec(new URL(p.url).pathname)?.[1] : undefined;
  if (folder && NAMES[folder.toLowerCase()]) return folder.toLowerCase();
  return '';
}

export interface SiteLanguages {
  /** The language most pages are in; agents write in it when nothing says otherwise. */
  main: string;
  /** Every language the site is published in, main first. One entry for most sites. */
  all: string[];
}

/**
 * The site's languages, counted page by page. A language counts when at least two pages and a tenth of the
 * site use it, so one stray English "privacy" page doesn't make a Hebrew site bilingual.
 */
export function detectLanguages(pages: { lang: string; text: string; url?: string }[]): SiteLanguages {
  const counts = new Map<string, number>();
  for (const p of pages) {
    const code = pageLanguageOf(p);
    if (code) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const main = ranked[0]?.[0] ?? 'en';
  const known = ranked.reduce((n, [, c]) => n + c, 0);
  const all = ranked.filter(([, n], i) => i === 0 || (n >= 2 && n >= known * 0.1)).map(([code]) => code);
  return { main, all: all.length ? all : [main] };
}

/** The main language only. Kept for callers that need a single answer. */
export function detectLanguage(pages: { lang: string; text: string; url?: string }[]): string {
  return detectLanguages(pages).main;
}

export function languageName(code: string): string {
  return NAMES[code] ?? code;
}

/** "Hebrew, English and Arabic". */
export function languageList(codes: string[]): string {
  const names = codes.map(languageName);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}

export function contentLanguage(): string {
  return getSetting<string>('contentLanguage', 'en');
}

/** Every language the site is published in, main first. */
export function contentLanguages(): string[] {
  const main = contentLanguage();
  const all = getSetting<string[]>('contentLanguages', []);
  return [main, ...all.filter((c) => c !== main)];
}

/** Save the site's languages. `byOwner` marks a choice made by hand, which research then leaves alone. */
export function setContentLanguages(langs: SiteLanguages, byOwner = false): void {
  setSetting('contentLanguage', langs.main);
  setSetting('contentLanguages', [langs.main, ...langs.all.filter((c) => c !== langs.main)]);
  if (byOwner) setSetting('contentLanguageByOwner', true);
}

export function setContentLanguage(code: string): void {
  setContentLanguages({ main: code, all: [code] });
}

export function languageSetByOwner(): boolean {
  return getSetting<boolean>('contentLanguageByOwner', false);
}

/** The instruction every content-writing agent gets. */
export function languageRule(code = contentLanguage(), all = code === contentLanguage() ? contentLanguages() : [code]): string {
  const name = languageName(code);
  const others = all.filter((c) => c !== code);
  const base =
    code === 'en' && !others.length
      ? 'Write all customer-facing content in English.'
      : `Write all customer-facing content (titles, posts, articles, replies, meta descriptions) in ${name}, ` +
        `the main language of the site and its customers — natural, native ${name}, not a translation. ` +
        `Use ${name} search terms when choosing keywords. Slugs stay in lowercase Latin letters.`;
  if (!others.length) return base;
  return (
    `${base}\nThe site is also published in ${languageList(others)}. When the task, the page being changed or the audience ` +
    `is in one of those languages, write in that language instead, with its own search terms — never mix languages in one piece.`
  );
}
