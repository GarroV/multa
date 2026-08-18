import { describe, expect, it } from 'vitest';
import { planFromMasterGrid, suggestLineKinds } from './masterGridImport.ts';
import type { MasterGridParse } from './importXlsx.ts';

/**
 * Перенос плана из Excel в продукт (issue #124, шаг записи).
 *
 * Раскладку строк по видам делает человек в интерфейсе: файл даёт имена, а не природу («Сбер» это
 * кредит, «Отпуск» это цель). Угадывать нельзя — ошибка развела бы долг и категорию по разные
 * стороны каскада, где долг неприкосновенен, а категорию режут при нехватке (правило 3).
 *
 * Задача этой функции — из разбора и раскладки получить, ЧТО создать и с какими суммами, не
 * прикасаясь к базе: тогда самая опасная часть переноса проверяема без стенда.
 */

/** Файл владельца устроен так: половина колонок в прошлом, половина в будущем. */
const parsed: MasterGridParse = {
  periods: ['2026-07-10', '2026-07-25', '2026-08-25', '2026-09-10'],
  income: {
    name: 'Доход',
    amountsMinor: [10_000_000n, 5_000_000n, 5_000_000n, 10_000_000n],
    medianMinor: 7_500_000n,
    paidPeriods: 4,
  },
  lines: [
    {
      name: 'Сбер',
      amountsMinor: [1_000_000n, 1_000_000n, 1_200_000n, 1_200_000n],
      medianMinor: 1_100_000n,
      paidPeriods: 4,
    },
    {
      name: 'Продукты',
      amountsMinor: [2_000_000n, 2_000_000n, 3_000_000n, 3_000_000n],
      medianMinor: 2_500_000n,
      paidPeriods: 4,
    },
  ],
};

const asOf = '2026-08-18';

