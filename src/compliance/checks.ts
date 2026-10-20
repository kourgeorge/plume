import type { Issue, Severity } from '../agents/seoAudit';
import { HEAD_CODE } from '../agents/seoAudit';
import { IMPRINT_LANGS, REGIONS, Region, lawList, needsConsentFirst, needsOptOut, needsRejectButton, needsStatement } from './regions';

/**
 * What the real-browser visit found, turned into problems in the same shape as the site check. Kept apart
 * from the browser so every rule can be tested with made-up findings. Plume can only see what a visitor
 * sees, so every problem is "likely", and the steps never claim the site is now legal.
 */

export type TrackerKind = 'analytics' | 'ads' | 'video' | 'chat' | 'fonts' | 'overlay';

export interface Tracker {
  name: string;
  kind: TrackerKind;
  host: RegExp;
  /** Sets cookies or sends personal data, so EU-style rules need consent first. False for cookie-free analytics. */
  needsConsent: boolean;
}

/** Third parties recognised by the address their files load from. */
export const TRACKERS: Tracker[] = [
  { name: 'Google Analytics', kind: 'analytics', host: /(^|\.)google-analytics\.com$|^analytics\.google\.com$/, needsConsent: true },
  { name: 'Google Tag Manager', kind: 'analytics', host: /^www\.googletagmanager\.com$/, needsConsent: true },
  { name: 'Hotjar', kind: 'analytics', host: /(^|\.)hotjar\.(com|io)$/, needsConsent: true },
  { name: 'Microsoft Clarity', kind: 'analytics', host: /(^|\.)clarity\.ms$/, needsConsent: true },
  { name: 'Mixpanel', kind: 'analytics', host: /(^|\.)mixpanel\.com$/, needsConsent: true },
  { name: 'Segment', kind: 'analytics', host: /(^|\.)segment\.(com|io)$/, needsConsent: true },
  { name: 'Yandex Metrica', kind: 'analytics', host: /^mc\.yandex\.(ru|com)$/, needsConsent: true },
  { name: 'Plausible', kind: 'analytics', host: /^plausible\.io$/, needsConsent: false },
  { name: 'Meta Pixel', kind: 'ads', host: /^connect\.facebook\.net$|^www\.facebook\.com$/, needsConsent: true },
  { name: 'Google Ads', kind: 'ads', host: /(^|\.)(googleadservices|doubleclick|googlesyndication)\.(com|net)$/, needsConsent: true },
  { name: 'TikTok Pixel', kind: 'ads', host: /^analytics\.tiktok\.com$/, needsConsent: true },
  { name: 'LinkedIn Insight', kind: 'ads', host: /^(snap|px)\.licdn\.com$|^px\.ads\.linkedin\.com$/, needsConsent: true },
  { name: 'X (Twitter) pixel', kind: 'ads', host: /^static\.ads-twitter\.com$|^analytics\.twitter\.com$/, needsConsent: true },
  { name: 'Pinterest tag', kind: 'ads', host: /^(s|ct)\.pinimg\.com$|^ct\.pinterest\.com$/, needsConsent: true },
  { name: 'Taboola', kind: 'ads', host: /(^|\.)taboola\.com$/, needsConsent: true },
  { name: 'Outbrain', kind: 'ads', host: /(^|\.)outbrain\.com$/, needsConsent: true },
  { name: 'YouTube (with cookies)', kind: 'video', host: /^www\.youtube\.com$/, needsConsent: true },
  { name: 'Vimeo', kind: 'video', host: /^player\.vimeo\.com$/, needsConsent: true },
  { name: 'Intercom', kind: 'chat', host: /(^|\.)intercom(cdn)?\.(io|com)$/, needsConsent: true },
  { name: 'Tawk.to', kind: 'chat', host: /(^|\.)tawk\.to$/, needsConsent: true },
  { name: 'Google Fonts', kind: 'fonts', host: /^fonts\.(googleapis|gstatic)\.com$/, needsConsent: true },
  // Accessibility "overlay" widgets: popular, but they don't make a site accessible on their own.
  { name: 'accessiBe', kind: 'overlay', host: /(^|\.)acsbapp?\.com$/, needsConsent: false },
  { name: 'UserWay', kind: 'overlay', host: /(^|\.)userway\.org$/, needsConsent: false },
  { name: 'EqualWeb', kind: 'overlay', host: /(^|\.)equalweb\.com$/, needsConsent: false },
  { name: 'Nagich', kind: 'overlay', host: /(^|\.)nagich\.co(m|\.il)$/, needsConsent: false },
  { name: 'AudioEye', kind: 'overlay', host: /(^|\.)audioeye\.com$/, needsConsent: false },
];

