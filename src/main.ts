import { PORT } from './config';
import { getDb } from './db';
import { buildServer } from './server';
import { startScheduler } from './scheduler';
import { log } from './log';

getDb();
buildServer(PORT)
  .listen({ host: '127.0.0.1', port: PORT })
  .then(() => {
    log('info', 'server', `Plume is running at http://127.0.0.1:${PORT}`);
    startScheduler();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
