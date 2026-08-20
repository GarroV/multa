#!/usr/bin/env node
/**
 * Останавливает прогон, если он собирается проверить устаревший бандл (issue #146).
 *
 * E2E идёт по прод-сборке через `vite preview` с `reuseExistingServer`. Занятый порт означает, что
 * команда `pnpm build && vite preview` не выполнится — и тесты пойдут по бандлу, собранному когда-то
 * раньше. Один раз это уже стоило получаса: правка была, тест её не видел, дефект искался в коде.
 * Обратный случай хуже и никак себя не выдаёт: сломал, прогнал, зелено, закоммитил.
 *
 * Решение о падении принимает `staleBundleVerdict` из `src/lib` — оно покрыто тестами. Здесь только
 * сбор факта: время файлов и занятость порта.
 */
import { createConnection } from 'node:net';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staleBundleVerdict } from '../src/lib/staleBundle.ts';

const WEB_PORT = 4173;
const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const repo = resolve(web, '../..');

/** Самое свежее время изменения среди файлов дерева. `null`, если пути нет. */
function newestMs(path) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (stat.isFile()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    // node_modules в исходники не входит: его время меняется от установки зависимостей.
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const inner = newestMs(join(path, entry.name));
    if (inner !== null && inner > newest) newest = inner;
  }
  return newest === 0 ? null : newest;
}

function listensOn(host, port) {
  return new Promise((done) => {
    const socket = createConnection({ port, host });
    const finish = (busy) => {
      socket.destroy();
      done(busy);
    };
    socket.setTimeout(700);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

/*
 * Стучимся по обоим адресам localhost. `vite preview` слушает IPv6 (`::1`), и проверка только по
 * 127.0.0.1 получала ECONNREFUSED при живом сервере — то есть сторож пропускал ровно тот случай,
 * ради которого написан. Поймано фактическим запуском: чистая функция вердикта такого не видит,
 * потому что сбор факта в неё не входит.
 */
async function portBusy(port) {
  const [v4, v6] = await Promise.all([listensOn('127.0.0.1', port), listensOn('::1', port)]);
  return v4 || v6;
}

/*
 * Что влияет на бандл: код и разметка веба, его конфиг, и workspace-пакеты — они собираются внутрь.
 * Тесты сюда НЕ входят: правка спеки бандл не меняет, а падение на ней было бы ложным.
 */
const sources = [
  join(web, 'src'),
  join(web, 'index.html'),
  join(web, 'vite.config.ts'),
  join(repo, 'packages/core/src'),
  join(repo, 'packages/i18n/src'),
];

const srcMs = Math.max(...sources.map((p) => newestMs(p) ?? 0));
const distMs = newestMs(join(web, 'dist'));
const verdict = staleBundleVerdict({ distMs, srcMs, portBusy: await portBusy(WEB_PORT) });

if (verdict === 'stale-served') {
  const when = (ms) => new Date(ms).toLocaleTimeString('ru-RU');
  console.error(
    [
      '',
      `Порт ${WEB_PORT} уже занят, значит Playwright НЕ будет пересобирать веб —`,
      `а сборка старше исходников: dist от ${when(distMs)}, правки до ${when(srcMs)}.`,
      '',
      'Прогон проверил бы не тот код. Что делать:',
      `  • идёт другой прогон — дождись его;`,
      `  • сервер осиротел — погаси: lsof -ti:${WEB_PORT} | xargs kill`,
      '',
    ].join('\n'),
  );
  process.exit(1);
}
