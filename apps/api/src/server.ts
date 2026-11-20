import { createApp } from './app.js';
import { createLogger } from '@clipforge/shared';

const PORT = parseInt(process.env.PORT || '4317', 10);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || './storage/db/clipforge.sqlite';

const logger = createLogger('api', 'server-main');

const app = createApp({
  dbPath: DB_PATH,
  logger: false
});

async function main() {
  try {
    const address = await app.listen({ port: PORT, host: HOST });
    logger.info(`Clipforge REST API running at ${address}/api`);
  } catch (err) {
    logger.error('Failed to start API server', undefined, { error: String(err) });
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  main();
}
