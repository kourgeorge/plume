import * as cheerio from 'cheerio';
import { getSetting, setSetting } from '../db';

/**
 * What a site is built with and connected to, read from its HTML — no AI, so every entry is a fact
 * with the page it was seen on. Feeds the Product document and, later, the coding agent
 * (a site builder can't take a pull request; a GitHub-hosted site can).
 */
export type TechKind = 'builder' | 'shop' | 'hosting' | 'analytics' | 'ads' | 'chat' | 'video' | 'social' | 'forms' | 'fonts';

export interface TechSignal {
  name: string;
  kind: TechKind;
  /** Where it was seen first, e.g. "https://site.com/" */
  seenOn: string;
  /** e.g. the YouTube channel address or WhatsApp number, when the page shows one. */
  detail?: string;
}

interface Rule {
  name: string;
  kind: TechKind;
  /** Matched against the raw HTML. */
  html?: RegExp;
  /** Matched against <meta name="generator">. */
  generator?: RegExp;
  /** Matched against every link (href) on the page; the first match becomes `detail`. */
  link?: RegExp;
}

const RULES: Rule[] = [
  // Site builders and CMSs
  { name: 'WordPress', kind: 'builder', generator: /wordpress/i, html: /\/wp-content\/|\/wp-includes\// },
  { name: 'Webflow', kind: 'builder', generator: /webflow/i, html: /data-wf-site=|assets\.website-files\.com|cdn\.prod\.website-files\.com/ },
  { name: 'Wix', kind: 'builder', generator: /wix\.com/i, html: /static\.wixstatic\.com|wix-bolt|_wixCIDX/ },
  { name: 'Squarespace', kind: 'builder', generator: /squarespace/i, html: /static1\.squarespace\.com|squarespace-cdn\.com/ },
  { name: 'Framer', kind: 'builder', generator: /framer/i, html: /framerusercontent\.com|data-framer-/ },
  { name: 'Google Sites', kind: 'builder', generator: /google sites/i, html: /sites\.google\.com\/|ssl\.gstatic\.com\/atari\// },
  { name: 'Ghost', kind: 'builder', generator: /ghost/i },
  { name: 'Drupal', kind: 'builder', generator: /drupal/i, html: /\/sites\/default\/files\// },
  { name: 'Joomla', kind: 'builder', generator: /joomla/i },
  { name: 'HubSpot CMS', kind: 'builder', generator: /hubspot/i, html: /hs-sites\.com|hubspot\.net\/hub\// },
  { name: 'Next.js', kind: 'builder', html: /\/_next\/static\// },
  { name: 'Gatsby', kind: 'builder', generator: /gatsby/i, html: /\/page-data\/app-data\.json|___gatsby/ },
  { name: 'Hugo', kind: 'builder', generator: /hugo/i },
  // Shops and course platforms
  { name: 'Shopify', kind: 'shop', html: /cdn\.shopify\.com|Shopify\.theme/ },
  { name: 'WooCommerce', kind: 'shop', html: /woocommerce/i },
  { name: 'Teachable', kind: 'shop', link: /^https?:\/\/[^/]*\.teachable\.com/i, html: /teachablecdn\.com/ },
  { name: 'Thinkific', kind: 'shop', link: /^https?:\/\/[^/]*\.thinkific\.com/i },
  { name: 'Kajabi', kind: 'shop', link: /^https?:\/\/[^/]*\.mykajabi\.com/i, html: /kajabi-cdn\.com/ },
  { name: 'Gumroad', kind: 'shop', link: /gumroad\.com\//i },
  { name: 'Stripe checkout', kind: 'shop', link: /^https?:\/\/(buy|checkout)\.stripe\.com/i, html: /js\.stripe\.com/ },
  // Hosting
  { name: 'Vercel', kind: 'hosting', html: /\/_vercel\/insights|vercel-analytics/ },
  { name: 'Netlify', kind: 'hosting', html: /netlify-identity|\.netlify\.app/ },
  { name: 'GitHub Pages', kind: 'hosting', link: /^https?:\/\/[^/]+\.github\.io/i },
  { name: 'Cloudflare', kind: 'hosting', html: /cdn-cgi\/(challenge-platform|scripts|l\/email-protection)/ },
  // Analytics and ads
  { name: 'Google Analytics', kind: 'analytics', html: /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js|gtag\(['"]config['"],\s*['"]G-/ },
  { name: 'Google Tag Manager', kind: 'analytics', html: /googletagmanager\.com\/gtm\.js/ },
  { name: 'Hotjar', kind: 'analytics', html: /static\.hotjar\.com/ },
  { name: 'Microsoft Clarity', kind: 'analytics', html: /clarity\.ms\/tag/ },
  { name: 'Plausible', kind: 'analytics', html: /plausible\.io\/js/ },
  { name: 'Meta Pixel', kind: 'ads', html: /connect\.facebook\.net\/[^"']*\/fbevents\.js|fbq\(['"]init/ },
  { name: 'TikTok Pixel', kind: 'ads', html: /analytics\.tiktok\.com/ },
  { name: 'Google Ads', kind: 'ads', html: /googleadservices\.com|gtag\(['"]config['"],\s*['"]AW-/ },
  { name: 'LinkedIn Insight', kind: 'ads', html: /snap\.licdn\.com\/li\.lms-analytics/ },
  // Chat and contact
  { name: 'WhatsApp', kind: 'chat', link: /^(https?:\/\/)?(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\//i },
  { name: 'Intercom', kind: 'chat', html: /widget\.intercom\.io|js\.intercomcdn\.com/ },
  { name: 'Crisp', kind: 'chat', html: /client\.crisp\.chat/ },
  { name: 'Tawk.to', kind: 'chat', html: /embed\.tawk\.to/ },
  { name: 'Zendesk', kind: 'chat', html: /static\.zdassets\.com/ },
  { name: 'Telegram', kind: 'chat', link: /^https?:\/\/(t\.me|telegram\.me)\//i },
  // Forms and fonts
  { name: 'Typeform', kind: 'forms', html: /embed\.typeform\.com/, link: /typeform\.com\/to\//i },
  { name: 'Google Forms', kind: 'forms', link: /docs\.google\.com\/forms\//i },
  { name: 'Calendly', kind: 'forms', html: /assets\.calendly\.com/, link: /calendly\.com\//i },
  { name: 'Google Fonts', kind: 'fonts', html: /fonts\.googleapis\.com/ },
  // Video and social profiles
  { name: 'YouTube', kind: 'video', link: /^https?:\/\/(www\.)?(youtube\.com\/(@|channel\/|c\/|user\/)|youtu\.be\/)/i, html: /youtube\.com\/embed\/|youtube-nocookie\.com\/embed\// },
  { name: 'Vimeo', kind: 'video', html: /player\.vimeo\.com/ },
  { name: 'Facebook', kind: 'social', link: /^https?:\/\/(www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)[^/?#]+/i },
  { name: 'Instagram', kind: 'social', link: /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|reel\/)[^/?#]+/i },
  { name: 'TikTok', kind: 'social', link: /^https?:\/\/(www\.)?tiktok\.com\/@[^/?#]+/i },
  { name: 'LinkedIn', kind: 'social', link: /^https?:\/\/(www\.)?linkedin\.com\/(company|in|school)\/[^/?#]+/i },
  { name: 'X (Twitter)', kind: 'social', link: /^https?:\/\/(www\.)?(x|twitter)\.com\/(?!intent|share|home)[A-Za-z0-9_]{1,15}\/?$/i },
  { name: 'Pinterest', kind: 'social', link: /^https?:\/\/(www\.)?pinterest\.[a-z.]+\/(?!pin\/)[^/?#]+/i },
];

/** Signals visible on one page. */
export function detectTech(html: string, pageUrl: string): TechSignal[] {
  const $ = cheerio.load(html);
  const generator = $('meta[name="generator"]').attr('content') ?? '';
  const links = $('a[href]').map((_, el) => ($(el).attr('href') ?? '').trim()).get();
  const out: TechSignal[] = [];
  for (const r of RULES) {
    const link = r.link ? links.find((l) => r.link!.test(l)) : undefined;
    const hit = (r.generator && r.generator.test(generator)) || (r.html && r.html.test(html)) || !!link;
    if (!hit) continue;
    out.push({ name: r.name, kind: r.kind, seenOn: pageUrl, ...(link ? { detail: link.replace(/[?#].*$/, '').replace(/\/$/, '') } : {}) });
  }
  // A Next.js marker on a Vercel/Wix/etc. site is noise next to the real builder; keep it only when alone.
  const builders = out.filter((s) => s.kind === 'builder');
  return builders.length > 1 ? out.filter((s) => !(s.name === 'Next.js' && builders.some((b) => b.name !== 'Next.js'))) : out;
}

/** Combine pages: first sighting of each signal wins, so `seenOn` points at a real page. */
export function mergeSignals(lists: TechSignal[][]): TechSignal[] {
  const byName = new Map<string, TechSignal>();
  for (const list of lists) for (const s of list) if (!byName.has(s.name) || (!byName.get(s.name)!.detail && s.detail)) byName.set(s.name, byName.get(s.name) ? { ...byName.get(s.name)!, detail: s.detail } : s);
  const order: TechKind[] = ['builder', 'shop', 'hosting', 'analytics', 'ads', 'chat', 'forms', 'video', 'social', 'fonts'];
  return [...byName.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name));
}

export function saveTechSignals(list: TechSignal[]): void {
  setSetting('techSignals', { at: new Date().toISOString(), list });
}

export function techSignals(): { at: string | null; list: TechSignal[] } {
  return getSetting('techSignals', { at: null, list: [] as TechSignal[] });
}

const KIND_LABEL: Record<TechKind, string> = {
  builder: 'Built with', shop: 'Sells through', hosting: 'Hosted on', analytics: 'Measures visitors with', ads: 'Advertising tags',
  chat: 'Contact', forms: 'Forms and booking', video: 'Video', social: 'Social profiles', fonts: 'Fonts',
};

/** Plain lines for the research prompt and the Product document. */
export function techSummary(list = techSignals().list): string | null {
  if (!list.length) return null;
  const groups = new Map<TechKind, TechSignal[]>();
  for (const s of list) groups.set(s.kind, [...(groups.get(s.kind) ?? []), s]);
  return [...groups]
    .map(([k, ss]) => `- ${KIND_LABEL[k]}: ${ss.map((s) => `${s.name}${s.detail ? ` (${s.detail})` : ''}`).join(', ')}`)
    .join('\n');
}
