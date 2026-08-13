import { defineConfig } from 'vitest/config';

/**
 * jsdom-окружение с origin, отличным от дев-URL API: так тесты видят разницу между
 * «baseURL из VITE_API_URL» (дев) и «origin страницы» (прод-сборка за Caddy).
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://multa.example.test' } },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Общая подготовка компонентных тестов: матчеры про смысл и уборка DOM между ними (#17).
    setupFiles: ['./vitest.setup.ts'],
  },
});
