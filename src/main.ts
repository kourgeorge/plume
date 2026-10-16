import { PORT } from './config';
import { getDb } from './db';
import { buildServer } from './server';
import { publishDue } from './publish/runner';

getDb();
buildServer(PORT)
  .listen({ host: '127.0.0.1', port: PORT })
  .then(() => console.log(`Plume is running at http://127.0.0.1:${PORT}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

// Scheduled posts go out within a minute of their time.
setInterval(() => publishDue().catch((err) => console.error('publishing failed:', err)), 60_000);
