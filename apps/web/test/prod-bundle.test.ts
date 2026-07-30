import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

/**
 * Смоук прод-сборки: собранный бандл исполняется в jsdom и должен смонтировать приложение.
 *
 * Зачем отдельно от юнитов: логин однажды умер именно здесь — better-auth бросал на
 * относительном baseURL, и падало это на уровне модуля в собранном бандле. Тесты по исходникам
 * такое пропускают (там своя сборка и свой env), поэтому проверяем ровно тот файл, который
 * уезжает на сервер, и с тем же пустым VITE_API_URL, что в прод-образе.
 *
 * Запускается отдельным конфигом (`pnpm test:bundle`) после `vite build`.
 */

// Через fileURLToPath, а не `new URL('../dist/', import.meta.url)`: Vite переписывает такой
// вызов в ассет-путь на этапе трансформа, и путь получается «/dist».
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Ошибки, пойманные при исполнении бандла: падение на уровне модуля — это провал смоука. */
const errors: unknown[] = [];

function entryFromHtml(): string {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const src = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
  if (!src) throw new Error('в index.html нет script src — сборка сломана');
  return src.replace(/^\//, '');
}

beforeAll(async () => {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('нет dist — сначала `pnpm --filter @multa/web build`');
  }

  // Приложению нужен тот же контейнер, что в index.html, иначе смоук проверял бы не то.
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  // API в смоуке нет: отвечаем «не авторизован», чтобы приложение дошло до экрана входа.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  window.addEventListener('error', (e) => errors.push(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => errors.push(e.reason));

  await import(pathToFileURL(join(DIST, entryFromHtml())).href);
  // Монтирование React — микротаска; даём кругу событий провернуться.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

describe('прод-бандл web', () => {
  test('index.html ссылается на существующие ассеты', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="\/([^"]+)"/g)].map((m) => m[1]!);
    const missing = refs.filter((ref) => !existsSync(join(DIST, ref)));
    expect(missing).toEqual([]);
    expect(refs.some((r) => r.endsWith('.js'))).toBe(true);
    expect(refs.some((r) => r.endsWith('.css'))).toBe(true);
  });

  test('бандл исполняется без ошибок на уровне модуля', () => {
    expect(errors).toEqual([]);
  });

  test('приложение монтируется в #root', () => {
    const root = document.getElementById('root');
    expect(root?.childElementCount ?? 0).toBeGreaterThan(0);
  });

  test('в сборке нет исходных путей монорепо', () => {
    // Утечка абсолютных путей означала бы, что в бандл попал dev-режим или sourcemap-мусор.
    const js = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
    for (const file of js) {
      const code = readFileSync(join(DIST, 'assets', file), 'utf8');
      expect(code).not.toContain('/Users/');
    }
  });
});
