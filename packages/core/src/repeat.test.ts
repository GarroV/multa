import { describe, expect, it } from 'vitest';
import { nthWeekdayDatesBetween, repeatRuleCandidates, yearlyDatesBetween } from './repeat.ts';

/**
 * Новые правила повтора (issue #55): «второй вторник месяца», «ежегодно» и вывод вариантов из
 * выбранной даты.
 *
 * Правило, определяющее весь модуль: **правило не имеет права молча не сработать**. Пятый вторник
 * бывает не каждый месяц, 29 февраля — не каждый год; если такое правило просто не даёт даты,
 * платёж исчезает из плана без единого сигнала. Поэтому «пятая неделя» хранится как «последняя»,
 * а несуществующий день года прижимается к концу месяца.
 */

describe('nthWeekdayDatesBetween', () => {
  it('находит N-й день недели месяца', () => {
    // Второй вторник июля 2026: 7 июля вторник, значит второй — 14-е.
    expect(nthWeekdayDatesBetween(2, 2, '2026-07-01', '2026-07-31')).toEqual(['2026-07-14']);
  });

  it('первый день недели месяца может быть первым числом', () => {
    // 1 июля 2026 — среда.
    expect(nthWeekdayDatesBetween(1, 3, '2026-07-01', '2026-07-31')).toEqual(['2026-07-01']);
  });

  it('«последний» (-1) берёт последнее вхождение, сколько бы их ни было', () => {
    // Вторники июля 2026: 7, 14, 21, 28.
    expect(nthWeekdayDatesBetween(-1, 2, '2026-07-01', '2026-07-31')).toEqual(['2026-07-28']);
    // В сентябре 2026 вторников пять: 1, 8, 15, 22, 29.
    expect(nthWeekdayDatesBetween(-1, 2, '2026-09-01', '2026-09-30')).toEqual(['2026-09-29']);
  });

  it('пятого вхождения не существует как правила: его роль играет «последний»', () => {
    /*
     * Из-за этого правило и хранится как -1. nth=5 в месяце с четырьмя вторниками дал бы пустоту:
     * платёж пропал бы из плана, и человек узнал бы об этом от банка, а не от Multa.
     */
    expect(nthWeekdayDatesBetween(5, 2, '2026-07-01', '2026-07-31')).toEqual([]);
    expect(nthWeekdayDatesBetween(-1, 2, '2026-07-01', '2026-07-31')).toEqual(['2026-07-28']);
  });

  it('идёт по всем месяцам окна, а не только по первому', () => {
    expect(nthWeekdayDatesBetween(1, 1, '2026-07-01', '2026-09-30')).toEqual([
      '2026-07-06',
      '2026-08-03',
      '2026-09-07',
    ]);
  });

  it('окно режется по краям, а не по месяцам', () => {
    expect(nthWeekdayDatesBetween(2, 2, '2026-07-15', '2026-08-20')).toEqual(['2026-08-11']);
  });
});

describe('yearlyDatesBetween', () => {
  it('даёт одну дату в год', () => {
    expect(yearlyDatesBetween(3, 15, '2026-01-01', '2028-01-01')).toEqual([
      '2026-03-15',
      '2027-03-15',
    ]);
  });

  it('29 февраля в невисокосном году прижимается к 28-му, а не пропадает', () => {
    // Страховка, оплаченная 29 февраля, обязана напомнить о себе и в обычный год.
    expect(yearlyDatesBetween(2, 29, '2026-01-01', '2027-01-01')).toEqual(['2026-02-28']);
    expect(yearlyDatesBetween(2, 29, '2028-01-01', '2029-01-01')).toEqual(['2028-02-29']);
  });

  it('дата вне окна не отдаётся', () => {
    expect(yearlyDatesBetween(3, 15, '2026-04-01', '2026-12-31')).toEqual([]);
  });
});

describe('repeatRuleCandidates', () => {
  /*
   * Человек выбирает первую дату, а варианты повтора выводятся из неё — как в календарях. Считает
   * это ядро: определить, что 14 июля 2026 это «второй вторник», значит сделать календарную
   * арифметику, а ей в React не место (правило 4).
   */
  it('из даты выводит месячное число, день недели и «N-й день недели»', () => {
    const rules = repeatRuleCandidates('2026-07-14');
    expect(rules).toContainEqual({ kind: 'monthly-days', days: [14] });
    expect(rules).toContainEqual({ kind: 'every-weeks', weeks: 1, startsOn: '2026-07-14' });
    expect(rules).toContainEqual({ kind: 'every-weeks', weeks: 2, startsOn: '2026-07-14' });
    expect(rules).toContainEqual({ kind: 'monthly-nth-weekday', nth: 2, weekday: 2 });
    expect(rules).toContainEqual({ kind: 'yearly', month: 7, day: 14 });
    expect(rules).toContainEqual({ kind: 'each-payout' });
  });

  it('дата пятой недели предлагает «последний», а не «пятый»', () => {
    // 29 сентября 2026 — пятый вторник месяца; такого правила не существует.
    const rules = repeatRuleCandidates('2026-09-29');
    expect(rules).toContainEqual({ kind: 'monthly-nth-weekday', nth: -1, weekday: 2 });
    // Тип уже запрещает пятёрку, но проверяем и значением: правило не должно появиться и в рантайме.
    expect(rules.some((r) => r.kind === 'monthly-nth-weekday' && (r.nth as number) === 5)).toBe(
      false,
    );
  });

  it('дата последней недели тоже предлагает «последний», если пятого такого дня в месяце нет', () => {
    // 28 июля 2026 — четвёртый и одновременно последний вторник июля.
    const rules = repeatRuleCandidates('2026-07-28');
    expect(rules).toContainEqual({ kind: 'monthly-nth-weekday', nth: -1, weekday: 2 });
  });
});
