import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

/**
 * Прод-сборка api: два бандла (сервер и накат миграций) в `dist/`.
 *
 * Зачем бандл, а не tsx-рантайм: в прод-образе не должно быть devDependencies и компиляции на
 * старте. Внутрь вбираются только workspace-пакеты (`@multa/*`) — они и так наши исходники;
 * npm-зависимости остаются внешними и ставятся в образ через `pnpm install --prod`, чтобы
 * нативные и условные импорты (pg, better-auth) работали ровно так же, как в деве.
 */
const pkg = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8'));
const external = Object.entries(pkg.dependencies ?? {})
  .filter(([, version]) => !String(version).startsWith('workspace:'))
  .map(([name]) => name);

await build({
  entryPoints: ['src/server.ts', 'src/migrate.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  // Node-встроенные + прод-зависимости не бандлим: их ставит pnpm в образе.
  external: ['node:*', ...external],
  logLevel: 'info',
});
