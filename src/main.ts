import { PORT } from './config';
import { getDb } from './db';
import { buildServer } from './server';
import { startScheduler } from './scheduler';
import { log } from './log';
import { closeStaleJobs } from './jobs';

getDb();
const stale = closeStaleJobs();
buildServer(PORT)
  .listen({ host: '127.0.0.1', port: PORT })
  .then(() => {
    log('info', 'server', `Plume is running at http://127.0.0.1:${PORT}`);
    if (stale) log('warn', 'server', `${stale} unfinished job(s) from before the restart were marked as stopped`);
    startScheduler();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