/** Cookie banners ("consent management platforms"), by where their files load from or a mark in the HTML. */
export const CMPS: { name: string; host?: RegExp; html?: RegExp }[] = [
  { name: 'Cookiebot', host: /(^|\.)cookiebot\.(com|eu)$/ },
  { name: 'OneTrust', host: /(^|\.)(cookielaw\.org|onetrust\.com)$/ },
  { name: 'CookieYes', host: /(^|\.)cookieyes\.com$/ },
  { name: 'Usercentrics', host: /(^|\.)usercentrics\.(eu|com)$/ },
  { name: 'Termly', host: /(^|\.)termly\.io$/ },
  { name: 'iubenda', host: /(^|\.)iubenda\.com$/ },
  { name: 'Cookie Script', host: /(^|\.)cookie-script\.com$/ },
  { name: 'consentmanager', host: /(^|\.)consentmanager\.net$/ },
  { name: 'Osano', host: /(^|\.)osano\.com$/ },
  { name: 'Didomi', host: /(^|\.)privacy-center\.org$|(^|\.)didomi\.io$/ },
  { name: 'Complianz', html: /cmplz-|complianz/i },
  { name: 'CookieAdmin / Borlabs', html: /borlabs-cookie|BorlabsCookie/i },
];

/** Which known trackers these request addresses belong to (own-site files never count). */
export function matchTrackers(urls: string[], origin: string): Tracker[] {
  const own = (() => {
    try {
      return new URL(origin).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const found = new Map<string, Tracker>();
  for (const u of urls) {
    let host: string;
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    if (own && (host === own || host.endsWith(`.${own}`))) continue;
    // A YouTube embed on the privacy-friendly address sets no cookies until the video plays.
    if (/youtube-nocookie\.com$/.test(host)) continue;
    const t = TRACKERS.find((t) => t.host.test(host));
    if (t) found.set(t.name, t);
  }
  return [...found.values()];
}

export function matchCmp(urls: string[], html: string): string | null {
  for (const c of CMPS) {
    if (c.html?.test(html)) return c.name;
    if (c.host && urls.some((u) => {
      try {
        return c.host!.test(new URL(u).hostname);
      } catch {
        return false;
      }
    })) return c.name;
  }
  return null;
}

/** One accessibility rule that failed, from axe-core. */
export interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical' | null;
  help: string;
  helpUrl: string;
  /** How many elements on the page fail it. */
  nodes: number;
  /** A short piece of the first failing element's HTML, to help find it. */
  sample?: string;
}

export interface PageScan {
  url: string;
  /** Tracker names that loaded before the visitor clicked anything. */
  trackersBefore: string[];
  axe: AxeViolation[];
  hasForm: boolean;
}

export interface ScanFindings {
  origin: string;
  regions: Region[];
  language: string;
  builder?: string;
  cmp: string | null;
  /** A cookie notice was visible (from a known platform, or text that looks like one). */
  bannerSeen: boolean;
  /** A visible "reject" / "only necessary" button. Null when there was no banner to look in. */
  rejectButton: boolean | null;
  /** Trackers still loading after clicking reject and reloading. Null when it couldn't be tried. */
  trackersAfterReject: string[] | null;
  /** Trackers loading for a visitor whose browser says "don't sell or share" (Global Privacy Control). Null = not tried. */
  trackersWithGpc: string[] | null;
  links: { privacy: string | null; cookies: string | null; accessibility: string | null; optOut: string | null; imprint: string | null };
  pages: PageScan[];
}

const byName = new Map(TRACKERS.map((t) => [t.name, t]));
const consentTrackers = (names: string[]) => names.filter((n) => byName.get(n)?.needsConsent);
const adTrackers = (names: string[]) => names.filter((n) => byName.get(n)?.kind === 'ads');
const NOT_LEGAL_ADVICE = 'Plume checks what a visitor can see; it is not legal advice. For anything with real risk, ask a lawyer who knows your market.';

/** Where to add a cookie banner, by site builder. */
const BANNER_HOW: Record<string, string> = {
  WordPress: 'In WordPress, install a consent plugin such as Complianz or CookieYes and run its setup wizard. Turn on "block scripts until consent" (Complianz: Wizard → Consent; CookieYes: Cookie Manager → auto-block).',
  Wix: 'In Wix, open Settings → Privacy & Cookies → Cookie banner and turn it on. Then, under Settings → Custom code, set each tracking code to the right category so Wix holds it back until consent.',
  Squarespace: 'In Squarespace, open Settings → Cookies & visitor data, turn on the cookie banner and choose "Opt in" (visitors must agree first).',
  Shopify: 'In Shopify, open Settings → Customer privacy → Cookie banner and turn it on for the regions listed here.',
  Webflow: 'In Webflow, add a consent tool (Finsweet Cookie Consent is free) under Site settings → Custom code, and mark each tracking script so it waits for consent.',
  Framer: 'In Framer, add the built-in Cookie Banner component (Insert → Cookie Banner) and set analytics to wait for consent.',
};

export function complianceIssues(f: ScanFindings): Issue[] {
  const issues: Issue[] = [];
  const add = (i: Omit<Issue, 'id'>) => issues.push({ ...i, id: `${i.check}:${i.url}` });
  const home = f.pages[0];
  const site = `${f.origin.replace(/\/$/, '')}/`;
  const rs = f.regions;
  const before = home ? consentTrackers(home.trackersBefore) : [];
  const where = (f.builder && BANNER_HOW[f.builder]) ?? (f.builder && HEAD_CODE[f.builder]) ?? 'Your site builder or developer can add a consent tool (Cookiebot, CookieYes and Complianz all have free plans for small sites).';

  // ---- privacy: trackers before consent ----
  if (needsConsentFirst(rs) && before.length) {
    const laws = lawList(rs.filter((r) => REGIONS[r].consentFirst), (r) => r.privacyLaw);
    if (!f.bannerSeen) {
      add({ check: 'privacy-no-consent', severity: 'critical', area: 'privacy', url: site,
        title: 'Trackers run with no cookie banner',
        why: `As soon as someone opens the site, ${before.join(', ')} start${before.length === 1 ? 's' : ''} collecting data, and nobody is asked first. Under ${laws}, these need the visitor's agreement before they load. This is the most common complaint privacy regulators act on.`,
        steps: [where, 'Set it so analytics and advertising tools only load after the visitor clicks "Accept", with "Reject" just as easy to find.', 'Then run this agent again: Plume reopens the site and checks that nothing loads before consent.', NOT_LEGAL_ADVICE] });
    } else {
      add({ check: 'privacy-trackers-before-consent', severity: 'high', area: 'privacy', url: site,
        title: 'Trackers load before the visitor answers the cookie banner',
        why: `The site has a cookie banner${f.cmp ? ` (${f.cmp})` : ''}, but ${before.join(', ')} already load${before.length === 1 ? 's' : ''} before anyone clicks. Under ${laws} the banner has to come first, or it doesn't count as asking.`,
        steps: [
          f.cmp ? `In ${f.cmp}, turn on automatic blocking ("auto-block" or "prior consent"), so it holds back scripts until the visitor agrees.` : 'In your cookie banner settings, turn on blocking until consent.',
          'If you use Google Tag Manager, set up Consent Mode so Google tags wait for an answer.',
          'Run this agent again to check.', NOT_LEGAL_ADVICE] });
    }
  }
  if (needsRejectButton(rs) && f.bannerSeen && f.rejectButton === false) {
    add({ check: 'privacy-no-reject', severity: 'high', area: 'privacy', url: site,
      title: 'The cookie banner has no "Reject" button',
      why: `Visitors can accept with one click but have to dig to say no. EU and UK regulators (and Brazil's) say refusing must be as easy as accepting, and have fined sites for exactly this.`,
      steps: ['In the banner settings, show a "Reject all" (or "Only necessary") button next to "Accept all", in the same size and style.', NOT_LEGAL_ADVICE] });
  }
  if (f.trackersAfterReject && consentTrackers(f.trackersAfterReject).length) {
    const still = consentTrackers(f.trackersAfterReject);
    add({ check: 'privacy-reject-ignored', severity: 'critical', area: 'privacy', url: site,
      title: '"Reject" doesn\'t stop the trackers',
      why: `Plume clicked "Reject" and reloaded the page, and ${still.join(', ')} still loaded. To the visitor that looks like a broken promise, and to a regulator it is the same as having no banner.`,
      steps: ['Check that each tracking code is added through the cookie tool (or marked with its category), not pasted straight into the page.', 'If Google Tag Manager is used, make every tag wait for consent (Consent Mode, or a "consent given" trigger).', NOT_LEGAL_ADVICE] });
  }
  if (rs.includes('eu') && home?.trackersBefore.includes('Google Fonts') && !f.bannerSeen) {
    add({ check: 'privacy-google-fonts', severity: 'low', area: 'privacy', url: site,
      title: 'Fonts load from Google\'s servers',
      why: 'Each visit sends the visitor\'s address to Google to fetch the fonts. A German court fined a site for this in 2022, and copycat warning letters followed. It is easy to avoid.',
      steps: ['Download the fonts and serve them from your own site (WordPress: the "OMGF" plugin does it; most builders have a "host fonts locally" option).'] });
  }

  // ---- privacy: the pages a visitor must be able to find ----
  const anyTrackers = f.pages.some((p) => p.trackersBefore.length);
  const anyForm = f.pages.some((p) => p.hasForm);
  if (!f.links.privacy) {
    add({ check: 'privacy-no-policy', severity: anyTrackers || anyForm ? 'critical' : 'high', area: 'privacy', url: site,
      title: 'No privacy policy link',
      why: `The site ${anyForm ? 'collects details through a form' : anyTrackers ? 'uses tracking tools' : 'may collect personal data'}, but Plume found no link to a privacy policy. Nearly every privacy law (${lawList(rs, (r) => r.privacyLaw)}) requires one that says what you collect, why, and how people can ask for it to be deleted.`,
      steps: ['Write a privacy policy page (Plume\'s compliance summary lists what yours must cover).', 'Link to it from the footer of every page, and next to every form.', NOT_LEGAL_ADVICE] });
  }
  if (needsOptOut(rs) && f.links.optOut === null && f.pages.some((p) => adTrackers(p.trackersBefore).length)) {
    add({ check: 'privacy-no-optout', severity: 'high', area: 'privacy', url: site,
      title: 'No "Do Not Sell or Share" link for US visitors',
      why: `The site uses advertising tools (${[...new Set(f.pages.flatMap((p) => adTrackers(p.trackersBefore)))].join(', ')}), which counts as "sharing" personal data under ${lawList(rs.filter((r) => REGIONS[r].optOutLink), (r) => r.privacyLaw)}. California and other states require a clear link that lets visitors opt out.`,
      steps: ['Add a "Do Not Sell or Share My Personal Information" (or "Your Privacy Choices") link to the footer.', 'It should turn off the advertising tools for that visitor. Most cookie tools (CookieYes, OneTrust, Termly) have a US opt-out mode that adds this for you.', NOT_LEGAL_ADVICE] });
  }
  if (needsOptOut(rs) && f.trackersWithGpc && adTrackers(f.trackersWithGpc).length) {
    add({ check: 'privacy-gpc-ignored', severity: 'medium', area: 'privacy', url: site,
      title: 'The browser\'s "don\'t share my data" signal is ignored',
      why: `Some browsers send a Global Privacy Control signal that means "do not sell or share my data". California treats it as a legal opt-out. Plume visited with the signal on, and ${adTrackers(f.trackersWithGpc).join(', ')} still loaded.`,
      steps: ['Turn on "Respect Global Privacy Control" in your cookie tool (CookieYes, OneTrust, Osano and Termly all have it).', NOT_LEGAL_ADVICE] });
  }
  if (rs.includes('eu') && IMPRINT_LANGS.has(f.language.split('-')[0]) && !f.links.imprint) {
    add({ check: 'privacy-no-imprint', severity: 'high', area: 'privacy', url: site,
      title: 'No Impressum (legal notice) page',
      why: 'Business websites aimed at Germany and Austria must name who runs them: the business name, address, a way to reach you quickly, and registration numbers. Missing ones attract warning letters (Abmahnungen) with fees attached.',
      steps: ['Add an "Impressum" page with the legal name, postal address, email, phone, and commercial register and VAT numbers if you have them.', 'Link to it from every page, usually in the footer.', NOT_LEGAL_ADVICE] });
  }

  // ---- accessibility ----
  const a11yLaws = lawList(rs, (r) => r.accessibilityLaw);
  const rules = new Map<string, { v: AxeViolation; urls: string[]; nodes: number }>();
  for (const p of f.pages) {
    for (const v of p.axe) {
      if (v.impact !== 'serious' && v.impact !== 'critical') continue;
      const r = rules.get(v.id) ?? { v, urls: [], nodes: 0 };
      r.urls.push(p.url);
      r.nodes += v.nodes;
      if (v.impact === 'critical') r.v = v;
      rules.set(v.id, r);
    }
  }
  for (const [id, r] of rules) {
    const plain = AXE_PLAIN[id];
    const severity: Severity = r.v.impact === 'critical' ? 'high' : 'medium';
    add({ check: `a11y-${id}`, severity, area: 'accessibility', url: r.urls[0],
      title: `${plain?.title ?? r.v.help} (${r.nodes} place${r.nodes === 1 ? '' : 's'}${r.urls.length > 1 ? ` on ${r.urls.length} pages` : ''})`,
      why: `${plain?.why ?? 'This makes the page hard or impossible to use for some disabled visitors.'}${a11yLaws ? ` Accessibility rules here include ${a11yLaws}.` : ''}`,
      steps: [...(plain?.steps ?? [`Fix what this rule describes: ${r.v.help}.`]), `Details and examples: ${r.v.helpUrl}`, ...(r.urls.length > 1 ? [`Also on: ${r.urls.slice(1).join(', ')}`] : [])],
      snippet: r.v.sample });
  }
  if (needsStatement(rs) && !f.links.accessibility) {
    const il = rs.includes('il');
    add({ check: 'a11y-no-statement', severity: il ? 'high' : 'medium', area: 'accessibility', url: site,
      title: 'No accessibility statement',
      why: `${lawList(rs.filter((r) => REGIONS[r].accessibilityStatement), (r) => r.accessibilityLaw)} expect${rs.filter((r) => REGIONS[r].accessibilityStatement).length > 1 ? '' : 's'} a page that says how accessible the site is, what is known not to work yet, and who to contact about a problem.${il ? ' In Israel, a missing statement is one of the most common grounds for lawsuits under the accessibility regulations.' : ''}`,
      steps: ['Plume drafted one for you in the Compliance folder: check the details, then publish it.', 'Link to it from the footer of every page.', NOT_LEGAL_ADVICE] });
  }
  const overlays = [...new Set(f.pages.flatMap((p) => p.trackersBefore).filter((n) => byName.get(n)?.kind === 'overlay'))];
  if (overlays.length && rules.size) {
    add({ check: 'a11y-overlay-not-enough', severity: 'low', area: 'accessibility', url: site,
      title: `The ${overlays.join(' / ')} widget doesn't fix these problems`,
      why: 'Accessibility widgets add buttons for bigger text or contrast, but they don\'t repair the page underneath. The problems listed here are still there for people using screen readers, and courts in the US and Israel have not accepted a widget as a defence.',
      steps: ['Keep the widget if visitors like it, but fix the problems above in the site itself.'] });
  }
  return issues;
}

/** Plain-English versions of the axe rules small sites fail most. */
const AXE_PLAIN: Record<string, { title: string; why: string; steps: string[] }> = {
  'color-contrast': { title: 'Text is too faint to read', why: 'Light grey on white, or text over photos, is hard to read for people with low vision, and for everyone on a phone in sunlight.', steps: ['Make the text darker or the background lighter until the contrast is at least 4.5 to 1 (3 to 1 for large text). Check colours at https://webaim.org/resources/contrastchecker/'] },
  'image-alt': { title: 'Images with no description', why: 'Screen readers announce these as "image" with no idea of what they show.', steps: ['Give each meaningful image a short description (alt text). Use alt="" for decoration.'] },
  label: { title: 'Form fields with no label', why: 'Someone using a screen reader hears "edit text" with no idea what to type. A placeholder that vanishes when typing doesn\'t count.', steps: ['Give each field a visible label linked to it (<label for="…">), or an aria-label.'] },
  'link-name': { title: 'Links with no text', why: 'Icon links (social icons, arrows) with no words are read out as just "link".', steps: ['Add hidden text or an aria-label that says where the link goes, e.g. aria-label="Instagram".'] },
  'button-name': { title: 'Buttons with no text', why: 'Icon buttons (menus, search, close) with no words are read out as just "button".', steps: ['Add an aria-label that says what the button does, e.g. aria-label="Open menu".'] },
  'html-has-lang': { title: 'The page doesn\'t say what language it is in', why: 'Screen readers then read Hebrew or German text with English pronunciation, which is unintelligible.', steps: ['Set the language on the <html> tag, e.g. <html lang="he">. Most builders set it from the site language setting.'] },
  'html-lang-valid': { title: 'The page\'s language code is wrong', why: 'Screen readers use it to choose a voice; a wrong code means the wrong voice.', steps: ['Use a standard code such as "en", "he" or "de-AT" on the <html> tag.'] },
  'document-title': { title: 'Page has no title', why: 'The title is the first thing a screen reader announces, and what appears in the browser tab.', steps: ['Add a <title> describing the page.'] },
  'frame-title': { title: 'Embedded frames with no name', why: 'Embedded maps, videos and forms are announced as "frame" with no description.', steps: ['Give each <iframe> a title, e.g. title="Map to our office".'] },
  'aria-required-attr': { title: 'Interactive parts are missing required information', why: 'Custom controls (tabs, sliders, menus) don\'t tell assistive technology their state.', steps: ['Ask your developer or theme author to add the missing ARIA attributes listed in the details.'] },
  'aria-hidden-focus': { title: 'Hidden parts can still be reached with the keyboard', why: 'Keyboard users land on things they can\'t see, and screen readers say nothing.', steps: ['Remove hidden elements from the tab order (tabindex="-1" or the inert attribute) while they are hidden.'] },
  'meta-viewport': { title: 'Zooming is turned off on phones', why: 'People with low vision can\'t pinch to zoom.', steps: ['Remove "user-scalable=no" and "maximum-scale=1" from the viewport tag.'] },
  'select-name': { title: 'Drop-down lists with no label', why: 'A screen reader can\'t say what the list is for.', steps: ['Give each <select> a visible label linked to it.'] },
  'input-image-alt': { title: 'Image buttons with no description', why: 'Image buttons are read as "button" with no meaning.', steps: ['Add an alt text that says what the button does.'] },
  'list': { title: 'Lists built incorrectly', why: 'Screen readers can\'t tell how many items a list has or where it ends.', steps: ['Put only <li> items directly inside <ul> and <ol>.'] },
  'nested-interactive': { title: 'Clickable things inside other clickable things', why: 'Screen readers and keyboards can\'t reach the inner control.', steps: ['Don\'t put links or buttons inside other links or buttons.'] },
};

/** Problems only the full browser visit can check again, not a quick re-read of one page. */
export const RECHECKABLE = /^(privacy|a11y)-/;
