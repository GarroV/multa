import { defineConfig, devices } from '@playwright/test';

/**
 * Браузерный E2E (issue #17). Проверяет то, чего не видят ни юниты, ни смоук бандла: что
 * собранное приложение действительно рендерит план, принимает трату и не ломается на узком
 * экране. Гоняется по **прод-сборке** (`vite preview`), потому что именно она уезжает на сервер.
 *
 * Окружение поднимает сам Playwright: api на 3100 с отдельной базой `multa_e2e` (её имя обязано
 * отличаться от дев- и тест-базы — тесты входят в демо и пересеивают его), затем web на 4173 с
 * `VITE_API_URL`, указывающим на этот api.
 */

const API_PORT = 3100;
const WEB_PORT = 4173;
const DB =
  process.env.E2E_DATABASE_URL ?? 'postgres://multa:multa_dev_password@localhost:5432/multa_e2e';

export default defineConfig({
  testDir: './e2e',
  // Демо — общий воркспейс, его пересеивает каждый вход: параллельные файлы гонялись бы по одним
  // данным и мешали друг другу.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `node -e "process.exit(0)" && pnpm --filter @multa/api exec tsx src/migrate.ts && pnpm --filter @multa/api exec tsx src/server.ts`,
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_URL: DB,
        API_PORT: String(API_PORT),
        WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
        BETTER_AUTH_SECRET: 'e2e_secret_at_least_32_characters_long',
        BETTER_AUTH_URL: `http://localhost:${API_PORT}`,
        MIGRATIONS_DIR: 'migrations',
      },
    },
    {
      command: `pnpm build && pnpm exec vite preview --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: { VITE_API_URL: `http://localhost:${API_PORT}` },
    },
  ],
});
