import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ru } from './ru.ts';

/**
 * Детектор мёртвых ключей (issue #105).
 *
 * Четыре пустых состояния были написаны в обеих локалях и не подключены ни к одному экрану:
 * панели вместо приглашения к действию просто исчезали, а тексты для них лежали мёртвыми — и
 * заметить это было нечем. Детектор нашёл ещё 41 такой ключ, оставшийся от прежних экранов; они
 * удалены (#108), поэтому список-поблажка больше не нужен и проверка строгая.
 *
 * Тест ищет каждый ключ по исходникам веба как подстроку. Способ грубый, зато не ломается от
 * `t('a.b')` против `t(\`a.${x}\`)`: семейства динамических ключей вычитываются из кода.
 * Ложное «используется» тут дешевле ложной тревоги — цель поймать забытый текст, а не устроить
 * борьбу с линтером.
 */

const WEB_SRC = fileURLToPath(new URL('../../../apps/web/src', import.meta.url));

/**
 * Семейства ключей, которые собираются шаблоном (`t(\`signal.${rule}.title\`)`), вычитываются из
 * самого кода, а не из списка руками: список пришлось бы поддерживать, он бы отстал, и детектор
 * начал бы врать — ровно та болезнь, которую он лечит.
 */
function dynamicPrefixes(code: string): string[] {
  return [...code.matchAll(/`([a-zA-Z][\w.]*\.)\$\{/g)].map((m) => m[1]!);
}

function sourceText(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out += sourceText(path);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    out += readFileSync(path, 'utf8');
  }
  return out;
}

describe('словарь не копит мёртвые ключи', () => {
  it('мёртвых ключей нет', () => {
    const code = sourceText(WEB_SRC);
    const prefixes = dynamicPrefixes(code);
    const unused = Object.keys(ru).filter(
      (key) => !code.includes(key) && !prefixes.some((p) => key.startsWith(p)),
    );
    expect(unused).toEqual([]);
  });
});
