/**
 * Сигналы как сущность (issue #50).
 *
 * До этого «сигналы» были разметкой: экран статистики руками склеивал четыре разнородных
 * источника, сам выбирал тон и не давал ни одной кнопки. Такой список — шум: он сообщает, но не
 * помогает.
 *
 * Здесь сигнал — доменный объект: правило, severity, метрика и **хотя бы одно действие**. Сигнал
 * без действия наружу не выходит: если человеку нечего сделать, сообщение только портит
 * настроение (тон штурмана, 06-design-system §Тон).
 *
 * Текст здесь не собирается. Наружу идут `rule`, метрика и параметры — формулировку берёт i18n по
 * ключу `signal.<rule>.*`: собранная на сервере строка проехала бы мимо словаря (правило 5).
 *
 * Пороги приходят аргументом и нигде не зашиты: иначе настройки воркспейса врали бы.
 */

import type { BurnRate } from './signals.ts';
import { daysBetween } from './periods.ts';
import type { PayPeriod } from './periods.ts';

export type SignalSeverity = 'risk' | 'attention' | 'opportunity';

export type SignalRule =
  | 'burn_rate'
  | 'overspent'
  | 'compressed'
  | 'median_overrun'
  | 'volatile_category'
  | 'locked_share'
  | 'runway'
  | 'freed_money'
  | 'goal_at_risk'
  | 'debt_closing';

/** Метрика сигнала: одна цифра, ради которой он и показан. */
export type SignalMetric =
  | { readonly kind: 'money'; readonly minor: bigint; readonly currency: string }
  /** Доля в базисных пунктах: проценты во float в этом продукте не живут. */
  | { readonly kind: 'percent'; readonly bp: number }
  | { readonly kind: 'days'; readonly days: number }
  | { readonly kind: 'date'; readonly on: string };

/**
 * Что человек может сделать прямо из сигнала. Все виды ложатся на уже существующие мутации —
 * новых способов менять деньги сигналы не изобретают.
 */
export type SignalAction =
  /** Открыть пересборку плана для категории: «откуда добавим». */
  | { readonly kind: 'rebalance'; readonly targetId: string }
  /** Поставить категории конкретный бюджет (медиану факта). */
  | { readonly kind: 'set_budget'; readonly targetId: string; readonly amountMinor: bigint }
  /** Пропустить взнос в цель в этом периоде (issue #54). */
  | { readonly kind: 'freeze_goal'; readonly targetId: string }
  /** Перейти на экран, где с этим работают. */
  | { readonly kind: 'open'; readonly screen: 'plan' | 'statistics' | 'obligations' };

export interface Signal {
  /** Стабильный между запросами: список не должен прыгать при перерисовке. */
  readonly id: string;
  readonly rule: SignalRule;
  readonly severity: SignalSeverity;
  readonly metric: SignalMetric;
  /** Значения для подстановки в строку словаря. Только числа и строки — не готовый текст. */
  readonly params: Readonly<Record<string, string | number>>;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly actions: readonly SignalAction[];
}

export interface SignalCategory {
  readonly id: string;
  readonly name: string;
  readonly plannedMinor: bigint;
  readonly medianMinor: bigint;
  readonly verdict: 'unknown' | 'stable' | 'raise' | 'lower' | 'volatile' | 'unplanned';
  readonly deltaPct: number | null;
}

export interface SignalForecastEvent {
  readonly kind: 'debt_closed' | 'freed_money' | 'goal_reached' | 'goal_at_risk';
  readonly targetId: string;
  readonly name: string;
  readonly on: string;
  readonly amountMinor?: bigint;
}

export interface SignalsInput {
  readonly asOf: string;
  readonly period: PayPeriod;
  readonly baseCurrency: string;
  readonly burn: BurnRate;
  readonly livingMinor: bigint;
  readonly overspentMinor: bigint;
  readonly compressedMinor: bigint;
  readonly incomeMinor: bigint;
  /** Сколько из дохода связано обязательствами: долги, корзины, конверты, цели. */
  readonly lockedMinor: bigint;
  /** Всего денег в базовой валюте; null — неизвестно (нет счетов или курса). */
  readonly balancesBaseMinor: bigint | null;
  readonly categories: readonly SignalCategory[];
  readonly forecast: readonly SignalForecastEvent[];
}

