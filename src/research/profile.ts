import { MODELS } from '../config';
import { ask } from '../llm/client';
import { PROFILE_DOCS, ProfileDocId, readDoc, writeDoc } from '../context/profile';
import { crawlSite, CrawledPage } from './crawl';
import { closeBrowser } from './fetchPage';
import { extractCompetitors } from './competitors';
import { techSummary } from './techSignals';
import { designSummary, readDesign } from './design';
import { log } from '../log';
import { finishJob, startJob, updateJob } from '../jobs';
import { contentLanguages, languageList, languageName } from '../context/language';

/** The site as one block of text for the model: every page, full text, with its SEO facts. */
export function siteDigest(pages: CrawledPage[]): string {
  return pages
    .map((p) => `<page url="${p.url}" title="${p.title}"${p.lang ? ` lang="${p.lang}"` : ''}>\nmeta: ${p.metaDescription || '(none)'}\nh1: ${p.h1 || '(none)'}\n${p.text}\n</page>`)
    .join('\n\n');
}

const RESEARCHER = `You are the research lead of a small marketing team. Your notes are the only thing the other team members
(SEO writer, social media writer, community manager, outreach) will read about this business, so they must be specific,
accurate and useful. Write in plain English. Quote facts from the site; mark anything you inferred as "(inferred)".
Never invent customers, numbers or testimonials. Write the document in English, but when the site is in another
language (or several), quote its key phrases, product names and customer wording in the original (with a short English gloss),
and note which search terms customers would type in each language. Output only the document in Markdown, starting with a "# " title.
End with a "## Sources" list of the URLs you relied on.`;

/**
 * Write one profile doc. Later docs see the earlier ones, so strategy builds on product,
 * and the content plan builds on everything.
 */
async function writeProfileDoc(id: ProfileDocId, url: string, digest: string, languages: string): Promise<void> {
  const spec = PROFILE_DOCS.find((d) => d.id === id)!;
  const earlier = PROFILE_DOCS.slice(0, PROFILE_DOCS.indexOf(spec))
    .map((d) => `<doc id="${d.id}">\n${readDoc(d.id) ?? ''}\n</doc>`)
    .join('\n\n');
  const needsWeb = id === 'competitors' || id === 'strategy' || id === 'content-strategy' || id === 'content-plan';
  const tech = id === 'product' ? techSummary() : null;
  const design = id === 'design' ? designSummary(await readDesign(url)) : null;

  const { text, sources } = await ask({
    purpose: `research:${id}`,
    model: MODELS.research,
    effort: 'high',
    webSearches: needsWeb ? 8 : 0,
    system: [{ type: 'text', text: `${RESEARCHER}\n\n<site url="${url}">\n${digest}\n</site>`, cache_control: { type: 'ephemeral' } }],
    prompt:
      `Write the "${spec.title}" document. It should cover: ${spec.brief}\n\n` +
      (id === 'product' ? `Start with a "## Languages" section stating these facts, read from the site's pages: ${languages}\n\n` : '') +
      (earlier ? `Documents already written (stay consistent with them):\n${earlier}\n\n` : '') +
      (tech ? `Detected from the site's code (facts — use them for the "Tech signals" section, add nothing):\n${tech}\n\n` : '') +
      (design ? `Read from the site's stylesheets (facts — base the palette and fonts on these; colours used only a few times are likely accents or leftovers):\n${design}\n\n` : '') +
      (needsWeb ? 'Use web search to check competitors and the market; cite what you find.' : 'Work from the site content only.'),
  });

  const extra = sources.filter((s) => !text.includes(s));
  writeDoc(id, extra.length ? `${text.trim()}\n\n${extra.map((s) => `- ${s}`).join('\n')}` : text);
}

/** Full onboarding: crawl, then write the documents in order. Runs in the background; returns the job id. */
export function startResearch(url: string, only?: ProfileDocId): number {
  const jobId = startJob('research', `Reading ${url}`);
  (async () => {
    const pages = await crawlSite(url, { onPage: (p, n) => updateJob(jobId, `Read ${n} pages (latest: ${p.url})`) });
    const langs = contentLanguages();
    updateJob(jobId, `Read ${pages.length} pages · site language: ${languageList(langs)}`);
    const languages =
      langs.length > 1
        ? `the site is published in ${languageList(langs)}; the main language is ${languageName(langs[0])}. Say which pages or sections use each language, and whether the audiences differ.`
        : `the site is written in ${languageName(langs[0])}.`;
    const digest = siteDigest(pages);
    for (const d of PROFILE_DOCS) {
      if (only && d.id !== only) continue;
      updateJob(jobId, `Writing ${d.title} (read ${pages.length} pages)`);
      await writeProfileDoc(d.id, url, digest, languages);
      if (d.id === 'competitors') {
        updateJob(jobId, 'Listing competitors');
        const added = await extractCompetitors().catch((err) => (log('warn', 'research', `competitor list not filled: ${err.message}`), []));
        if (added.length) log('info', 'research', `added ${added.length} competitor(s): ${added.map((c) => c.name).join(', ')}`);
      }
    }
    finishJob(jobId);
  })()
    .catch((err) => finishJob(jobId, String(err?.message ?? err)))
    .finally(() => closeBrowser());
  return jobId;
}
