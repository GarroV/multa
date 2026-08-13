import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';
import { pool } from '../src/db/client.ts';
import { env } from '../src/env.ts';

/**
 * Таймауты пула (issue #81).
 *
 * У пула `pg` по умолчанию нет ни одного ограничения по времени. Один прогон из-за этого провисел
 * 712 секунд вместо 20-секундного таймаута теста и выглядел как поломка инфраструктуры, а не как
 * флейк. В проде это опаснее: заблокированный запрос держал бы HTTP-соединение бесконечно, и
 * человек смотрел бы на крутилку, пока не закроет вкладку.
 *
 * Зависание хуже ошибки — ошибку видно. Здесь проверяется именно это: запрос, упёршийся в чужую
 * блокировку, ПАДАЕТ, а не ждёт.
 */
describe('таймауты соединений', () => {
  test('запрос, упёршийся в блокировку, падает, а не висит', async () => {
    /*
     * Свой пул с коротким пределом: механизм тот же, что у общего, но ждать его 15 секунд в каждом
     * прогоне — цена, которую платил бы каждый разработчик за одну проверку. Что предел есть и у
     * общего пула, проверяет соседний тест.
     *
     * Блокировку держим советской (`pg_advisory_lock`), а не строкой таблицы: не нужно ни данных,
     * ни уборки, и тест не зависит от того, что лежит в базе.
     */
    const fast = new Pool({ connectionString: env.DATABASE_URL, statement_timeout: 1_000, max: 1 });
    const holder = await pool.connect();
    const key = 815_081; // произвольный, лишь бы не пересекался с чужими
    await holder.query('select pg_advisory_lock($1)', [key]);

    const started = Date.now();
    try {
      await expect(fast.query('select pg_advisory_lock($1)', [key])).rejects.toThrow(
        /timeout|canceling statement/i,
      );
      // Именно быстро: смысл в том, что ждать бесконечно нельзя.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await holder.query('select pg_advisory_unlock($1)', [key]);
      holder.release();
      await fast.end();
    }
  }, 20_000);

  test('пул настроен с пределами, а не с бесконечным ожиданием', () => {
    /*
     * Проверка конфигурации, а не поведения: без неё «таймауты есть» держалось бы на одном тесте с
     * блокировкой, а он по природе медленный, и однажды его отключили бы «на время».
     */
    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(options.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(options.statement_timeout).toBeGreaterThan(0);
    expect(options.query_timeout).toBeGreaterThan(0);
  });
});
