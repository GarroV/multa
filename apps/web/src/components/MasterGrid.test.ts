import { describe, expect, it } from 'vitest';
import { monthBandsOf } from './MasterGrid.tsx';

/**
 * Полосы месяцев над колонками таблицы (запрос владельца 16.08.2026).
 *
 * Периоды короче месяца, и шесть дат подряд читаются как ровный ряд, где не за что зацепиться
 * глазом. Полоса возвращает календарь: месяц объединяет свои колонки, текущий подсвечен.
 *
 * Проверяется арифметика границ, а не внешний вид: именно она ломается молча, когда период
 * переваливает через конец месяца или когда горизонт растянут на год.
 */
describe('полосы месяцев', () => {
  it('два периода одного месяца сливаются в одну полосу', () => {
    const bands = monthBandsOf(
      [{ startsOn: '2026-08-10' }, { startsOn: '2026-08-25' }],
      '2026-08-16',
    );
    expect(bands).toHaveLength(1);
    expect(bands[0]!.span).toBe(2);
    expect(bands[0]!.month).toBe(8);
  });

  it('период относится к месяцу своего начала, даже если кончается в следующем', () => {
    /*
     * Выплата с 25.08 по 09.09 — это «за август»: так её называет человек, и так же считает
     * остальной продукт. Относить её к сентябрю значило бы показать в сентябре деньги, которых там
     * ещё нет.
     */
    const bands = monthBandsOf(
      [{ startsOn: '2026-08-25' }, { startsOn: '2026-09-10' }],
      '2026-08-16',
    );
    expect(bands.map((b) => b.month)).toEqual([8, 9]);
    expect(bands.map((b) => b.span)).toEqual([1, 1]);
  });

  it('подсвечен ровно текущий месяц, и только он', () => {
    const bands = monthBandsOf(
      [{ startsOn: '2026-08-10' }, { startsOn: '2026-09-10' }, { startsOn: '2026-10-09' }],
      '2026-09-01',
    );
    expect(bands.filter((b) => b.isCurrent).map((b) => b.month)).toEqual([9]);
  });

  it('тот же месяц другого года — отдельная полоса', () => {
    // Горизонт до 24 периодов дотягивается до следующего года: август 2026 и август 2027 разные.
    const bands = monthBandsOf(
      [{ startsOn: '2026-08-10' }, { startsOn: '2027-08-10' }],
      '2026-08-16',
    );
    expect(bands).toHaveLength(2);
    expect(bands.filter((b) => b.isCurrent)).toHaveLength(1);
  });

  it('пустой горизонт не даёт полос', () => {
    expect(monthBandsOf([], '2026-08-16')).toEqual([]);
  });

  it('сумма полос равна числу колонок: ни одна не потеряна и не задвоена', () => {
    const periods = [
      { startsOn: '2026-08-10' },
      { startsOn: '2026-08-25' },
      { startsOn: '2026-09-10' },
      { startsOn: '2026-09-25' },
      { startsOn: '2026-10-09' },
    ];
    const total = monthBandsOf(periods, '2026-08-16').reduce((sum, b) => sum + b.span, 0);
    expect(total).toBe(periods.length);
  });
});
