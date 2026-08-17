import { describe, expect, it } from 'vitest';
import { masterGridSummary } from './masterGridView.ts';

/**
 * Сводка плана из Excel для предпросмотра (issue #124).
 *
 * Разбор `parseMasterGrid` был готов и покрыт тестами, но не вызывался ни из одной ручки: эталон
 * владельца в продукт не заезжал. Шаг записи требует его решения — файл даёт имена строк, а не их
 * природу («Сбер» это кредит, «Отпуск» это цель), и угадывать нельзя: ошибка развела бы долг и
 * категорию по разные стороны каскада.
 *
 * А вот предпросмотр решений не требует и нужен именно для них: человек видит, что продукт понял в
 * его файле, и решает раскладку по фактам, а не по памяти.
 */
const parsed = {
  periods: ['2024-10-10', '2024-10-25', '2024-11-10', '2024-11-25'],
  income: {
    name: 'Доход',
    amountsMinor: [11_041_700n, 4_698_000n, 10_124_600n, 4_600_000n],
    medianMinor: 7_411_300n,
    paidPeriods: 4,
  },
  lines: [
    {
      name: 'Сбер',
      amountsMinor: [1_000_000n, 1_000_000n, 906_500n, 1_300_000n],
      medianMinor: 1_000_000n,
      paidPeriods: 4,
    },
    {
      name: 'Оборудование',
      amountsMinor: [1_200_000n, 0n, 0n, 0n],
      medianMinor: 1_200_000n,
      paidPeriods: 1,
    },
  ],
};

describe('сводка плана из Excel', () => {
  it('считает размах периодов и их число', () => {
    const s = masterGridSummary(parsed);
    expect(s.periods).toBe(4);
    expect(s.from).toBe('2024-10-10');
    expect(s.to).toBe('2024-11-25');
  });

  it('доход за период — сумма всех колонок, а не первая', () => {
    // Полумесячный ритм: если взять первую колонку, доход занизится ровно вдвое.
    const s = masterGridSummary(parsed);
    expect(s.incomeTotalMinor).toBe('30464300');
  });

  it('строки отдаются с медианой и числом периодов, где платили', () => {
    /*
     * Медиана и «сколько раз платили» — то, по чему человек решает: регулярная это статья или
     * разовая покупка. Без второго числа разовое «Оборудование» выглядело бы как ежемесячное.
     */
    const s = masterGridSummary(parsed);
    expect(s.lines).toEqual([
      { name: 'Сбер', medianMinor: '1000000', paidPeriods: 4, totalMinor: '4206500' },
      { name: 'Оборудование', medianMinor: '1200000', paidPeriods: 1, totalMinor: '1200000' },
    ]);
  });

  it('пустой разбор не притворяется данными', () => {
    const s = masterGridSummary({ periods: [], income: null, lines: [] });
    expect(s).toEqual({ periods: 0, from: null, to: null, incomeTotalMinor: '0', lines: [] });
  });
});
