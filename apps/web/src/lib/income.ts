/**
 * Чистые хелперы формы дохода: состояние формы → payload API, превью реальных дат.
 * Доменной логики в компонентах не держим (железное правило 4) — даты считает @multa/core
 * теми же функциями, что и сервер, поэтому превью не может разойтись с планом.
 */

import { fromMajor, generatePeriods, type PeriodConfig, type WeekendRule } from '@multa/core';

export type RhythmKind = 'twiceMonthly' | 'monthly' | 'everyWeeks';

export interface RhythmForm {
  kind: RhythmKind;
  days: number[];
  weeks: number;
  anchorDate: string;
  weekendRule: WeekendRule;
}

export interface PayoutForm {
  label: string;
  day: number;
  amount: string;
  percent: string;
}

export interface SourcePayload {
  label: string;
  currency: string;
  schedule: unknown;
  amount: unknown;
  stability: 'fixed' | 'variable';
  active: boolean;
  sort: number;
}

/** Форма ритма → PeriodConfig ядра. Дата якоря для цикла недель — ввод пользователя, не «сегодня». */
export function rhythmToConfig(form: RhythmForm): PeriodConfig {
  if (form.kind === 'everyWeeks') {
    return {
      kind: 'every-weeks',
      weeks: form.weeks,
      startsOn: form.anchorDate,
      weekendRule: form.weekendRule,
    };
  }
  const days = form.kind === 'monthly' ? form.days.slice(0, 1) : form.days;
  return {
    kind: 'monthly-days',
    days: [...new Set(days)].sort((a, b) => a - b),
    weekendRule: form.weekendRule,
  };
}

/** Ритм для API: без weekendRule — сервер склеивает его сам, чтобы правило жило в одном месте. */
export function rhythmToPayload(form: RhythmForm): Record<string, unknown> {
  const { weekendRule: _rule, ...rest } = rhythmToConfig(form) as Record<string, unknown> & {
    weekendRule?: unknown;
  };
  return rest;
}

/**
 * Ближайшие даты выплат, которые реально сгенерит планировщик.
 * Границы периодов и есть даты выплат; первый период содержит `from` и начинается раньше него,
 * поэтому берём все границы и отбрасываем прошедшие — превью про будущее, а не про историю.
 */
export function previewDates(form: RhythmForm, from: string, count = 3): string[] {
  const periods = generatePeriods(rhythmToConfig(form), from, count + 2);
  const boundaries = periods.flatMap((p) => [p.startsOn, p.endsOn]);
  return [...new Set(boundaries)].filter((d) => d >= from).slice(0, count);
}

/** major-строка → minor units или null (не подставляем 0 молча). */
function toMinor(value: string, currency: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    return fromMajor(s, currency).minor.toString();
  } catch {
    return null;
  }
}

/** Выплаты формы → источники дохода. Невалидные строки отбрасываются, а не превращаются в нули. */
export function payoutsToSources(
  payouts: readonly PayoutForm[],
  opts: { currency: string; usePercent: boolean; gross: string },
): SourcePayload[] {
  const grossMinor = opts.usePercent ? toMinor(opts.gross, opts.currency) : null;
  const out: SourcePayload[] = [];
  for (const payout of payouts) {
    const label = payout.label.trim();
    if (!label) continue;
    let amount: unknown;
    if (opts.usePercent) {
      const pct = payout.percent.trim().replace(',', '.');
      if (!grossMinor || !/^\d+(\.\d+)?$/.test(pct) || Number(pct) <= 0 || Number(pct) > 100) continue;
      amount = { kind: 'percent', percent: pct, ofMinor: grossMinor };
    } else {
      const amountMinor = toMinor(payout.amount, opts.currency);
      if (!amountMinor || amountMinor === '0') continue;
      amount = { kind: 'absolute', amountMinor };
    }
    out.push({
      label,
      currency: opts.currency,
      schedule: { kind: 'monthly-days', days: [payout.day] },
      amount,
      stability: 'fixed',
      active: true,
      sort: out.length,
    });
  }
  return out;
}

/** Сумма процентов выплат — для информационной подсказки (жёсткой валидации нет). */
export function percentSum(payouts: readonly PayoutForm[]): number {
  return payouts.reduce((acc, p) => {
    const pct = Number(p.percent.trim().replace(',', '.'));
    return acc + (Number.isFinite(pct) ? pct : 0);
  }, 0);
}
