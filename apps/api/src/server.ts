import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { env } from './env.ts';
import { startDemoCron } from './demo/cron.ts';
import { ensureRatesOnStartup, startFxCron } from './fx/cron.ts';
import { logger } from './logger.ts';

await ensureRatesOnStartup().catch((err) => logger.error('fx startup failed', err));
startFxCron();
startDemoCron();

serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  logger.info(`API на http://localhost:${info.port}`);
});
