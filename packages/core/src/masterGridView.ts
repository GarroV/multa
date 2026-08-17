import type { MasterGridParse } from './importXlsx.ts';

/**
 * Сводка плана из Excel для предпросмотра (issue #124).
 *
 * Разбор `parseMasterGrid` был готов и покрыт тестами, но не вызывался ниоткуда — эталон владельца в
 * продукт не заезжал. Шаг записи требует его решения: файл даёт имена строк, а не их природу («Сбер»
 * это кредит, «Отпуск» это цель), и угадывать нельзя — ошибка развела бы долг и категорию по разные
 * стороны каскада, где один неприкосновенен, а другую режут при нехватке.
 *
 * Предпросмотр решений не требует и нужен именно для них: человек видит, что продукт понял в его
 * файле, и раскладывает строки по фактам, а не по памяти.
 *
 * Деньги наружу уходят строками, как во всём API: `bigint` в JSON не сериализуется.
 */

export interface MasterGridLineSummary {
  readonly name: string;
  readonly medianMinor: string;
  /** В скольких периодах реально платили: разовую покупку видно именно по этому числу. */
  readonly paidPeriods: number;
  readonly totalMinor: string;
}

export interface MasterGridSummary {
  readonly periods: number;
  readonly from: string | null;
  readonly to: string | null;
  readonly incomeTotalMinor: string;
  readonly lines: MasterGridLineSummary[];
}

export function masterGridSummary(parsed: MasterGridParse): MasterGridSummary {
  const sum = (amounts: readonly bigint[]): bigint => amounts.reduce((a, b) => a + b, 0n);

  return {
    periods: parsed.periods.length,
    from: parsed.periods[0] ?? null,
    to: parsed.periods.at(-1) ?? null,
    /*
     * Доход — сумма ВСЕХ колонок, а не первой. При полумесячном ритме взять первую значило бы
     * занизить его ровно вдвое: ровно та ошибка, из-за которой разбор терял выплаты 25-го числа.
     */
    incomeTotalMinor: sum(parsed.income?.amountsMinor ?? []).toString(),
    lines: parsed.lines.map((line) => ({
      name: line.name,
      medianMinor: line.medianMinor.toString(),
      paidPeriods: line.paidPeriods,
      totalMinor: sum(line.amountsMinor).toString(),
    })),
  };
}
