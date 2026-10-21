import { MODELS } from '../config';
import { agentSystem } from '../context/profile';
import { askJson } from '../llm/client';
import { createDraft, listDrafts } from '../queue';
import { siteUrl } from '../sites';
import { getSetting } from '../db';
import type { Agent, Opportunity } from '../agents/types';
import { REGIONS, Region, lawList, needsStatement } from './regions';
import { ComplianceResult, lastCompliance, runComplianceScan } from './scan';
import type { ScanFindings } from './checks';

/**
 * The compliance agent: visits the site like a new visitor, puts the serious privacy and accessibility
 * problems into Site fixes (where the GitHub / WordPress fix flow picks them up), and drafts the pages the
 * law expects — an accessibility statement and the missing parts of the privacy policy — plus a summary.
 */

const ROLE = `You are a careful privacy and accessibility compliance writer for small businesses.
You write in plain words a business owner understands. You only state facts the scan or the business profile
supports; where a fact is missing (a company number, a contact person, an address), you leave a clearly marked
[FILL IN: …] placeholder instead of inventing it. You never promise the site is legal or fully accessible.`;

const DOC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'slug', 'metaDescription', 'body'],
  properties: {
    title: { type: 'string' },
    slug: { type: 'string', description: 'lowercase-words-with-dashes' },
    metaDescription: { type: 'string', description: '120 to 155 characters.' },
    body: { type: 'string', description: 'The full page in Markdown, starting with "# " + title.' },
  },
};

const DISCLAIMER = '> Drafted by Plume from what a visitor can see on the site. It is not legal advice: check it, fill in every [FILL IN] placeholder, and have a lawyer look over anything you are unsure about before publishing.';

/**
 * Documents not to write again: a statement or policy already drafted (and not turned down), and a summary
 * still waiting to be read. A new summary is written once the last one has been dealt with.
 */
function alreadyDrafted(): Set<string> {
  return new Set(
    listDrafts({ agent: 'compliance' })
      .filter((d) => (d.meta.doc === 'summary' ? d.status === 'draft' : d.status !== 'rejected'))
      .map((d) => String(d.meta.doc ?? '')),
  );
}

/** What to write, most useful first. Exposed for tests. */
export function plannedDocs(r: ComplianceResult, f: Pick<ScanFindings, 'links'>, already: Set<string>): Opportunity[] {
  const out: Opportunity[] = [];
  const open = (doc: string) => !already.has(doc);
  if (needsStatement(r.regions) && !f.links.accessibility && open('accessibility-statement')) {
    out.push({ kind: 'landing_page', doc: 'accessibility-statement', title: 'Accessibility statement',
      reason: `${lawList(r.regions.filter((x) => REGIONS[x].accessibilityStatement), (x) => x.accessibilityLaw)} expect a public accessibility statement, and the site has none.` });
  }
  if (r.issues.some((i) => i.area === 'privacy') && open('privacy-additions')) {
    out.push({ kind: 'landing_page', doc: 'privacy-additions', title: f.links.privacy ? 'Additions to your privacy policy' : 'Privacy policy',
      reason: f.links.privacy
        ? `Your privacy policy should name the tools Plume saw (${r.trackersBefore.join(', ') || 'none found'}) and the rights visitors have under ${lawList(r.regions, (x) => x.privacyLaw)}.`
        : `The site has no privacy policy. This is a starting draft covering ${lawList(r.regions, (x) => x.privacyLaw)}.` });
  }
  if (open('summary')) {
    out.push({ kind: 'compliance_report', doc: 'summary', title: 'Privacy and accessibility check',
      reason: `${r.counts.critical} serious and ${r.counts.warnings} other problems on ${r.pagesChecked} page${r.pagesChecked === 1 ? '' : 's'}, checked against the rules for ${r.regions.map((x) => REGIONS[x].name).join(', ')}.` });
  }
  return out;
}

