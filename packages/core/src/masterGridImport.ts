import type { MasterGridParse } from './importXlsx.ts';

/**
 * Перенос плана из таблицы «строки × периоды» в сущности продукта (issue #124, шаг записи).
 *
 * Раскладку по видам делает человек: файл даёт имена строк, а не их природу — «Сбер» это кредит,
 * «Отпуск» цель, «Продукты» категория. Угадывать по названию нельзя, потому что вид определяет
 * судьбу строки в каскаде: долг неприкосновенен, а категорию при нехватке режут (правило 3).
 * Ошибка тут не косметическая — она молча меняет то, чем продукт распоряжается.
 *
 * Функция чистая и ничего не пишет: самая опасная часть переноса (какие суммы попадут в план)
 * проверяется без базы и стенда.
 *
 * **Считаем только по колонкам, которые ещё впереди.** В файле владельца четыре года истории, и
 * сумма всех колонок по кредиту — это сколько заплачено за всё время, а не сколько осталось. Взяв
 * её, продукт удвоил бы долг и требовал бы платить годы после закрытия.
 */

export type MasterLineKind = 'debt' | 'goal' | 'envelope' | 'category' | 'skip';

/**
 * Раскладка «номер строки → вид». Строки, которой в раскладке нет, продукт не касается.
 *
 * По номеру, а не по имени: в настоящем файле владельца «Прочее» встречается дважды, в разных
 * блоках таблицы и с разными суммами. По имени эти строки склеились бы в один ключ, и вид,
 * выбранный для одной, молча применился бы к другой.
 */
export type MasterGridAssignment = Readonly<Record<number, MasterLineKind>>;

export interface MasterGridImportPlan {
  readonly debts: {
    name: string;
    currency: string;
    paymentMinor: bigint;
    remainingMinor: bigint;
  }[];
  readonly goals: {
    name: string;
    currency: string;
    targetMinor: bigint;
    perPeriodMinor: bigint;
  }[];
  readonly envelopes: { name: string; currency: string; fixedMinor: bigint }[];
  readonly categories: { name: string; budgetMinor: bigint }[];
  /** Строки, которым вид назначили, но переносить нечего: молчать об этом нельзя. */
  readonly skipped: { name: string; reason: 'nothing_ahead' }[];
}

export interface MasterGridImportOptions {
  /** Дата сборки: колонки от неё и дальше считаются будущими (граница включительная). */
  readonly asOf: string;
  readonly currency: string;
}

