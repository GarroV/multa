import type { RepeatRule } from '@multa/core';
import type { TranslationKey } from '@multa/i18n';

/**
 * Подписи правил повтора: «14-го числа», «каждый второй вторник», «раз в год, 3 марта».
 *
 * Вынесено из панели регулярных платежей (issue #154): те же подписи понадобились в форме правки
 * строки, а вторая копия switch'а по видам правила разошлась бы с первой при первом же изменении —
 * и одно и то же расписание называлось бы на двух экранах по-разному.
 *
 * Здесь только слова: сами правила выводит ядро (`repeatRuleCandidates`) — это календарная
 * арифметика, ей не место в React (правило 4).
 */

const WEEKDAY_KEYS: TranslationKey[] = [
  'rec.wd.0',
  'rec.wd.1',
  'rec.wd.2',
  'rec.wd.3',
  'rec.wd.4',
  'rec.wd.5',
  'rec.wd.6',
];

/**
 * Месяц словом. Числом дату года записать нельзя: «12.9» читается как 12 сентября в одном языке и
 * как 9 декабря в другом, а платёж раз в год промахиваться на три месяца не должен.
 */
const MONTH_KEYS: TranslationKey[] = [
  'rec.mon.1',
  'rec.mon.2',
  'rec.mon.3',
  'rec.mon.4',
  'rec.mon.5',
  'rec.mon.6',
  'rec.mon.7',
  'rec.mon.8',
  'rec.mon.9',
  'rec.mon.10',
  'rec.mon.11',
  'rec.mon.12',
];

const NTH_KEYS: Record<string, TranslationKey> = {
  '1': 'rec.nth.1',
  '2': 'rec.nth.2',
  '3': 'rec.nth.3',
  '4': 'rec.nth.4',
  '-1': 'rec.nth.last',
};

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** Подпись правила: собирается из ключей, потому что род и число зависят от языка (правило 5). */
export function repeatRuleLabel(rule: RepeatRule, t: Translate): string {
  switch (rule.kind) {
    case 'monthly-days':
      return t('rec.rule.monthly', { day: rule.days[0] ?? 1 });
    case 'monthly-nth-weekday':
      return t('rec.rule.nthWeekday', {
        nth: t(NTH_KEYS[String(rule.nth)] ?? 'rec.nth.1'),
        weekday: t(WEEKDAY_KEYS[rule.weekday] ?? 'rec.wd.0'),
      });
    case 'every-weeks':
      return rule.weeks === 1 ? t('rec.rule.weekly') : t('rec.rule.biweekly');
    case 'yearly':
      return t('rec.rule.yearly', {
        date: `${rule.day} ${t(MONTH_KEYS[rule.month - 1] ?? 'rec.mon.1')}`,
      });
    case 'each-payout':
      return t('rec.rule.eachPayout');
  }
}

/** Подпись сохранённого расписания: те же формулировки, что в редакторе. */
export function scheduleLabel(
  schedule: { kind: string; [key: string]: unknown },
  t: Translate,
): string {
  switch (schedule.kind) {
    case 'monthly-days':
    case 'monthly-nth-weekday':
    case 'every-weeks':
    case 'yearly':
    case 'each-payout':
      return repeatRuleLabel(schedule as unknown as RepeatRule, t);
    case 'one-off':
      return String((schedule as { date?: string }).date ?? '—');
    default:
      return t('rec.rule.irregular');
  }
}