/** The plain summary, written without AI: every line is something Plume saw. Exposed for tests. */
export function summaryBody(r: ComplianceResult): string {
  const lines = [
    '# Privacy and accessibility check',
    '',
    DISCLAIMER,
    '',
    '## Which rules Plume checked against',
    ...r.regions.map((x) => `- **${REGIONS[x].name}**: ${REGIONS[x].privacyLaw}${REGIONS[x].accessibilityLaw ? `; ${REGIONS[x].accessibilityLaw}` : ''}`),
    '',
    ...r.regionsWhy.map((w) => `_${w}_`),
    '',
    '## What loads before a visitor agrees to anything',
    r.trackersBefore.length ? r.trackersBefore.map((t) => `- ${t}`).join('\n') : '- Nothing Plume recognises as a tracker.',
    r.cmp ? `\nCookie banner: **${r.cmp}**.` : '',
    r.cookiesBefore.length ? `\nCookies set on the first visit: ${r.cookiesBefore.slice(0, 20).join(', ')}${r.cookiesBefore.length > 20 ? ` and ${r.cookiesBefore.length - 20} more` : ''}.` : '',
    '',
    '## Problems found',
  ];
  if (!r.issues.length) lines.push('None. Plume found nothing to fix on the pages it checked.');
  for (const area of ['privacy', 'accessibility'] as const) {
    const list = r.issues.filter((i) => i.area === area);
    if (!list.length) continue;
    lines.push('', `### ${area === 'privacy' ? 'Privacy' : 'Accessibility'}`);
    for (const i of list) lines.push(`- **${i.title}** (${i.severity}): ${i.why}`);
  }
  lines.push('', 'The serious problems are also in **Site fixes**, with step-by-step instructions.');
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

async function writeDoc(opp: Opportunity, r: ComplianceResult): Promise<ReturnType<typeof createDraft>> {
  const statement = opp.doc === 'accessibility-statement';
  const regions = r.regions as Region[];
  const a11y = r.issues.filter((i) => i.area === 'accessibility' && i.check !== 'a11y-no-statement');
  const prompt = statement
    ? `Write an accessibility statement page for ${siteUrl()}.\n` +
      `It must meet ${lawList(regions.filter((x) => REGIONS[x].accessibilityStatement), (x) => x.accessibilityLaw)}.\n` +
      `Include: the standard aimed for (WCAG 2.1 AA, or Israeli Standard 5568 where Israel applies), how accessible the site is today, ` +
      `the known problems below (in plain words, with "we are working on it"), how to report a problem (name, phone, email — use [FILL IN] where the profile doesn't say), ` +
      `and the date it was last checked (${r.at.slice(0, 10)}).\n` +
      (regions.includes('il') ? 'Israel applies: write it in Hebrew if the site is in Hebrew, and include the accessibility coordinator\'s name and contact details (as [FILL IN] if unknown), and the physical accessibility of the premises if the business has any.\n' : '') +
      `Known problems Plume found:\n${a11y.map((i) => `- ${i.title}`).join('\n') || '- none found'}`
    : `Write ${opp.title === 'Privacy policy' ? 'a privacy policy' : 'the sections the existing privacy policy needs to add'} for ${siteUrl()}.\n` +
      `It must cover ${lawList(regions, (x) => x.privacyLaw)}.\n` +
      `Name the third-party tools that were seen on the site, what each one is for, and how to refuse them: ${r.trackersBefore.join(', ') || 'none seen'}.\n` +
      `Cover: who is responsible (as [FILL IN] if unknown), what is collected and why, the legal basis (where the EU or UK applies), how long data is kept, ` +
      `visitors' rights (access, correction, deletion, and opting out of sale/sharing where a US state applies), how to contact you, and cookies.\n` +
      `Plume found these privacy problems; write the policy so it is honest about the current state, and don't claim things the site doesn't do:\n` +
      r.issues.filter((i) => i.area === 'privacy').map((i) => `- ${i.title}`).join('\n');
  const doc = await askJson<{ title: string; slug: string; metaDescription: string; body: string }>({
    purpose: `compliance:${opp.doc}`,
    model: MODELS.draft,
    effort: 'high',
    maxTokens: 16000,
    system: agentSystem(ROLE, undefined, undefined, 'compliance'),
    schema: DOC_SCHEMA,
    prompt: `${prompt}\n\nEnd the page body with nothing about Plume. Write in the site's language.`,
  });
  return createDraft({
    agent: 'compliance',
    kind: opp.kind,
    title: doc.title,
    body: `${DISCLAIMER}\n\n${doc.body}`,
    meta: { slug: doc.slug, metaDescription: doc.metaDescription, reason: opp.reason, doc: opp.doc },
  });
}

export const complianceAgent: Agent = {
  id: 'compliance',
  label: 'Compliance',
  description: 'Checks privacy (cookies, trackers, policies) and accessibility against the rules where your visitors are, and drafts the pages you are missing.',
  async findOpportunities({ limit = 3, onProgress }) {
    const origin = siteUrl();
    if (!origin) throw new Error('add your website address first');
    const r = await runComplianceScan(origin, (m) => onProgress?.(m));
    // Every problem it finds waits on the Dashboard (and on this agent's page) until it is fixed or turned down.
    const f = getSetting<Pick<ScanFindings, 'links'>>('lastComplianceFindings', { links: { privacy: null, cookies: null, accessibility: null, optOut: null, imprint: null } });
    // The visit is the slow part; once it is done, write everything it calls for (at most three documents).
    return plannedDocs(r, f, alreadyDrafted()).slice(0, Math.max(limit, 3));
  },
  async draft(opp) {
    const r = lastCompliance();
    if (!r) return null;
    if (opp.doc === 'summary') {
      return createDraft({ agent: 'compliance', kind: 'compliance_report', title: opp.title, body: summaryBody(r), meta: { reason: opp.reason, doc: 'summary', regions: r.regions } });
    }
    return writeDoc(opp, r);
  },
};
