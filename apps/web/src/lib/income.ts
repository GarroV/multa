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

const DEFAULT_DAYS = [10, 25];

/**
 * Нормализует числа при смене вида ритма: «два раза в месяц» требует ровно двух чисел,
 * «раз в месяц» — одного. Иначе после переключения ритм молча остался бы однодневным.
 */
export function withRhythmKind(form: RhythmForm, kind: RhythmKind): RhythmForm {
  if (kind === 'twiceMonthly') {
    const days = [form.days[0] ?? DEFAULT_DAYS[0]!, form.days[1] ?? DEFAULT_DAYS[1]!];
    return { ...form, kind, days: days[0] === days[1] ? DEFAULT_DAYS : days };
  }
  if (kind === 'monthly') return { ...form, kind, days: [form.days[0] ?? DEFAULT_DAYS[0]!] };
  return { ...form, kind };
}

/** Дата выплаты по-человечески («10 авг.») — и в превью, и в предупреждениях. */
export function formatPayday(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));
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
      if (!grossMinor || !/^\d+(\.\d+)?$/.test(pct) || Number(pct) <= 0 || Number(pct) > 100)
        continue;
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

/** Вид ритма отдельного источника — шире ритма периода: доход бывает чаще, чем период. */
export type SourceKind = 'monthly' | 'daily' | 'weekly';

export interface SourceDraft {
  label: string;
  kind: SourceKind;
  /** Число месяца — для `monthly`. */
  day: number;
  /** День недели для `weekly`; 0 — воскресенье, как у `Date.getUTCDay`. */
  weekday: number;
  amount: string;
}

/**
 * Черновик формы → источник дохода.
 *
 * Ежедневный и недельный доход существуют отдельно от «когда как»: смена, такси и торговля
 * предсказуемы частотой, а не датами, и обязаны попадать в план — иначе у человека нет цифры дня,
 * ради которой он и пришёл. Сумма при этом означает «за раз», а не «за период».
 *
 * `variable` у них не украшение: такой доход плавает от дня ко дню, и выдавать его за оклад
 * значило бы обещать точность, которой нет.
 */
export function draftToSource(
  draft: SourceDraft,
  opts: { currency: string; sort?: number },
): SourcePayload | null {
  const label = draft.label.trim();
  if (!label) return null;
  const amountMinor = toMinor(draft.amount, opts.currency);
  if (!amountMinor || amountMinor === '0') return null;

  const schedule =
    draft.kind === 'daily'
      ? { kind: 'daily' }
      : draft.kind === 'weekly'
        ? { kind: 'weekly', weekday: draft.weekday }
        : { kind: 'monthly-days', days: [draft.day] };

  return {
    label,
    currency: opts.currency,
    schedule,
    amount: { kind: 'absolute', amountMinor },
    stability: draft.kind === 'monthly' ? 'fixed' : 'variable',
    active: true,
    sort: opts.sort ?? 0,
  };
}

/** Как приходят деньги — вопрос первого экрана, шире, чем «по каким числам». */
export type IncomeMode = 'monthly' | 'weekly' | 'daily';

export interface OnboardingIncomeForm {
  mode: IncomeMode;
  label: string;
  amount: string;
  /** Для `weekly`; 0 — воскресенье, как у `Date.getUTCDay`. */
  weekday: number;
}

/**
 * Шаг дохода для несистемного заработка: источник плюс ритм периода.
 *
 * Первый экран спрашивал «по каким числам тебе платят» — вопрос, у которого для смен, такси и
 * торговли нет ответа. Живой тестер (2026-08-05) на этом шаге и остановился.
 *
 * Ключевое отличие от `payoutsToSources`: там даты выплат ЗАДАЮТ границы периодов, здесь их задать
 * нечем — выплата каждый день. Поэтому период берётся отдельным решением: двухнедельные отрезки от
 * сегодня. Это честный дефолт, а не догадка о заработке; сменить его можно в настройках, и текст
 * шага об этом говорит прямо.
 */
export function onboardingIncome(
  form: OnboardingIncomeForm,
  opts: { currency: string; today: string },
): {
  sources: SourcePayload[];
  rhythm: Record<string, unknown>;
  weekendRule: WeekendRule;
} | null {
  const source = draftToSource(
    { label: form.label, kind: form.mode, day: 1, weekday: form.weekday, amount: form.amount },
    { currency: opts.currency },
  );
  if (!source) return null;
  return {
    sources: [source],
    rhythm: { kind: 'every-weeks', weeks: 2, startsOn: opts.today },
    // Деньги приходят и в субботу — переносить такой доход с выходных не на что.
    weekendRule: 'as-is',
  };
}

/** Сумма процентов выплат — для информационной подсказки (жёсткой валидации нет). */
export function percentSum(payouts: readonly PayoutForm[]): number {
  return payouts.reduce((acc, p) => {
    const pct = Number(p.percent.trim().replace(',', '.'));
    return acc + (Number.isFinite(pct) ? pct : 0);
  }, 0);
}

/**
 * Сколько выплат уложится между сегодня и сроком — столькими взносами и закрывается долг.
 *
 * Считается по ритму воркспейса теми же функциями ядра, что и план: иначе «шесть платежей» в форме
 * и пять колонок в таблице разошлись бы, и человек не понял бы, какой цифре верить.
 *
 * Границы: сам срок включается (закрыть «к 10 мая» — значит последний взнос 10 мая уместен),
 * а сегодняшняя выплата — нет, она уже прошла.
 */
export function periodsUntil(
  rhythm: unknown,
  weekendRule: WeekendRule,
  from: string,
  until: string,
): number {
  if (until <= from) return 0;
  const config = { ...(rhythm as Record<string, unknown>), weekendRule } as PeriodConfig;
  try {
    // 60 периодов — пять лет полумесячного ритма: дальше горизонта планирования нет смысла.
    const periods = generatePeriods(config, from, 60);
    return periods.filter((p) => p.startsOn > from && p.startsOn <= until).length;
  } catch {
    return 0;
  }
}
