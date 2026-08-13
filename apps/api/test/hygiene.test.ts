import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Сторож против пробных файлов в дереве тестов (issue #74).
 *
 * В сессии адверсарного аудита агенты создавали пробы прямо в `apps/api/test/`
 * (`zz-probe-money.test.ts`, `zzz-adversarial-tmp.test.ts`), и два из них уехали в коммиты вместе
 * со смысловыми правками. Проба без assert'а проходит молча и создаёт ложное ощущение покрытия;
 * падающая проба красит `pnpm test` без причины. В CI они тоже гоняются.
 *
 * Проверка ловит два признака: временное имя и тест без единого утверждения. Второе важнее — имя
 * можно выбрать любое, а вот тест, который ничего не проверяет, бесполезен всегда, кем бы он ни
 * был написан. Автор этих строк сам заводил такие файлы по ходу работы, так что сторож нужен не
 * «агентам», а всем.
 */

const ROOTS = [
  fileURLToPath(new URL('.', import.meta.url)),
  fileURLToPath(new URL('../../web/e2e', import.meta.url)),
  fileURLToPath(new URL('../../../packages/core/src', import.meta.url)),
];

/** Имена, которыми называют временное: под ними прячется то, что не собирались хранить. */
const TEMP_NAME = /(^|[^a-z])(zz+|tmp|temp|probe|scratch|shot|_)[^/]*\.(test|spec)\.tsx?$/i;

function testFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out = out.concat(testFiles(path));
      continue;
    }
    if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe('гигиена тестов', () => {
  const files = ROOTS.flatMap(testFiles);

  it('в дереве нет файлов с временными именами', () => {
    const temp = files.filter((f) => TEMP_NAME.test(f.split('/').pop()!));
    expect(temp.map((f) => f.split('/').slice(-2).join('/'))).toEqual([]);
  });

  it('каждый тестовый файл что-то утверждает', () => {
    /*
     * Файл без `expect` — это не тест, а прогон кода: он зелёный всегда и защищает ровно ни от
     * чего. Ищем по всему файлу, а не по каждому `it`: вспомогательные блоки бывают пустыми, и
     * придираться к ним значило бы заставлять писать бессмысленные утверждения.
     */
    const silent = files.filter((f) => !readFileSync(f, 'utf8').includes('expect('));
    expect(silent.map((f) => f.split('/').slice(-2).join('/'))).toEqual([]);
  });
});
