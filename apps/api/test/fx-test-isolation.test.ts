import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Сторож изоляции валютных тестов (issue #141).
 *
 * `fx_rates` — единственная таблица без скоупа по воркспейсу, поэтому курсы в тестах общие. Сейчас
 * это безопасно ровно по двум причинам, и обе легко потерять незаметно:
 *
 * 1. Файлы гоняются по одному (`fileParallelism: false`), поэтому посев курса и проверка, которая на
 *    него смотрит, не могут разъехаться. Пару EUR→RUB на «сегодня» сеют семь файлов с разными
 *    значениями — при параллельном прогоне они начнут перезаписывать друг друга.
 * 2. У сценариев «курса НЕТ» своя пара на файл. `forgetRate` удаляет пару целиком, а проверка ждёт
 *    отказа — любой посторонний посев той же пары превращает её в ложное падение.
 *
 * Комментарий в `client.ts` об этом рассказывает, но комментарий не падает. Этот тест падает — и
 * стоит копейки против стоимости флака, который выглядит как «CI врёт» и лечится перезапусками.
 */
describe('изоляция валютных тестов', () => {
  const testDir = new URL('.', import.meta.url);

  it('файлы гоняются по одному: параллельный прогон разъедет посевы курсов', () => {
    const config = readFileSync(new URL('../vitest.config.ts', import.meta.url), 'utf8');
    /*
     * Проверяем именно текст конфига, а не рантайм-флаг: включить параллельность можно и флагом
     * запуска, но в первую очередь её включают правкой конфига — и тогда нужно, чтобы кто-то
     * остановил руку и прочитал причину.
     */
    expect(config).toMatch(/fileParallelism:\s*false/);
  });

  it('пары для «курса нет» не пересекаются между файлами', () => {
    /*
     * Соглашение проверяется по факту, а не по списку в комментарии: список в комментарии устаревает
     * молча. Здесь же — кто действительно вызывает `forgetRate` и с какой парой.
     */
    const owners = new Map<string, string[]>();
    for (const file of readdirSync(testDir).filter((f) => f.endsWith('.test.ts'))) {
      const src = readFileSync(new URL(file, testDir), 'utf8');
      for (const m of src.matchAll(/forgetRate\(\s*'([A-Z]{3})'\s*,\s*'([A-Z]{3})'\s*\)/g)) {
        const pair = `${m[1]}→${m[2]}`;
        const list = owners.get(pair) ?? [];
        if (!list.includes(file)) list.push(file);
        owners.set(pair, list);
      }
    }

    const shared = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([pair, files]) => `${pair}: ${files.join(', ')}`);
    expect(shared).toEqual([]);
  });

  it('пара, у которой курс удаляют, не сеется другим файлом', () => {
    const files = readdirSync(testDir).filter((f) => f.endsWith('.test.ts'));
    const read = (f: string) => readFileSync(new URL(f, testDir), 'utf8');

    const exclusive = new Map<string, string>();
    for (const file of files) {
      for (const m of read(file).matchAll(/forgetRate\(\s*'([A-Z]{3})'\s*,\s*'([A-Z]{3})'\s*\)/g)) {
        exclusive.set(`${m[1]}→${m[2]}`, file);
      }
    }

    const intruders: string[] = [];
    for (const file of files) {
      for (const m of read(file).matchAll(/seedRate\(\s*'([A-Z]{3})'\s*,\s*'([A-Z]{3})'/g)) {
        const pair = `${m[1]}→${m[2]}`;
        const owner = exclusive.get(pair);
        if (owner && owner !== file)
          intruders.push(`${file} сеет ${pair}, а её проверяет ${owner}`);
      }
    }
    expect(intruders).toEqual([]);
  });
});
