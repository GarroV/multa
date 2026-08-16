import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Сторож журнала миграций (issue #116).
 *
 * Drizzle применяет миграцию, только если её метка `when` больше времени последней применённой.
 * Метка меньше предыдущей означает, что миграция будет МОЛЧА пропущена: ни ошибки, ни красного
 * лога — «миграции применены» пишется как обычно, а таблицы просто нет.
 *
 * Именно так и вышло с 0022: рукописные 0018-0021 проставили себе круглые метки на день-два
 * вперёд, drizzle-kit выдал новой миграции настоящее время — и оно оказалось меньше. Поймали
 * только живым запросом к ручке после выката; health и код ответа без входа ничего не показывали.
 *
 * Проверка ловит ровно этот случай и стоит копейки: порядок меток обязан совпадать с порядком
 * миграций.
 */
describe('журнал миграций', () => {
  const journal = JSON.parse(
    readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: { idx: number; tag: string; when: number }[] };

  it('метки идут строго по возрастанию: иначе миграция молча пропускается', () => {
    const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
    const broken = ordered
      .filter((e, i) => i > 0 && e.when <= ordered[i - 1]!.when)
      .map((e) => e.tag);
    expect(broken).toEqual([]);
  });

  it('на каждый файл миграции есть запись в журнале', async () => {
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(new URL('../migrations', import.meta.url))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace('.sql', ''))
      .sort();
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(files);
  });
});