describe('перенос плана из Excel', () => {
  it('долг берёт остаток из будущих колонок, а не из всей истории', () => {
    /*
     * Главная ловушка переноса. В файле четыре года истории; сумма ВСЕХ колонок по кредиту — это
     * сколько человек заплатил за всё время, а не сколько остался должен. Записав её в остаток,
     * продукт удвоил бы долг и потребовал бы платить годы после закрытия.
     *
     * Остаток = только то, что впереди: колонки 25.08 и 10.09 → 12 000 + 12 000.
     */
    const out = planFromMasterGrid(parsed, { 0: 'debt' }, { asOf, currency: 'RUB' });
    expect(out.debts).toEqual([
      { name: 'Сбер', currency: 'RUB', paymentMinor: 1_200_000n, remainingMinor: 2_400_000n },
    ]);
  });

  it('платёж по долгу — медиана будущих колонок, а не всей истории', () => {
    // По истории медиана 11 000, впереди платят по 12 000. План на будущее — про будущее.
    const out = planFromMasterGrid(parsed, { 0: 'debt' }, { asOf, currency: 'RUB' });
    expect(out.debts[0]!.paymentMinor).toBe(1_200_000n);
  });

  it('категория переносится бюджетом на период, без остатка и цели', () => {
    const out = planFromMasterGrid(parsed, { 1: 'category' }, { asOf, currency: 'RUB' });
    expect(out.categories).toEqual([{ name: 'Продукты', budgetMinor: 3_000_000n }]);
    expect(out.debts).toEqual([]);
    expect(out.goals).toEqual([]);
  });

  it('цель берёт цель из суммы будущих взносов, а взнос — из медианы', () => {
    const out = planFromMasterGrid(parsed, { 0: 'goal' }, { asOf, currency: 'RUB' });
    expect(out.goals).toEqual([
      {
        name: 'Сбер',
        currency: 'RUB',
        targetMinor: 2_400_000n,
        perPeriodMinor: 1_200_000n,
      },
    ]);
  });

  it('конверт — фиксированная сумма на период', () => {
    const out = planFromMasterGrid(parsed, { 1: 'envelope' }, { asOf, currency: 'RUB' });
    expect(out.envelopes).toEqual([{ name: 'Продукты', currency: 'RUB', fixedMinor: 3_000_000n }]);
  });

  it('строка без вида не переносится: по умолчанию продукт не решает за человека', () => {
    /*
     * Умолчание «категория» живёт в интерфейсе, где человек его видит и может поменять. Здесь
     * умолчания нет намеренно: молча завести сущность из строки, о которой не спросили, — это
     * ровно то угадывание, которого требование запрещает.
     */
    const out = planFromMasterGrid(parsed, {}, { asOf, currency: 'RUB' });
    expect(out).toEqual({ debts: [], goals: [], envelopes: [], categories: [], skipped: [] });
  });

  it('вид skip выбрасывает строку явно', () => {
    const out = planFromMasterGrid(parsed, { 0: 'skip' }, { asOf, currency: 'RUB' });
    expect(out.debts).toEqual([]);
    expect(out.skipped).toEqual([]);
  });

  it('строка, у которой впереди ничего нет, не создаёт пустой долг', () => {
    /*
     * Разовая покупка из прошлого («Оборудование» в файле владельца) впереди денег не берёт.
     * Долг с нулевым платежом и нулевым остатком — мусор, который человек потом ищет и удаляет
     * руками; честнее сказать, что переносить нечего.
     */
    const past: MasterGridParse = {
      periods: ['2026-07-10', '2026-07-25'],
      income: null,
      lines: [
        {
          name: 'Оборудование',
          amountsMinor: [1_200_000n, 0n],
          medianMinor: 1_200_000n,
          paidPeriods: 1,
        },
      ],
    };
    const out = planFromMasterGrid(past, { 0: 'debt' }, { asOf, currency: 'RUB' });
    expect(out.debts).toEqual([]);
    expect(out.skipped).toEqual([{ name: 'Оборудование', reason: 'nothing_ahead' }]);
  });

  it('колонка ровно на дату сборки считается будущей', () => {
    /*
     * Граница включительная: период, который начинается сегодня, — это ближайшая раздача, деньги
     * по нему ещё не ушли. Исключив его, перенос занизил бы и остаток, и платёж.
     */
    const today: MasterGridParse = {
      periods: ['2026-08-18'],
      income: null,
      lines: [
        { name: 'Сбер', amountsMinor: [1_500_000n], medianMinor: 1_500_000n, paidPeriods: 1 },
      ],
    };
    const out = planFromMasterGrid(today, { 0: 'debt' }, { asOf, currency: 'RUB' });
    expect(out.debts[0]).toEqual({
      name: 'Сбер',
      currency: 'RUB',
      paymentMinor: 1_500_000n,
      remainingMinor: 1_500_000n,
    });
  });

  it('нулевые колонки не тянут медиану вниз', () => {
    /*
     * У полумесячного ритма долг часто платят раз в месяц: половина колонок — нули. Считая медиану
     * по всем, продукт получил бы 0 и завёл долг, который не платится (та же ошибка, что уже была
     * поймана в разборе файла).
     */
    const halfMonth: MasterGridParse = {
      periods: ['2026-09-10', '2026-09-25', '2026-10-10', '2026-10-25'],
      income: null,
      lines: [
        {
          name: 'Сбер',
          amountsMinor: [0n, 1_000_000n, 0n, 1_000_000n],
          medianMinor: 1_000_000n,
          paidPeriods: 2,
        },
      ],
    };
    const out = planFromMasterGrid(halfMonth, { 0: 'debt' }, { asOf, currency: 'RUB' });
    expect(out.debts[0]!.paymentMinor).toBe(1_000_000n);
    expect(out.debts[0]!.remainingMinor).toBe(2_000_000n);
  });

  it('строки-тёзки различаются по номеру, а не по имени', () => {
    /*
     * В настоящем файле владельца «Прочее» встречается дважды — в разных блоках таблицы и с разными
     * суммами. Раскладка по имени сложила бы их в один ключ, и вид, выбранный для одной строки,
     * молча применился бы к другой.
     */
    const twins: MasterGridParse = {
      periods: ['2026-09-10'],
      income: null,
      lines: [
        { name: 'Прочее', amountsMinor: [500_000n], medianMinor: 500_000n, paidPeriods: 1 },
        { name: 'Прочее', amountsMinor: [900_000n], medianMinor: 900_000n, paidPeriods: 1 },
      ],
    };
    const out = planFromMasterGrid(twins, { 1: 'category' }, { asOf, currency: 'RUB' });
    expect(out.categories).toEqual([{ name: 'Прочее', budgetMinor: 900_000n }]);
  });
});

/**
 * Подсказка вида для каждой строки.
 *
 * Найдено прогоном настоящего файла владельца 18.08.2026: кроме статей расходов, в таблице живут
 * ИТОГОВЫЕ строки — «Итого затраты», «Сумма к размену», «Остаток». Перенеся их категориями (а
 * умолчание интерфейса именно такое), продукт раздул бы план вдвое: «Итого затраты» и есть сумма
 * всех остальных строк, и человек получил бы категорию-двойник на 60 500 ₽ поверх настоящих.
 *
 * Подсказка не решает за человека — она ставит умолчание и называет причину. Ошибиться в сторону
 * «не переносить» безопасно: строку всегда можно включить руками, а вот лишняя категория-итог
 * искажает раздачу молча.
 */
