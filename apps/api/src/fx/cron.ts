import cron from 'node-cron';
import { logger } from '../logger.ts';
import { fxIsEmpty, refreshRates } from './service.ts';

/** Ежедневно 06:00 UTC тянем курсы (ЦБ публикует «на завтра» накануне). */
export function startFxCron(): void {
  cron.schedule(
    '0 6 * * *',
    () => {
      void refreshRates()
        .then((n) => logger.info(`fx cron: обновлено ${n} котировок`))
        .catch((err) => logger.error('fx cron failed', err));
    },
    { timezone: 'UTC' },
  );
}

/** На старте: если кэш пуст — один фетч, чтобы курсы работали в деве сразу. */
export async function ensureRatesOnStartup(): Promise<void> {
  if (await fxIsEmpty()) {
    logger.info('fx_rates пуст — начальная загрузка курсов…');
    const n = await refreshRates();
    logger.info(`fx: начальная загрузка — ${n} котировок`);
  }
}
