import { describe, expect, it } from 'vitest';
import {
  amountOfSource,
  expectedIncomeForPeriod,
  incomeEventsIn,
  percentOfMinor,
  rhythmMismatches,
  type IncomeSource,
} from './income.ts';
import { money, type Money } from './money.ts';
import type { PayPeriod } from './periods.ts';

/** Источник по умолчанию: RUB, активный, фиксированный. Тесты переопределяют нужные поля. */
function source(
  over: Partial<IncomeSource> & Pick<IncomeSource, 'id' | 'label' | 'schedule' | 'amount'>,
): IncomeSource {
  return { currency: 'RUB', stability: 'fixed', active: true, ...over };
}

const salary = source({
  id: 's1',
  label: 'Зарплата',
  schedule: { kind: 'monthly-days', days: [25] },
  amount: { kind: 'absolute', amountMinor: 12_000_000n },
});
const advance = source({
  id: 's2',
  label: 'Аванс',
  schedule: { kind: 'monthly-days', days: [10] },
  amount: { kind: 'absolute', amountMinor: 8_000_000n },
});
const sideGig = source({
  id: 's3',
  label: 'Подработка',
  schedule: { kind: 'every-weeks', weeks: 1, startsOn: '2026-07-03' }, // пятницы
  amount: { kind: 'absolute', amountMinor: 1_500_000n },
  stability: 'variable',
});

const july: PayPeriod = { startsOn: '2026-07-10', endsOn: '2026-07-25' };

describe('percentOfMinor', () => {
  it('считает процент в BigInt без float', () => {
    expect(percentOfMinor(20_000_000n, '40')).toBe(8_000_000n);
    expect(percentOfMinor(20_000_000n, '60')).toBe(12_000_000n);
  });

  it('поддерживает дробный процент и округляет вниз', () => {
    expect(percentOfMinor(10_000_001n, '12.5')).toBe(1_250_000n);
  });
});

describe('amountOfSource', () => {
  it('absolute отдаёт сумму как есть', () => {
    expect(amountOfSource({ kind: 'absolute', amountMinor: 8_000_000n })).toBe(8_000_000n);
  });

  it('percent считает от оклада источника', () => {
    expect(amountOfSource({ kind: 'percent', percent: '40', ofMinor: 20_000_000n })).toBe(
      8_000_000n,
    );
  });
});