/** Медиана непустых сумм: нули полумесячного ритма не должны тянуть план к нулю. */
function medianOfPaid(amounts: readonly bigint[]): bigint {
  const paid = amounts.filter((a) => a > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (paid.length === 0) return 0n;
  const mid = Math.floor(paid.length / 2);
  if (paid.length % 2 === 1) return paid[mid]!;
  return (paid[mid - 1]! + paid[mid]!) / 2n;
}

export function planFromMasterGrid(
  parsed: MasterGridParse,
  assignment: MasterGridAssignment,
  opts: MasterGridImportOptions,
): MasterGridImportPlan {
  const plan: MasterGridImportPlan = {
    debts: [],
    goals: [],
    envelopes: [],
    categories: [],
    skipped: [],
  };

  /*
   * Индексы будущих колонок. Период, который начинается сегодня, — будущий: это ближайшая
   * раздача, деньги по ней ещё не ушли.
   */
  const ahead = parsed.periods.flatMap((date, i) => (date >= opts.asOf ? [i] : []));

  for (const [index, line] of parsed.lines.entries()) {
    const kind = assignment[index];
    if (!kind || kind === 'skip') continue;

    const amounts = ahead.map((i) => line.amountsMinor[i] ?? 0n);
    const total = amounts.reduce((a, b) => a + b, 0n);
    /*
     * Впереди строка денег не берёт — разовая покупка из прошлого. Долг с нулевым платежом и
     * нулевым остатком человек потом ищет и удаляет руками; честнее сказать, что переносить нечего.
     */
    if (total === 0n) {
      plan.skipped.push({ name: line.name, reason: 'nothing_ahead' });
      continue;
    }
    const perPeriod = medianOfPaid(amounts);

    if (kind === 'debt') {
      plan.debts.push({
        name: line.name,
        currency: opts.currency,
        paymentMinor: perPeriod,
        remainingMinor: total,
      });
    } else if (kind === 'goal') {
      plan.goals.push({
        name: line.name,
        currency: opts.currency,
        targetMinor: total,
        perPeriodMinor: perPeriod,
      });
    } else if (kind === 'envelope') {
      plan.envelopes.push({ name: line.name, currency: opts.currency, fixedMinor: perPeriod });
    } else {
      /*
       * Категория — бюджет на период, без остатка и цели: у неё нет «сколько всего», есть «сколько
       * в этот раз».
       */
      plan.categories.push({ name: line.name, budgetMinor: perPeriod });
    }
  }

  return plan;
}

/** Почему подсказка предлагает именно этот вид. */
export type SuggestReason = 'looks_like_total' | 'nothing_ahead' | 'default';

export interface LineSuggestion {
  readonly index: number;
  readonly name: string;
  readonly kind: MasterLineKind;
  readonly reason: SuggestReason;
  /**
   * Суммы, которые действительно переедут — те же, что посчитает `planFromMasterGrid`.
   *
   * Предпросмотр обязан называть их, а не медиану по всей истории: человек решает раскладку по числу
   * на экране, и если запишется другое, предпросмотр перестаёт быть предпросмотром и становится
   * вторым, расходящимся расчётом (поймано смоуком на эталонном файле: 11 484 ₽ на экране против
   * 19 140 ₽ в записи).
   */
  readonly perPeriodMinor: bigint;
  readonly totalAheadMinor: bigint;
}

/**
 * Итоговые строки таблицы. В файле владельца это «Итого затраты», «Сумма к размену», «Остаток» —
 * они не статьи, а арифметика по остальным строкам.
 *
 * Сравнение по НАЧАЛУ имени, а не по вхождению: «Итальянская еда» это обычная статья, и жадное
 * правило молча выбросило бы настоящие траты из переноса.
 */
const TOTAL_PREFIXES = [
  'итого',
  'итог',
  'подытог',
  'всего',
  'сумма',
  'остаток',
  'баланс',
  'total',
  'subtotal',
  'balance',
];

/**
 * Что предложить по каждой строке файла.
 *
 * Подсказка не решает за человека — она ставит умолчание и называет причину, а вид он выбирает сам
 * (правило 3: вид определяет судьбу строки в каскаде, и угадывать по имени нельзя). Ошибаться она
 * должна в сторону «не переносить»: включить строку руками легко, а лишняя категория-двойник
 * искажает раздачу молча.
 *
 * Умолчание для обычной статьи — категория: единственный вид, который каскад режет при нехватке.
 * Назвав категорию долгом, продукт сделал бы её неприкосновенной и урезал бы вместо неё что-то
 * настоящее.
 */
export function suggestLineKinds(parsed: MasterGridParse, asOf: string): LineSuggestion[] {
  const ahead = parsed.periods.flatMap((date, i) => (date >= asOf ? [i] : []));

  return parsed.lines.map((line, index) => {
    const amounts = ahead.map((i) => line.amountsMinor[i] ?? 0n);
    const totalAheadMinor = amounts.reduce((a, b) => a + b, 0n);
    // Ровно те же суммы, что запишет перенос: одна формула на предпросмотр и на запись.
    const perPeriodMinor = medianOfPaid(amounts);
    const sums = { perPeriodMinor, totalAheadMinor };

    const name = line.name.trim().toLowerCase();
    if (TOTAL_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix} `))) {
      return {
        index,
        name: line.name,
        kind: 'skip' as const,
        reason: 'looks_like_total' as const,
        ...sums,
      };
    }
    if (totalAheadMinor === 0n) {
      return {
        index,
        name: line.name,
        kind: 'skip' as const,
        reason: 'nothing_ahead' as const,
        ...sums,
      };
    }
    return {
      index,
      name: line.name,
      kind: 'category' as const,
      reason: 'default' as const,
      ...sums,
    };
  });
}
