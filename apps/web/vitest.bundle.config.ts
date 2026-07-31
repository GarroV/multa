import { defineConfig } from 'vitest/config';

/**
 * Смоук собранного бандла — отдельный конфиг, потому что он требует свежего `vite build`
 * и не должен падать в обычном `pnpm test`, когда `dist/` ещё нет.
 *
 * origin как у прода за Caddy: web и API на одном хосте, `VITE_API_URL` пустой.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://multa.example.test' } },
    include: ['test/**/*.test.ts'],
  },
});
