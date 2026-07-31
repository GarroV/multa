import cron from 'node-cron';
import { logger } from '../logger.ts';
import { findDemoWorkspace, seedDemo } from './seed.ts';

/**
 * Автосброс демо (issue #56). Общий демо-аккаунт обязан сам возвращаться к чистому наполненному
 * виду — иначе первый же смотрящий его «испачкает», а следующий увидит чужие траты и решит, что
 * так продукт и выглядит. Кнопки «сбросить руками» для этого недостаточно.
 *
 * Раз в час: если демо кто-то создавал, пересеиваем. Дёшево (одна таблица на воркспейс) и
 * предсказуемо: показ всегда начинается с одной и той же картинки.
 */
export function startDemoCron(): void {
  cron.schedule(
    '7 * * * *',
    () => {
      void findDemoWorkspace()
        .then(async (ws) => {
          if (!ws) return null;
          await seedDemo(ws.userId);
          return ws.workspaceId;
        })
        .then((id) => {
          if (id) logger.info(`demo cron: воркспейс ${id} сброшен к исходному виду`);
        })
        .catch((err) => logger.error('demo cron failed', err));
    },
    { timezone: 'UTC' },
  );
}