describe('incomeEventsIn', () => {
  it('берёт только приходы внутри полуоткрытого интервала', () => {
    const events = incomeEventsIn([advance, salary], july);
    expect(events.map((e) => [e.date, e.label])).toEqual([['2026-07-10', 'Аванс']]);
  });

  it('приход в день endsOn относится к следующему периоду', () => {
    const next: PayPeriod = { startsOn: '2026-07-25', endsOn: '2026-08-10' };
    expect(incomeEventsIn([advance, salary], next).map((e) => e.date)).toEqual(['2026-07-25']);
  });

  it('смешивает расписания: недельная подработка добавляет приходы внутрь периода', () => {
    // Якорь подработки — пятница 3 июля, значит платит и 10-го (тоже пятница, совпадает с началом периода).
    const events = incomeEventsIn([advance, sideGig], july);
    expect(events.map((e) => [e.date, e.label])).toEqual([
      ['2026-07-10', 'Аванс'],
      ['2026-07-10', 'Подработка'],
      ['2026-07-17', 'Подработка'],
      ['2026-07-24', 'Подработка'],
    ]);
  });

  it('складывает приходы, схлопнувшиеся клампом короткого месяца', () => {
    const feb: PayPeriod = { startsOn: '2026-02-15', endsOn: '2026-03-15' };
    const s30 = source({
      id: 'a',
      label: '30-го',
      schedule: { kind: 'monthly-days', days: [30] },
      amount: { kind: 'absolute', amountMinor: 100n },
    });
    const s31 = source({
      id: 'b',
      label: '31-го',
      schedule: { kind: 'monthly-days', days: [31] },
      amount: { kind: 'absolute', amountMinor: 200n },
    });
    const events = incomeEventsIn([s30, s31], feb);
    expect(events.map((e) => [e.date, e.amountMinor])).toEqual([
      ['2026-02-28', 100n],
      ['2026-02-28', 200n],
    ]);
  });

  it('правило выходных двигает дату прихода', () => {
    const period: PayPeriod = { startsOn: '2026-07-20', endsOn: '2026-08-20' };
    expect(incomeEventsIn([salary], period, 'before').map((e) => e.date)).toEqual(['2026-07-24']);
    expect(incomeEventsIn([salary], period, 'after').map((e) => e.date)).toEqual(['2026-07-27']);
  });

  it('затягивает приход, который правило выходных перенесло в период извне', () => {
    // 1 марта 2026 — воскресенье; при 'before' выплата приходит 27 февраля.
    const first = source({
      id: 'c',
      label: '1-го',
      schedule: { kind: 'monthly-days', days: [1] },
      amount: { kind: 'absolute', amountMinor: 500n },
    });
    const feb: PayPeriod = { startsOn: '2026-02-20', endsOn: '2026-03-01' };
    expect(incomeEventsIn([first], feb, 'before').map((e) => e.date)).toEqual(['2026-02-27']);
  });

  it('irregular не даёт событий', () => {
    const chaos = source({
      id: 'd',
      label: 'Когда как',
      schedule: { kind: 'irregular' },
      amount: { kind: 'absolute', amountMinor: 999n },
    });
    expect(incomeEventsIn([chaos], july)).toEqual([]);
  });

  it('one-off даёт событие только внутри своего периода', () => {
    const bonus = source({
      id: 'e',
      label: 'Гонорар',
      schedule: { kind: 'one-off', date: '2026-07-15' },
      amount: { kind: 'absolute', amountMinor: 5_000_000n },
    });
    expect(incomeEventsIn([bonus], july).map((e) => e.date)).toEqual(['2026-07-15']);
    expect(incomeEventsIn([bonus], { startsOn: '2026-07-25', endsOn: '2026-08-10' })).toEqual([]);
  });

  it('active: false исключает источник', () => {
    expect(incomeEventsIn([{ ...advance, active: false }], july)).toEqual([]);
  });

  it('startsOn и endsOn источника обрезают события', () => {
    const started = { ...sideGig, startsOn: '2026-07-18' };
    expect(incomeEventsIn([started], july).map((e) => e.date)).toEqual(['2026-07-24']);
    const ended = { ...sideGig, endsOn: '2026-07-18' };
    expect(incomeEventsIn([ended], july).map((e) => e.date)).toEqual(['2026-07-10', '2026-07-17']);
  });

  it('нулевая сумма в план не идёт', () => {
    expect(
      incomeEventsIn([{ ...advance, amount: { kind: 'absolute', amountMinor: 0n } }], july),
    ).toEqual([]);
  });

  it('события отсортированы по дате', () => {
    const events = incomeEventsIn([sideGig, advance], july);
    expect(events.map((e) => e.date)).toEqual([...events.map((e) => e.date)].sort());
  });
});

