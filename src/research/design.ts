import * as cheerio from 'cheerio';
import { USER_AGENT } from './fetchPage';

/**
 * What the site actually looks like, read from its own HTML and stylesheets: colours, fonts, logo.
 * The design guide is written from these facts, so it never invents a brand colour.
 */
export interface DesignFacts {
  colors: { value: string; count: number }[];
  fonts: { family: string; count: number }[];
  themeColor: string | null;
  logo: string | null;
  stylesheets: number;
}

const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;
const FUNC = /\b(?:rgba?|hsla?)\([^)]*\)/gi;
const GENERIC = new Set(['inherit', 'initial', 'unset', 'serif', 'sans-serif', 'monospace', 'cursive', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'emoji']);

/** "#ABC" → "#aabbcc", so the same colour written two ways counts once. */
function normHex(h: string): string {
  const x = h.toLowerCase();
  return x.length === 4 ? `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}` : x;
}

/** Count colours and font families in a block of CSS. Pure black, white and see-through are left out: every site has them. */
export function readCss(css: string, colors = new Map<string, number>(), fonts = new Map<string, number>()) {
  for (const m of css.match(HEX) ?? []) {
    const c = normHex(m);
    if (c !== '#000000' && c !== '#ffffff') colors.set(c, (colors.get(c) ?? 0) + 1);
  }
  for (const m of css.match(FUNC) ?? []) {
    const c = m.replace(/\s+/g, '').toLowerCase();
    if (!/,0\)$|\/0\)$/.test(c)) colors.set(c, (colors.get(c) ?? 0) + 1);
  }
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const first = m[1].split(',')[0].trim().replace(/^["']|["']$/g, '').replace(/!important/i, '').trim();
    if (first && !GENERIC.has(first.toLowerCase()) && !first.startsWith('var(')) fonts.set(first, (fonts.get(first) ?? 0) + 1);
  }
  return { colors, fonts };
}

const top = <T extends string>(m: Map<T, number>, n: number) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

/** Read the home page and up to `maxSheets` of its own stylesheets. Never throws: a site that can't be read gives empty facts. */
export async function readDesign(url: string, fetchFn: typeof fetch = fetch, maxSheets = 6): Promise<DesignFacts> {
  const empty: DesignFacts = { colors: [], fonts: [], themeColor: null, logo: null, stylesheets: 0 };
  const get = async (u: string) => {
    try {
      const res = await fetchFn(u, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      return res.ok ? await res.text() : null;
    } catch {
      return null;
    }
  };
  const html = await get(url);
  if (!html) return empty;
  const $ = cheerio.load(html);
  const colors = new Map<string, number>();
  const fonts = new Map<string, number>();
  $('style').each((_, el) => void readCss($(el).text(), colors, fonts));
  $('[style]').each((_, el) => void readCss($(el).attr('style') ?? '', colors, fonts));

  // Only the site's own stylesheets: a font CDN's CSS would drown out the site's colours.
  const origin = new URL(url).origin;
  const sheets = $('link[rel~="stylesheet"]')
    .map((_, el) => $(el).attr('href'))
    .get()
    .map((h) => {
      try {
        return new URL(h, url).toString();
      } catch {
        return null;
      }
    })
    .filter((u): u is string => !!u && new URL(u).origin === origin)
    .slice(0, maxSheets);
  let read = 0;
  for (const s of sheets) {
    const css = await get(s);
    if (css) (readCss(css, colors, fonts), read++);
  }
  // Fonts loaded from Google Fonts are named in the link itself.
  $('link[href*="fonts.googleapis.com"]').each((_, el) => {
    for (const fam of new URL($(el).attr('href')!, url).searchParams.getAll('family')) {
      const name = fam.split(':')[0].replace(/\+/g, ' ').trim();
      if (name) fonts.set(name, (fonts.get(name) ?? 0) + 5);
    }
  });

  const logoEl = $('img[src*="logo" i], img[alt*="logo" i], header img').first();
  const logo = logoEl.attr('src') ? new URL(logoEl.attr('src')!, url).toString() : null;
  return {
    colors: top(colors, 12).map(([value, count]) => ({ value, count })),
    fonts: top(fonts, 6).map(([family, count]) => ({ family, count })),
    themeColor: $('meta[name="theme-color"]').attr('content') ?? null,
    logo,
    stylesheets: read,
  };
}

/** The facts as plain text for the model. */
export function designSummary(f: DesignFacts): string {
  if (!f.colors.length && !f.fonts.length) return 'Nothing could be read from the site\'s styles.';
  return [
    `Colours, most used first (times used): ${f.colors.map((c) => `${c.value} (${c.count})`).join(', ') || 'none found'}`,
    `Fonts, most used first: ${f.fonts.map((x) => x.family).join(', ') || 'none found'}`,
    f.themeColor ? `Browser theme colour: ${f.themeColor}` : null,
    f.logo ? `Logo image: ${f.logo}` : null,
    `Read from the home page and ${f.stylesheets} of its stylesheet(s).`,
  ]
    .filter(Boolean)
    .join('\n');
}
