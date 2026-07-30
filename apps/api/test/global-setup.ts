import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';

const DEFAULT_URL = 'postgres://multa:multa_dev_password@localhost:5432/multa_test';

/**
 * Готовит тестовую базу один раз на прогон: накатывает миграции и чистит данные.
 *
 * Миграции применяются тем же механизмом, что в прод-контейнере, — поэтому прогон падает,
 * если миграция сломана, а не «работает на схеме из головы».
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const dbName = new URL(url).pathname.slice(1);
  // Предохранитель: у теста нет причин смотреть на дев- или прод-базу, а TRUNCATE необратим.
  if (!dbName.endsWith('_test')) {
    throw new Error(`отказ: имя тестовой базы должно заканчиваться на _test, получено «${dbName}»`);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });

  // Список таблиц берём из information_schema, а не из константы: захардкоженный перечень
  // отстаёт от миграций, и новая таблица тихо утекала бы данными между прогонами.
  const tables = await db.execute<{ name: string }>(sql`
    select quote_ident(tablename) as name
    from pg_tables
    where schemaname = 'public' and tablename <> '__drizzle_migrations'
  `);
  const names = tables.rows.map((r) => r.name);
  if (names.length > 0) {
    await db.execute(sql.raw(`truncate table ${names.join(', ')} restart identity cascade`));
  }

  await pool.end();
}