describe('expectedIncomeForPeriod', () => {
  // Аванс 80 000,00 + подработка 15 000,00 × 3 (10, 17, 24 июля).
  const events = incomeEventsIn([advance, sideGig], july);

  it('суммирует приходы в базовой валюте', () => {
    const total = expectedIncomeForPeriod(events, 'RUB', () => null);
    expect(total.incomeMinor).toBe(8_000_000n + 3n * 1_500_000n);
    expect(total.unresolved).toEqual([]);
  });

  it('конвертирует не-базовую валюту переданным конвертером', () => {
    const usd = source({
      id: 'f',
      label: 'Фриланс',
      currency: 'USD',
      schedule: { kind: 'one-off', date: '2026-07-15' },
      amount: { kind: 'absolute', amountMinor: 50_000n }, // 500.00 USD
    });
    const withUsd = incomeEventsIn([advance, usd], july);
    const toBase = (m: Money): Money => money(m.minor * 80n, 'RUB'); // условный курс 80
    const total = expectedIncomeForPeriod(withUsd, 'RUB', toBase);
    expect(total.incomeMinor).toBe(8_000_000n + 4_000_000n);
  });

  it('недоступный курс уводит приход в unresolved, а не в ноль', () => {
    const usd = source({
      id: 'g',
      label: 'Фриланс',
      currency: 'USD',
      schedule: { kind: 'one-off', date: '2026-07-15' },
      amount: { kind: 'absolute', amountMinor: 50_000n },
    });
    const total = expectedIncomeForPeriod(incomeEventsIn([advance, usd], july), 'RUB', () => null);
    expect(total.incomeMinor).toBe(8_000_000n);
    expect(total.unresolved.map((e) => e.label)).toEqual(['Фриланс']);
  });

  it('инвариант: сумма равна сумме событий той же валюты', () => {
    const total = expectedIncomeForPeriod(events, 'RUB', () => null);
    const manual = events.reduce((acc, e) => acc + e.amountMinor, 0n);
    expect(total.incomeMinor).toBe(manual);
  });
});

describe('rhythmMismatches', () => {
  const rhythm = { kind: 'monthly-days', days: [10, 25] } as const;

  it('молчит, когда в день начала периода есть приход', () => {
    expect(rhythmMismatches(rhythm, [advance, salary], 'as-is', '2026-07-12', 2)).toEqual([]);
  });

  it('сообщает границу периода, в которую ни один источник не платит', () => {
    expect(rhythmMismatches(rhythm, [advance], 'as-is', '2026-07-12', 2)).toEqual(['2026-07-25']);
  });
});

describe('несистемный доход: ежедневный и недельный (Оксана, 2026-08-03)', () => {
  /*
   * Живая находка: человек с ежедневным доходом застрял на онбординге, потому что модель знала
   * только выплаты по числам месяца. Такой доход — не «нерегулярный»: он как раз предсказуем, но
   * не датами, а частотой. Планировать его надо от суммы за раз, а не от суммы за период.
   */
  const period = { startsOn: '2026-08-10', endsOn: '2026-08-17' };

  it('ежедневный доход даёт приход на каждый день периода', () => {
    const events = incomeEventsIn(
      [
        {
          id: 'shift',
          label: 'Смена',
          currency: 'RUB',
          schedule: { kind: 'daily' },
          amount: { kind: 'absolute', amountMinor: 300_000n },
          stability: 'variable',
          active: true,
        },
      ],
      period,
    );
    // Полуинтервал: 10..16 включительно, 17-е принадлежит следующему периоду.
    expect(events).toHaveLength(7);
    expect(events[0]?.date).toBe('2026-08-10');
    expect(events.at(-1)?.date).toBe('2026-08-16');
    expect(events.every((e) => e.amountMinor === 300_000n)).toBe(true);
  });

  it('недельный доход приходит в свой день недели', () => {
    // 2026-08-10 — понедельник; просим пятницу (5).
    const events = incomeEventsIn(
      [
        {
          id: 'week',
          label: 'Расчёт за неделю',
          currency: 'RUB',
          schedule: { kind: 'weekly', weekday: 5 },
          amount: { kind: 'absolute', amountMinor: 1_500_000n },
          stability: 'variable',
          active: true,
        },
      ],
      period,
    );
    expect(events.map((e) => e.date)).toEqual(['2026-08-14']);
  });

  it('срок жизни источника уважается и у ежедневного', () => {
    const events = incomeEventsIn(
      [
        {
          id: 'shift',
          label: 'Смена',
          currency: 'RUB',
          schedule: { kind: 'daily' },
          amount: { kind: 'absolute', amountMinor: 300_000n },
          stability: 'variable',
          active: true,
          startsOn: '2026-08-14',
        },
      ],
      period,
    );
    expect(events.map((e) => e.date)).toEqual(['2026-08-14', '2026-08-15', '2026-08-16']);
  });
});
