import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ru } from './ru.ts';

/**
 * Детектор мёртвых ключей (issue #105).
 *
 * Четыре пустых состояния были написаны в обеих локалях и не подключены ни к одному экрану:
 * `acc.empty`, `rev.empty`, `forecast.empty`, `plan.empty.subtitle`. Панели вместо приглашения к
 * действию просто исчезали, а тексты для них лежали мёртвыми — и заметить это было нечем.
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

/**
 * Известный долг: ключи, оставшиеся от прежних экранов (issue #108). Список может только
 * уменьшаться — новый мёртвый ключ обязан ронять тест сразу, пока автор ещё помнит, зачем писал
 * текст. Замораживать находку списком честнее, чем выключать детектор до лучших времён.
 */
const KNOWN_DEAD = new Set([
  'acc.byCurrency',
  'brand.name',
  'common.back',
  'common.done',
  'common.skip',
  'exec.confirm',
  'exec.hint',
  'exec.status.partial',
  'exec.status.pending',
  'exec.status.skipped',
  'fx.official',
  'income.extra.hint',
  'income.extra.irregular',
  'income.extra.irregularNote',
  'income.extra.oneOff',
  'income.extra.sideGig',
  'income.extra.title',
  'obl.title',
  'obl.tooBig',
  'onboarding.buckets.subtitle',
  'onboarding.buckets.title',
  'onboarding.debts.subtitle',
  'onboarding.debts.title',
  'onboarding.finish',
  'placeholder.soon',
  'plan.empty.subtitle',
  'plan.hero.canSpend',
  'plan.hero.perDay',
  'plan.money',
  'plan.overspent.note',
  'plan.summary.committed',
  'plan.summary.free',
  'plan.summary.income',
  'plan.summary.remaining',
  'plan.summary.spent',
  'receipt.done',
  'set.defaultSpread',
  'set.rateSource',
  'settings.sources',
  'settings.title',
  'spend.smart.parsed',
  'stats.median',
  'stats.signal.compressed',
  'stats.signal.overspent',
  'stats.title',
]);

describe('словарь не копит мёртвые ключи', () => {
  it('новых мёртвых ключей не появилось', () => {
    const code = sourceText(WEB_SRC);
    const prefixes = dynamicPrefixes(code);
    const unused = Object.keys(ru).filter(
      (key) => !code.includes(key) && !prefixes.some((p) => key.startsWith(p)),
    );
    expect(unused.filter((key) => !KNOWN_DEAD.has(key))).toEqual([]);
  });

  it('список долга не протух: всё в нём действительно мертво', () => {
    // Иначе список превращается в свалку и перестаёт что-либо значить.
    const code = sourceText(WEB_SRC);
    const prefixes = dynamicPrefixes(code);
    const alive = [...KNOWN_DEAD].filter(
      (key) => code.includes(key) || prefixes.some((p) => key.startsWith(p)),
    );
    expect(alive).toEqual([]);
  });
});
