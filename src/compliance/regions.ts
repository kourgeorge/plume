import { getDb } from '../db';
import { countryCode } from '../analytics/countries';

/**
 * Which privacy and accessibility laws are likely to apply, worked out from where the visitors come from,
 * the language the site is written in, and the phone number on the home page. Plume can't know where a
 * business is registered or who it sells to, so the answer is "likely", and the reports say so.
 */

export type Region = 'eu' | 'uk' | 'us' | 'us-ca' | 'il' | 'br' | 'ca' | 'ch' | 'au';

export interface RegionRules {
  name: string;
  /** The laws, as people search for them. */
  privacyLaw: string;
  accessibilityLaw: string | null;
  /** Trackers that aren't strictly needed may only run after the visitor agrees. */
  consentFirst: boolean;
  /** The visitor must be able to say no as easily as yes. */
  rejectButton: boolean;
  /** A "Do Not Sell or Share My Personal Information" link and honouring the browser's Global Privacy Control. */
  optOutLink: boolean;
  /** A public page saying how accessible the site is and how to report a problem. */
  accessibilityStatement: boolean;
}

export const REGIONS: Record<Region, RegionRules> = {
  eu: { name: 'European Union', privacyLaw: 'GDPR and the ePrivacy rules', accessibilityLaw: 'the European Accessibility Act (WCAG 2.1 AA, through EN 301 549)', consentFirst: true, rejectButton: true, optOutLink: false, accessibilityStatement: true },
  uk: { name: 'United Kingdom', privacyLaw: 'UK GDPR and PECR', accessibilityLaw: 'the Equality Act 2010', consentFirst: true, rejectButton: true, optOutLink: false, accessibilityStatement: false },
  ch: { name: 'Switzerland', privacyLaw: 'the Federal Act on Data Protection (FADP)', accessibilityLaw: null, consentFirst: false, rejectButton: false, optOutLink: false, accessibilityStatement: false },
  us: { name: 'United States', privacyLaw: 'US state privacy laws (Colorado, Connecticut, Texas, Virginia and others)', accessibilityLaw: 'the Americans with Disabilities Act (ADA; courts use WCAG 2.1 AA)', consentFirst: false, rejectButton: false, optOutLink: true, accessibilityStatement: false },
  'us-ca': { name: 'California', privacyLaw: 'the CCPA/CPRA', accessibilityLaw: 'the ADA and the Unruh Civil Rights Act', consentFirst: false, rejectButton: false, optOutLink: true, accessibilityStatement: false },
  il: { name: 'Israel', privacyLaw: 'the Protection of Privacy Law (Amendment 13)', accessibilityLaw: 'the Equal Rights for Persons with Disabilities regulations (Israeli Standard 5568, based on WCAG 2.0 AA)', consentFirst: false, rejectButton: false, optOutLink: false, accessibilityStatement: true },
  br: { name: 'Brazil', privacyLaw: 'the LGPD', accessibilityLaw: 'the Brazilian Inclusion Law (LBI)', consentFirst: true, rejectButton: true, optOutLink: false, accessibilityStatement: false },
  ca: { name: 'Canada', privacyLaw: 'PIPEDA (and Quebec\'s Law 25)', accessibilityLaw: 'the Accessibility for Ontarians with Disabilities Act (AODA) in Ontario', consentFirst: false, rejectButton: false, optOutLink: false, accessibilityStatement: false },
  au: { name: 'Australia', privacyLaw: 'the Privacy Act 1988', accessibilityLaw: 'the Disability Discrimination Act', consentFirst: false, rejectButton: false, optOutLink: false, accessibilityStatement: false },
};

/** EU and EEA members (two-letter codes). */
const EU = new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' '));
const COUNTRY_REGION: Record<string, Region> = { GB: 'uk', CH: 'ch', US: 'us', IL: 'il', BR: 'br', CA: 'ca', AU: 'au' };
/** German-language sites in Germany and Austria must name the business behind them (an "Impressum"). */
export const IMPRINT_LANGS = new Set(['de']);

