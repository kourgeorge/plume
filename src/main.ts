import { PORT } from './config';
import { llmProblem } from './llm/settings';
import { getGlobalDb } from './db';
import { listSites } from './sites';
import { withSite } from './site';
import { buildServer } from './server';
import { startScheduler } from './scheduler';
import { log } from './log';
import { closeStaleJobs } from './jobs';
import { closeStaleChats } from './chat';
import { closeStaleRuns } from './geo/visibility';
import { startTelegram } from './phone/telegram';
import { shutdownBrowser } from './research/fetchPage';

getGlobalDb();
const stale = listSites().reduce((n, site) => n + withSite(site.slug, () => (closeStaleChats(), closeStaleRuns(), closeStaleJobs())), 0);
buildServer(PORT)
  .listen({ host: '127.0.0.1', port: PORT })
  .then(() => {
    log('info', 'server', `Plume is running at http://127.0.0.1:${PORT}`);
    const problem = llmProblem();
    if (problem) log('warn', 'server', `AI is off: ${problem}. Everything that needs no AI still works.`);
    if (stale) log('warn', 'server', `${stale} unfinished job(s) from before the restart were marked as stopped`);
    startScheduler();
    startTelegram();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// The shared Chrome is a separate process: close it when Plume stops.
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void shutdownBrowser().finally(() => process.exit(0)));
