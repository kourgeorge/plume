/**
 * Fill an EMPTY data folder with a made-up business so the workspace can be tried without a real site.
 * Usage: DATA_DIR=./data-demo npm run demo   (then: DATA_DIR=./data-demo PORT=4419 npm run dev)
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config';
import { getDb, getSetting, setSetting } from '../db';
import { PROFILE_DOCS, writeDoc } from '../context/profile';
import { createDraft } from '../queue';
import { auditPages } from '../agents/seoAudit';
import { parseReport } from '../analytics/pagespeed';
import { addCompetitor, savePerson } from '../context/extra';

if (getSetting('siteUrl', null) || fs.existsSync(path.join(DATA_DIR, 'profile', 'product.md'))) {
  console.error(`${DATA_DIR} already has data. Point DATA_DIR at a new, empty folder.`);
  process.exit(1);
}
getDb();
const site = 'https://acme-widgets.example';
setSetting('siteUrl', site);
writeDoc(
  'product',
  '# Product\n\nAcme Widgets makes modular desk widgets for small remote teams, sold online with free returns and a two-year warranty. Teams use them to keep cables, chargers and notes in one place.\n\n## Features\n- Modular pieces that click together\n',
);
for (const d of PROFILE_DOCS.slice(1)) writeDoc(d.id, `# ${d.title}\n\n(Sample document — replace with real research.)`);

createDraft({
  agent: 'seo',
  kind: 'blog_post',
  title: 'How to organise a small desk for remote work',
  body: '# How to organise a small desk for remote work\n\nA small desk works best when every item has one home. Start by clearing everything off, then put back only what you use daily. Cables are the biggest source of clutter, so route them along one edge.',
  meta: {
    slug: 'organise-small-desk',
    metaDescription: 'A practical guide to organising a small desk for remote work, from cables to chargers, in five simple steps.',
    keyword: 'organise small desk',
    reason: 'Google already shows you for "organise small desk" (640 times, average position 14.2). A focused page could move it onto page one.',
    source: 'search-console',
  },
});
createDraft({
  agent: 'writer',
  kind: 'article',
  title: 'Why modular beats all-in-one for team desks',
  body: '# Why modular beats all-in-one for team desks\n\nAll-in-one organisers look neat on day one and fail by month three, because no two desks are the same.',
  meta: { slug: 'modular-vs-all-in-one', keyword: 'modular desk organiser', reason: 'Content plan pillar: buying guides.' },
});

const page = (url: string, o: Record<string, unknown>) => ({
  url, status: 200, title: 'Acme Widgets — modular desk organisers', meta_description: 'x'.repeat(130), canonical: url,
  h1: 'Desk widgets', headings: '[]', images_missing_alt: 0, has_schema: 1, word_count: 600, ...o,
});
setSetting('lastAudit', auditPages([page(`${site}/`, { meta_description: '', images_missing_alt: 3, has_schema: 0 }), page(`${site}/shop`, { title: 'Shop' })] as any, { robotsOk: true, sitemapOk: false }));

const report = (perf: number, lcp: number, strategy: 'mobile' | 'desktop') =>
  parseReport(
    {
      lighthouseResult: {
        finalDisplayedUrl: `${site}/`,
        categories: { performance: { score: perf }, accessibility: { score: 1 }, 'best-practices': { score: 0.73 }, seo: { score: 0.91 } },
        audits: {
          'largest-contentful-paint': { numericValue: lcp },
          'first-contentful-paint': { numericValue: strategy === 'mobile' ? 3400 : 1200 },
          'total-blocking-time': { numericValue: 499 },
          'cumulative-layout-shift': { numericValue: 0.051 },
          'uses-optimized-images': { title: 'Efficiently encode images', score: 0.3, description: 'Compressed images load faster and use less data.', details: { type: 'opportunity', overallSavingsMs: 6200 } },
          'render-blocking-resources': { title: 'Eliminate render-blocking resources', score: 0.2, description: 'Resources are blocking the first paint of your page.', details: { type: 'opportunity', overallSavingsMs: 2100 } },
        },
      },
    },
    strategy,
  );
setSetting('pagespeed', { mobile: report(0.54, 19800, 'mobile'), desktop: report(0.88, 2100, 'desktop') });
const rival = addCompetitor({ name: 'DeskTidy', url: 'desktidy.example', notes: 'Cheaper, but one-size-fits-all organisers.', source: 'research', watch: true })!;
addCompetitor({ name: 'CableCo', url: 'cableco.example', notes: 'Cable trays only; strong on Amazon.', source: 'research' });
getDb()
  .prepare('INSERT INTO competitor_changes (competitor_id, at, changes) VALUES (?, ?, ?)')
  .run(rival.id, new Date().toISOString(), JSON.stringify([
    { kind: 'new-pages', text: 'added 2 pages', items: ['/compare/acme-widgets', '/blog/remote-desk-setup'] },
    { kind: 'prices', text: 'changed prices: $29/mo gone; now $24/mo' },
  ]));
savePerson({ name: 'Dana Levi', role: 'Founder', bio: 'Former office designer. Writes short, practical posts; never uses buzzwords.', linkedinUrl: 'linkedin.com/in/dana-levi-example' });
console.log(`Demo data written to ${DATA_DIR}. Start it with: DATA_DIR=${DATA_DIR} PORT=4419 npm run dev`);
