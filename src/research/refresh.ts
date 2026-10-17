import { finishJob, runningJob, startJob, updateJob } from '../jobs';
import { runAudit } from '../agents/seoAudit';
import { siteUrl } from '../sites';
import { crawlSite } from './crawl';
import { closeBrowser } from './fetchPage';

/** Re-read the site's pages and run the site check, in the background. Returns the job id. Costs no AI money. */
export function startPageRefresh(): number {
  const url = siteUrl();
  if (!url) throw new Error('this website has no address yet');
  if (runningJob('refresh')) throw new Error('the pages are already being re-read');
  const jobId = startJob('refresh', `Reading ${url}`);
  (async () => {
    try {
      const pages = await crawlSite(url, { onPage: (p, n) => updateJob(jobId, `Read ${n} pages (latest: ${p.url})`) });
      const audit = await runAudit(url);
      updateJob(jobId, `Read ${pages.length} pages · site check score ${audit.score}`);
      finishJob(jobId);
    } catch (err: any) {
      finishJob(jobId, String(err?.message ?? err));
    } finally {
      await closeBrowser();
    }
  })();
  return jobId;
}