describe('подсказка вида строки', () => {
  const of = (...names: string[]): MasterGridParse => ({
    periods: ['2026-09-10'],
    income: null,
    lines: names.map((name) => ({
      name,
      amountsMinor: [1_000_000n],
      medianMinor: 1_000_000n,
      paidPeriods: 1,
    })),
  });

  /** Итоговая строка: вид и причина фиксированы, суммы у неё те же, что у остальных строк `of`. */
  const total = (index: number, name: string) => ({
    index,
    name,
    kind: 'skip',
    reason: 'looks_like_total',
    perPeriodMinor: 1_000_000n,
    totalAheadMinor: 1_000_000n,
  });

  it('итоговые строки настоящего файла предлагает не переносить', () => {
    const out = suggestLineKinds(of('Итого затраты', 'Сумма к размену', 'Остаток'), asOf);
    expect(out).toEqual([
      total(0, 'Итого затраты'),
      total(1, 'Сумма к размену'),
      total(2, 'Остаток'),
    ]);
  });

  it('обычную статью предлагает категорией — наименее опасный вид', () => {
    /*
     * Категория единственный вид, который каскад режет при нехватке. Ошибочно назвав категорию
     * долгом, продукт сделал бы её неприкосновенной и урезал бы вместо неё что-то настоящее.
     */
    const out = suggestLineKinds(of('Еда, продукты'), asOf);
    expect(out).toEqual([
      {
        index: 0,
        name: 'Еда, продукты',
        kind: 'category',
        reason: 'default',
        perPeriodMinor: 1_000_000n,
        totalAheadMinor: 1_000_000n,
      },
    ]);
  });

  it('строку без денег впереди предлагает не переносить и говорит почему', () => {
    const past: MasterGridParse = {
      periods: ['2026-07-10'],
      income: null,
      lines: [
        {
          name: 'Оборудование',
          amountsMinor: [1_200_000n],
          medianMinor: 1_200_000n,
          paidPeriods: 1,
        },
      ],
    };
    expect(suggestLineKinds(past, asOf)).toEqual([
      {
        index: 0,
        name: 'Оборудование',
        kind: 'skip',
        reason: 'nothing_ahead',
        // Суммы нулевые, а не из истории: переносить нечего, и число не должно намекать иначе.
        perPeriodMinor: 0n,
        totalAheadMinor: 0n,
      },
    ]);
  });

  it('слово «итого» внутри имени статьи не делает её итогом', () => {
    /*
     * Признак — начало имени, а не вхождение: «Подытог» и «Итого» это итоги, а «Итальянская еда»
     * обычная статья. Слишком жадное правило молча выбросило бы настоящие траты из переноса.
     */
    const out = suggestLineKinds(of('Итальянская еда'), asOf);
    expect(out[0]!.kind).toBe('category');
  });
});

/**
 * Подсказка называет те суммы, которые действительно переедут.
 *
 * Найдено смоуком на эталонном файле 18.08.2026: предпросмотр показывал медиану по ВСЕЙ истории
 * («Инвестиции» — 11 484 ₽), а переносилась медиана будущих колонок (19 140 ₽). Человек решает
 * раскладку по числу на экране, и если запишется другое, предпросмотр перестаёт быть предпросмотром
 * — он становится вторым, расходящимся расчётом.
 */
describe('суммы в подсказке равны переносимым', () => {
  const parsedTwoWays: MasterGridParse = {
    periods: ['2026-07-10', '2026-08-25', '2026-09-10'],
    income: null,
    lines: [
      {
        name: 'Инвестиции',
        // В прошлом платили мало, впереди — вдвое больше: медианы истории и будущего разойдутся.
        amountsMinor: [500_000n, 1_900_000n, 1_900_000n],
        medianMinor: 1_900_000n,
        paidPeriods: 3,
      },
    ],
  };

  it('подсказка отдаёт сумму на период и сумму впереди', () => {
    const [line] = suggestLineKinds(parsedTwoWays, asOf);
    expect(line).toMatchObject({
      name: 'Инвестиции',
      kind: 'category',
      perPeriodMinor: 1_900_000n,
      totalAheadMinor: 3_800_000n,
    });
  });

  it('сумма из подсказки совпадает с тем, что запишет перенос', () => {
    const [line] = suggestLineKinds(parsedTwoWays, asOf);
    const plan = planFromMasterGrid(parsedTwoWays, { 0: 'category' }, { asOf, currency: 'RUB' });
    expect(plan.categories[0]!.budgetMinor).toBe(line!.perPeriodMinor);
  });

  it('у строки без денег впереди суммы нулевые, а не из истории', () => {
    const past: MasterGridParse = {
      periods: ['2026-07-10'],
      income: null,
      lines: [
        {
          name: 'Оборудование',
          amountsMinor: [1_200_000n],
          medianMinor: 1_200_000n,
          paidPeriods: 1,
        },
      ],
    };
    const [line] = suggestLineKinds(past, asOf);
    expect(line).toMatchObject({ perPeriodMinor: 0n, totalAheadMinor: 0n });
  });
});
