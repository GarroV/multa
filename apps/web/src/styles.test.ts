import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Сторож против повторных объявлений одного селектора.
 *
 * Поставлен по факту собственной ошибки (16.08.2026): я объявил `.mgrid-foot` для строки подсказки
 * под таблицей, не заметив, что это имя с самого начала принадлежит группе итоговых строк. Правило
 * стояло ниже по файлу, победило её сетку — и «Свободный остаток» уехал в середину соседней строки.
 *
 * Такая поломка не выдаёт себя ничем: сборка проходит, типы зелёные, линтеры молчат. Видит её
 * только человек и только на своём экране — да и то не всегда: чтобы проявиться, ей понадобились
 * широкое окно И короткий горизонт таблицы одновременно.
 *
 * Проверка простая и потому надёжная: один селектор — одно место. Нужен другой набор свойств для
 * того же элемента — добавь его туда же, а не заводи второе правило в другом конце файла.
 */

/* Путь от корня пакета: `import.meta.url` в среде vitest не файловый. */
const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

/**
 * Верхнеуровневые селекторы: то, что объявлено вне медиазапросов.
 *
 * Внутри `@media` повторы законны и осмысленны — там правило намеренно переопределяют для другой
 * ширины экрана. Опасен именно повтор на одном уровне: он молча выигрывает по порядку в файле.
 */
function topLevelSelectors(source: string): string[] {
  const found: string[] = [];
  let depth = 0;

  for (const raw of source.split('\n')) {
    const line = raw.trim();
    const opens = (raw.match(/\{/g) ?? []).length;
    const closes = (raw.match(/\}/g) ?? []).length;

    // Правило верхнего уровня: открывается на нулевой глубине и не является @-правилом.
    if (depth === 0 && opens > 0 && !line.startsWith('@') && !line.startsWith('/*')) {
      const selector = line.slice(0, line.indexOf('{')).trim();
      if (selector) found.push(selector);
    }

    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
  return found;
}

describe('таблица стилей', () => {
  it('один селектор объявлен ровно в одном месте', () => {
    const counts = new Map<string, number>();
    for (const selector of topLevelSelectors(css)) {
      counts.set(selector, (counts.get(selector) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()]
      .filter(([, times]) => times > 1)
      .map(([selector, times]) => `${selector} — ${times} раза`);

    expect(duplicated).toEqual([]);
  });
});