const LANG_REGION: Record<string, Region[]> = {
  he: ['il'], de: ['eu'], fr: ['eu'], it: ['eu'], es: ['eu'], nl: ['eu'], pl: ['eu'], pt: ['eu', 'br'], sv: ['eu'], da: ['eu'], fi: ['eu'], el: ['eu'], cs: ['eu'], ro: ['eu'], hu: ['eu'],
};
const PHONE_REGION: [RegExp, Region][] = [
  [/^\+?972/, 'il'], [/^\+?44/, 'uk'], [/^\+?1/, 'us'], [/^\+?55/, 'br'], [/^\+?41/, 'ch'], [/^\+?61/, 'au'],
  [/^\+?(49|43|33|39|34|31|32|48|351|353|46|45|358|30|420|40|36)/, 'eu'],
];

/** A region counts when at least this share of search clicks comes from it. */
export const MIN_SHARE = 0.03;

export interface RegionInput {
  /** Search clicks per two-letter country code. */
  countries?: { code: string | null; clicks: number }[];
  language?: string;
  phone?: string | null;
}

export interface RegionResult {
  regions: Region[];
  /** Plain words: how Plume decided, shown with the report. */
  why: string[];
}

export function regionsFor(input: RegionInput): RegionResult {
  const found = new Set<Region>();
  const why: string[] = [];
  const total = (input.countries ?? []).reduce((s, c) => s + c.clicks, 0);
  if (total > 0) {
    const share = new Map<Region, number>();
    for (const c of input.countries ?? []) {
      if (!c.code) continue;
      const r = EU.has(c.code) ? 'eu' : COUNTRY_REGION[c.code];
      if (r) share.set(r, (share.get(r) ?? 0) + c.clicks / total);
    }
    for (const [r, s] of share) {
      if (s < MIN_SHARE) continue;
      found.add(r);
      why.push(`${Math.round(s * 100)}% of your Google visitors come from ${REGIONS[r].name}.`);
    }
  }
  const lang = (input.language ?? '').toLowerCase().split('-')[0];
  for (const r of LANG_REGION[lang] ?? []) {
    if (found.has(r)) continue;
    found.add(r);
    why.push(`The site is written in a language mostly read in ${REGIONS[r].name}.`);
  }
  const phone = (input.phone ?? '').replace(/[^\d+]/g, '');
  if (phone.startsWith('+') || phone.startsWith('00')) {
    const p = phone.replace(/^00/, '+');
    const hit = PHONE_REGION.find(([re]) => re.test(p));
    if (hit && !found.has(hit[1])) {
      found.add(hit[1]);
      why.push(`The phone number on your home page is from ${REGIONS[hit[1]].name}.`);
    }
  }
  // US traffic always brings California with it: it is the strictest state and the most populous.
  if (found.has('us')) found.add('us-ca');
  if (!found.size) {
    found.add('eu').add('us').add('us-ca');
    why.push('Plume has no visitor numbers yet, so it checks against the strictest common rules: the EU and California.');
  }
  return { regions: [...found], why };
}

/** Search clicks by country over the last 90 days. */
export function visitorCountries(days = 90): { code: string | null; clicks: number }[] {
  try {
    const from = new Date(Date.now() - days * 86400e3).toISOString().slice(0, 10);
    const rows = getDb().prepare('SELECT country, SUM(clicks) clicks FROM gsc_country WHERE date >= ? GROUP BY country').all(from) as { country: string; clicks: number }[];
    return rows.map((r) => ({ code: countryCode(r.country), clicks: r.clicks }));
  } catch {
    return [];
  }
}

export const needsConsentFirst = (rs: Region[]) => rs.some((r) => REGIONS[r].consentFirst);
export const needsRejectButton = (rs: Region[]) => rs.some((r) => REGIONS[r].rejectButton);
export const needsOptOut = (rs: Region[]) => rs.some((r) => REGIONS[r].optOutLink);
export const needsStatement = (rs: Region[]) => rs.some((r) => REGIONS[r].accessibilityStatement);
/** "the EU (GDPR and the ePrivacy rules) and Brazil (the LGPD)" */
export function lawList(rs: Region[], pick: (r: RegionRules) => string | null): string {
  const parts = rs.map((r) => (pick(REGIONS[r]) ? `${REGIONS[r].name} (${pick(REGIONS[r])})` : null)).filter(Boolean) as string[];
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
