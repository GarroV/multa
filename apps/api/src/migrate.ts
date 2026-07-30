import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './db/client.ts';
import { logger } from './logger.ts';

/**
 * Накат миграций перед стартом сервера. Отдельная точка входа вместо `drizzle-kit migrate`:
 * drizzle-kit — сборочный инструмент, и тянуть его в прод-образ означало бы держать там
 * devDependencies. Механизм тот же (папка `migrations` + журнал `__drizzle_migrations`).
 */
const folder = process.env.MIGRATIONS_DIR ?? 'migrations';

try {
  await migrate(db, { migrationsFolder: folder });
  logger.info(`миграции применены (${folder})`);
} catch (err) {
  logger.error('миграции не применились', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
