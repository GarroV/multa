import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../env.ts';
import * as schema from './schema/index.ts';

/**
 * Пул соединений с таймаутами (issue #81).
 *
 * У пула `pg` по умолчанию НЕТ ни одного ограничения по времени: ожидание свободного соединения
 * бесконечно, запрос не ограничен ничем. Один прогон тестов из-за этого провисел 712 секунд вместо
 * 20-секундного таймаута и выглядел как поломка инфраструктуры, а не как флейк.
 *
 * В проде это опаснее, чем в тестах: заблокированный запрос держал бы HTTP-соединение бесконечно, и
 * человек смотрел бы на крутилку, пока не закроет вкладку. Зависание хуже ошибки — ошибку видно.
 *
 * Значения намеренно щедрые: они ловят «что-то пошло совсем не так», а не режут медленные, но живые
 * запросы. Настраиваются переменными окружения — на слабой машине или толстой миграции пороги
 * поднимаются без правки кода.
 */
const number = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: number(process.env.DB_POOL_MAX, 10),
  /* Нет свободного соединения — падаем с внятной ошибкой, а не ждём вечно. */
  connectionTimeoutMillis: number(process.env.DB_CONNECT_TIMEOUT_MS, 5_000),
  idleTimeoutMillis: number(process.env.DB_IDLE_TIMEOUT_MS, 30_000),
  /*
   * Серверный предел на один запрос: Postgres сам отменит зависший на блокировке. Клиентский
   * `query_timeout` чуть больше — он страховка на случай, если ответ не придёт вовсе (сеть, а не
   * сервер), и срабатывать первым не должен, иначе причина в логе будет менее точной.
   */
  statement_timeout: number(process.env.DB_STATEMENT_TIMEOUT_MS, 15_000),
  query_timeout: number(process.env.DB_QUERY_TIMEOUT_MS, 20_000),
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;

/**
 * Отдельный пул для миграций: у них свои правила.
 *
 * Миграция может законно идти минуты — бэкфилл по всей таблице транзакций, перестройка индекса, —
 * и общий `statement_timeout` отменил бы её на середине. Отмена миграции опаснее её медленности:
 * часть изменений применена, журнал не дописан, и следующий запуск не знает, с чего продолжать.
 */
export function migrationPool(): Pool {
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: number(process.env.DB_CONNECT_TIMEOUT_MS, 5_000),
  });
}