export interface SignalThresholds {
  /** За сколько дней до конца периода «деньги кончатся раньше» перестаёт быть риском. */
  readonly burnThresholdDays: number;
  /** Запас хода ниже этого — сигнал. */
  readonly runwayWarnDays: number;
  /** Доля связанных денег выше этой — сигнал. */
  readonly lockedWarnPct: number;
  /** Сколько сигналов показывать: длинный список перестают читать. */
  readonly maxSignals: number;
}

/** Вес severity для сортировки: риск читают первым. */
const SEVERITY_ORDER: Record<SignalSeverity, number> = { risk: 0, attention: 1, opportunity: 2 };

/** Величина метрики для сортировки внутри тона. Меньше дней — острее, поэтому знак меняется. */
function magnitude(metric: SignalMetric): number {
  switch (metric.kind) {
    case 'money':
      return Number(metric.minor);
    case 'percent':
      return metric.bp;
    case 'days':
      return -metric.days;
    case 'date':
      // Дата сама по себе не «больше» и не «меньше»: её место определяет только severity.
      return 0;
  }
}

export function buildSignals(input: SignalsInput, thresholds: SignalThresholds): Signal[] {
  const { baseCurrency: currency } = input;
  const out: Signal[] = [];

  // --- Темп трат: деньги кончатся раньше выплаты ---
  if (!input.burn.willLast && input.burn.runsOutOn) {
    /*
     * Порог из настроек решает, риск это или внимание. «Кончатся за день до выплаты» и «кончатся
     * за неделю» требуют разного: поджаться или пересобрать план. До issue #50 настройка
     * `burnThresholdDays` существовала в схеме, но её не читал ни один участок кода.
     */
    const slack = daysBetween(input.burn.runsOutOn, input.period.endsOn);
    out.push({
      id: 'burn_rate:period',
      rule: 'burn_rate',
      severity: slack > thresholds.burnThresholdDays ? 'risk' : 'attention',
      metric: { kind: 'date', on: input.burn.runsOutOn },
      params: { date: input.burn.runsOutOn, perDayMinor: input.burn.perDayMinor.toString() },
      actions: [{ kind: 'open', screen: 'plan' }],
    });
  }

  // --- Перерасход: план на жизнь уже пробит ---
  if (input.overspentMinor > 0n) {
    out.push({
      id: 'overspent:period',
      rule: 'overspent',
      severity: 'risk',
      metric: { kind: 'money', minor: input.overspentMinor, currency },
      params: { amountMinor: input.overspentMinor.toString() },
      actions: [{ kind: 'open', screen: 'plan' }],
    });
  }

  // --- Сжатие: денег не хватило и каскад срезал добровольное ---
  if (input.compressedMinor > 0n) {
    out.push({
      id: 'compressed:period',
      rule: 'compressed',
      severity: 'attention',
      metric: { kind: 'money', minor: input.compressedMinor, currency },
      params: { amountMinor: input.compressedMinor.toString() },
      actions: [{ kind: 'open', screen: 'plan' }],
    });
  }

  // --- Категории: медиана факта против плана ---
  for (const category of input.categories) {
    if (category.verdict === 'volatile') {
      /*
       * Нестабильную категорию нельзя «поднять до медианы»: медиана прыгающего ряда — не бюджет,
       * и поднять план по ней значит закрепить хаос. Поэтому действие только одно — разобраться.
       */
      out.push({
        id: `volatile_category:${category.id}`,
        rule: 'volatile_category',
        severity: 'attention',
        metric: { kind: 'money', minor: category.medianMinor, currency },
        params: { name: category.name, medianMinor: category.medianMinor.toString() },
        targetId: category.id,
        targetName: category.name,
        actions: [{ kind: 'open', screen: 'statistics' }],
      });
      continue;
    }
    if (category.verdict === 'raise' && category.medianMinor > category.plannedMinor) {
      out.push({
        id: `median_overrun:${category.id}`,
        rule: 'median_overrun',
        severity: 'attention',
        metric: {
          kind: 'money',
          minor: category.medianMinor - category.plannedMinor,
          currency,
        },
        params: {
          name: category.name,
          medianMinor: category.medianMinor.toString(),
          plannedMinor: category.plannedMinor.toString(),
          ...(category.deltaPct !== null ? { deltaPct: Math.round(category.deltaPct) } : {}),
        },
        targetId: category.id,
        targetName: category.name,
        // Два действия: принять медиану как бюджет или взять недостающее из другой строки.
        actions: [
          { kind: 'set_budget', targetId: category.id, amountMinor: category.medianMinor },
          { kind: 'rebalance', targetId: category.id },
        ],
      });
    }
  }

  // --- Доля зафиксированного: сколько дохода связано обязательствами ---
  if (input.incomeMinor > 0n && input.lockedMinor > 0n) {
    const bp = Number((input.lockedMinor * 10_000n) / input.incomeMinor);
    if (bp >= thresholds.lockedWarnPct * 100) {
      out.push({
        id: 'locked_share:period',
        rule: 'locked_share',
        severity: 'attention',
        metric: { kind: 'percent', bp },
        params: { pct: Math.round(bp / 100), amountMinor: input.lockedMinor.toString() },
        actions: [{ kind: 'open', screen: 'obligations' }],
      });
    }
  }

  // --- Запас хода: на сколько дней хватит остатка при текущем темпе ---
  if (input.balancesBaseMinor !== null && input.burn.perDayMinor > 0n) {
    const days = Number(input.balancesBaseMinor / input.burn.perDayMinor);
    if (days <= thresholds.runwayWarnDays) {
      out.push({
        id: 'runway:period',
        rule: 'runway',
        severity: days <= thresholds.runwayWarnDays / 2 ? 'risk' : 'attention',
        metric: { kind: 'days', days },
        params: { days, perDayMinor: input.burn.perDayMinor.toString() },
        actions: [{ kind: 'open', screen: 'plan' }],
      });
    }
  }

  // --- Прогноз: освободившиеся деньги, цель под риском, закрытие долга ---
  for (const event of input.forecast) {
    if (event.kind === 'freed_money') {
      out.push({
        id: `freed_money:${event.targetId}`,
        rule: 'freed_money',
        severity: 'opportunity',
        metric: { kind: 'money', minor: event.amountMinor ?? 0n, currency },
        params: {
          name: event.name,
          date: event.on,
          amountMinor: (event.amountMinor ?? 0n).toString(),
        },
        targetId: event.targetId,
        targetName: event.name,
        actions: [{ kind: 'open', screen: 'obligations' }],
      });
    }
    if (event.kind === 'goal_at_risk') {
      out.push({
        id: `goal_at_risk:${event.targetId}`,
        rule: 'goal_at_risk',
        severity: 'attention',
        metric: { kind: 'money', minor: event.amountMinor ?? 0n, currency },
        params: {
          name: event.name,
          date: event.on,
          amountMinor: (event.amountMinor ?? 0n).toString(),
        },
        targetId: event.targetId,
        targetName: event.name,
        // Заморозить взнос — честное решение: цель отодвинется, но план перестанет рваться.
        actions: [
          { kind: 'freeze_goal', targetId: event.targetId },
          { kind: 'open', screen: 'obligations' },
        ],
      });
    }
    if (event.kind === 'debt_closed') {
      out.push({
        id: `debt_closing:${event.targetId}`,
        rule: 'debt_closing',
        severity: 'opportunity',
        metric: { kind: 'date', on: event.on },
        params: { name: event.name, date: event.on },
        targetId: event.targetId,
        targetName: event.name,
        actions: [{ kind: 'open', screen: 'obligations' }],
      });
    }
  }

  // Сигнал без действия — шум: наружу такой не выходит.
  const actionable = out.filter((s) => s.actions.length > 0);

  const seen = new Set<string>();
  const unique = actionable.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));

  unique.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      magnitude(b.metric) - magnitude(a.metric) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // Режем хвост, а не голову: обрезанным оказывается наименее срочное.
  return unique.slice(0, Math.max(0, thresholds.maxSignals));
}
