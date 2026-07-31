import { defineConfig } from 'vitest/config';

/**
 * Юниты и интеграционные тесты в одном прогоне. `setupFiles` выставляет env до импорта
 * приложения (см. test/setup-env.ts), `globalSetup` один раз готовит тестовую базу.
 *
 * `fileParallelism: false`: файлы делят одну базу, а часть проверок смотрит на глобальные
 * таблицы (`fx_rates`, периоды) — параллельный прогон дал бы флаки на пустом месте.
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup-env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
