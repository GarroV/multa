/**
 * Мастер-сетка «строки × периоды выплат» (issue #47) — тот же взгляд, что был у основателя в
 * Excel: полгода вперёд одной таблицей.
 *
 * Главное свойство модуля: **новой правды о планах здесь нет**. Каждая колонка — вызов того же
 * каскада (`assemblePlan`), что собирает экран «План»; матрица только раскладывает его результат
 * по столбцам и ведёт жизненный цикл строк (долг выплачен, цель собрана). Любая своя арифметика
 * раздачи или сжатия развела бы две главные таблицы про одни и те же деньги — а расхождение здесь
 * подрывает доверие ко всему продукту.
 *
 * Все суммы — base-валюта в minor units (конвертация по курсу «сегодня» делается в apps/api до
 * вызова: курса на будущее не существует, и выдумывать снапшот нельзя — правило 2).
 */

import type { CompressibleKind, PlanItem, TargetKind } from './cascade.ts';
import { exchangeNeed, type ExchangeNeedLine } from './exchangeNeed.ts';
import { percentOfMinor } from './income.ts';
import { assemblePlan } from './plan.ts';

/** Состояние ячейки. Ноль и «строки в этом периоде нет» — разные вещи, и выглядеть должны по-разному. */
export type GridCellState =
  /** Плановая сумма периода (в том числе честный ноль после сжатия каскадом). */
  | 'planned'
  /** В этом периоде строки нет: заморожена или ещё не началась. */
  | 'none'
  /** Строка кончилась: долг закрыт, цель собрана. */
  | 'ended';

export interface GridCell {
  readonly minor: bigint;
  readonly state: GridCellState;
}

export interface GridRowSpec {
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly name: string;
  /** Валюта самой строки — в чём человек её задавал (аренда в EUR остаётся арендой в EUR). */
  readonly sourceCurrency: string;
  /** План за период в базовой валюте. */
  readonly perPeriodMinor: bigint;
  /**
   * План за период в валюте ПОЛУЧЕНИЯ — сколько валюты нужно купить под эту строку (issue #152).
   *
   * У обязательства это его собственная сумма («аренда 650 EUR»): она уже задана человеком, и
   * пересчитывать её обратно из рублей нельзя — вышло бы 649,98 вместо ровных 650. У корзины
   * (RUB→EUR) своей суммы в евро не существует: там задают, сколько РУБЛЕЙ менять, поэтому цифру
   * в евро считает apps/api курсом и передаёт сюда уже готовой.
   *
   * Не задано — берём базовую сумму: у строк в базовой валюте это одно и то же.
   */
  readonly receiveMinor?: bigint;
  /**
   * План по колонкам, когда сумма меняется во времени: «интернет 2 500 до октября, потом 4 000»
   * (запрос владельца 06.08.2026). Индекс — номер периода в горизонте.
   *
   * Матрица про ступени ничего не знает и знать не должна: правило «какая сумма действует на дату»
   * живёт в `amountOn`, а сюда приходят уже посчитанные суммы. Иначе тем же правилом пришлось бы
   * обзавестись и плану, и прогнозу — и однажды они дали бы по строке разные числа.
   */
  readonly perPeriodByIndex?: readonly bigint[];
  /** Только для корзин: во что меняем — по этому полю «к размену» разбивается по валютам. */
  readonly toCurrency?: string;
  /** Только для категорий: защищённая не режется автоматически. */
  readonly protected?: boolean;
  /**
   * Сколько всего осталось выбрать (долг) или собрать (цель). `undefined` — бессрочная строка:
   * категория и корзина не «кончаются».
   */
  readonly remainingMinor?: bigint;
  /**
   * Только для конвертов с правилом «процент с выплаты»: доля строкой, как её задал человек
   * («10», «12.5»). Считается тем же хелпером, что и в сборке плана, — иначе одна и та же доля
   * дала бы в матрице и на «Плане» разные копейки.
   */
  readonly percent?: string;
}

export interface GridPeriod {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly daysInPeriod: number;
}

export interface GridInput {
  readonly periods: readonly GridPeriod[];
  /** Базовая валюта воркспейса: относительно неё строка считается валютной (issue #152). */
  readonly baseCurrency: string;
  /** Ожидаемый доход по каждому периоду, base minor. Длина совпадает с `periods`. */
  readonly incomeMinor: readonly bigint[];
  readonly rows: readonly GridRowSpec[];
  readonly compressOrder?: readonly CompressibleKind[];
  /**
   * Сохранённый план материализованных периодов: индекс периода → карта `kind:id` → сумма.
   * Где он есть, он сильнее проекции — там человек уже принимал решения (перенос между строками,
   * заморозка цели), и пересчитывать их заново матрица не вправе. Строка, которой нет в карте, в
   * том периоде отсутствует (`none`), а не равна нулю.
   */
  readonly saved?: readonly (ReadonlyMap<string, bigint> | undefined)[];
  /**
   * Валютные обязательства ВНЕ каскада по периодам (issue #152): регулярные платежи, которые
   * списываются сами и дохода не делят. В раздачу они не идут — большинство уже сидит внутри
   * бюджета категорий, — но евро под них купить всё равно придётся, поэтому в «К размену» они
   * входят. Индекс — номер периода в горизонте.
   */
  readonly extraExchange?: readonly (readonly ExchangeNeedLine[])[];
}

export interface GridRow {
  readonly targetKind: TargetKind;
  readonly targetId: string;
  readonly name: string;
  readonly sourceCurrency: string;
  readonly cells: readonly GridCell[];
  readonly totalMinor: bigint;
  /** Индекс последнего периода, где строка ещё жива; null — не кончается на горизонте. */
  readonly endsAfterIndex: number | null;
}

export interface GridGroup {
  readonly kind: TargetKind;
  readonly rows: readonly GridRow[];
  /** Подытог группы по каждому периоду. */
  readonly totals: readonly bigint[];
  readonly totalMinor: bigint;
}

export interface GridFooter {
  readonly freeMinor: readonly bigint[];
  readonly perDayMinor: readonly bigint[];
  readonly toExchangeMinor: readonly bigint[];
  /** Разбивка «к размену» по валютам получения: менять придётся именно на них. */
  /**
   * Разбивка «к размену» по валютам получения: `cells` — сколько базовой уйдёт, `amountCells` —
   * сколько валюты нужно купить (issue #152).
   */
  readonly toExchangeByCurrency: readonly {
    readonly currency: string;
    readonly cells: bigint[];
    readonly amountCells: bigint[];
  }[];
}

export interface Grid {
  readonly rows: readonly GridRow[];
  readonly groups: readonly GridGroup[];
  readonly footer: GridFooter;
}

const keyOf = (kind: TargetKind, id: string): string => `${kind}:${id}`;

/** Строки, которые кончаются: долг выплачивается, цель собирается. Остальные живут всегда. */
const hasLifecycle = (row: GridRowSpec): boolean => row.remainingMinor !== undefined;

export function projectGrid(input: GridInput): Grid {
  const { periods, rows } = input;
  if (periods.length === 0) {
    return {
      rows: [],
      groups: [],
      footer: { freeMinor: [], perDayMinor: [], toExchangeMinor: [], toExchangeByCurrency: [] },
    };
  }

  // Остаток по строке живёт между колонками: платёж уменьшает долг, взнос приближает цель.
  const left = new Map<string, bigint>();
  for (const row of rows) {
    if (hasLifecycle(row)) left.set(keyOf(row.targetKind, row.targetId), row.remainingMinor!);
  }

  const cellsByRow = new Map<string, GridCell[]>(
    rows.map((r) => [keyOf(r.targetKind, r.targetId), []]),
  );
  const freeMinor: bigint[] = [];
  const perDayMinor: bigint[] = [];
  const toExchangeMinor: bigint[] = [];
  const exchangeByCurrency = new Map<string, { cells: bigint[]; amountCells: bigint[] }>();

  for (let i = 0; i < periods.length; i += 1) {
    const period = periods[i]!;
    const income = input.incomeMinor[i] ?? 0n;
    const saved = input.saved?.[i];

    /*
     * Вход каскада на этот период. Для материализованного периода берём сохранённые суммы: они уже
     * прошли каскад и могли быть поправлены человеком. Для будущего — проекцию, ограниченную
     * остатком строки: последний платёж по долгу равен остатку, а не полному платежу.
     */
    const planItems: PlanItem[] = [];
    const absent = new Set<string>();
    for (const row of rows) {
      const key = keyOf(row.targetKind, row.targetId);
      if (saved) {
        const value = saved.get(key);
        if (value === undefined) {
          absent.add(key);
          continue;
        }
        planItems.push({
          targetKind: row.targetKind,
          targetId: row.targetId,
          plannedMinor: value,
          ...(row.protected ? { protected: true } : {}),
        });
        continue;
      }

      const wanted =
        row.percent !== undefined
          ? percentOfMinor(income, row.percent)
          : (row.perPeriodByIndex?.[i] ?? row.perPeriodMinor);
      const remaining = left.get(key);
      const planned = remaining === undefined ? wanted : remaining < wanted ? remaining : wanted;
      if (remaining !== undefined && remaining <= 0n) {
        absent.add(key);
        continue;
      }
      planItems.push({
        targetKind: row.targetKind,
        targetId: row.targetId,
        plannedMinor: planned,
        ...(row.protected ? { protected: true } : {}),
      });
    }

    const { result, summary } = assemblePlan(income, planItems, {
      daysInPeriod: period.daysInPeriod,
      ...(input.compressOrder ? { compressOrder: input.compressOrder } : {}),
    });

    const allocated = new Map(
      result.allocations.map((a) => [keyOf(a.targetKind, a.targetId), a.allocatedMinor]),
    );

    for (const row of rows) {
      const key = keyOf(row.targetKind, row.targetId);
      const cells = cellsByRow.get(key)!;
      if (absent.has(key)) {
        // Кончилась строка или её не было в сохранённом плане — состояния разные, ноль общий.
        const ended = hasLifecycle(row) && (left.get(key) ?? 0n) <= 0n;
        cells.push({ minor: 0n, state: ended ? 'ended' : 'none' });
        continue;
      }
      const minor = allocated.get(key) ?? 0n;
      cells.push({ minor, state: 'planned' });
      /*
       * Остаток уменьшает то, что реально роздано: сжатая цель собирается дольше. Сохранённый
       * период тоже уменьшает — платёж в нём такой же настоящий, и без этого долг «закрывался» бы
       * на период позже, чем в жизни.
       */
      if (hasLifecycle(row)) left.set(key, (left.get(key) ?? 0n) - minor);
    }

    freeMinor.push(summary.freeMinor);
    perDayMinor.push(summary.canSpendPerDayMinor);

    /*
     * «К размену» — срез по валютам, а не ещё одна строка раздачи (issue #152). Берём суммы,
     * которые каскад УЖЕ роздал: сжатая строка требует меньше валюты, и потребность обязана это
     * повторять, иначе подвал обещал бы размен на деньги, которых в плане нет.
     *
     * Валюта строки — та, в которой платить: у корзины это валюта получения, у остальных строк
     * их собственная. Правило сложения — в `exchangeNeed()`, одно на план и на матрицу.
     */
    const needLines: ExchangeNeedLine[] = [];
    for (const row of rows) {
      const key = keyOf(row.targetKind, row.targetId);
      if (absent.has(key)) continue;
      const minor = allocated.get(key) ?? 0n;
      const source = row.receiveMinor ?? minor;
      /*
       * Сколько валюты нужно: сумма строки в её валюте, как её задал человек («аренда 650 EUR»).
       * Обратно из базовой по курсу не считаем — это дало бы 649,98 вместо ровных 650.
       *
       * Масштабируем только если роздано не столько, сколько стоит в строке: каскад сжал взнос
       * (валюты нужно меньше) или колонка живёт по ступени с другой суммой. Пропорция берётся от
       * базовых сумм — в них и записано решение каскада.
       */
      const planned = row.perPeriodMinor;
      needLines.push({
        currency: row.toCurrency ?? row.sourceCurrency,
        minor,
        amountMinor: planned <= 0n ? 0n : minor === planned ? source : (source * minor) / planned,
      });
    }
    needLines.push(...(input.extraExchange?.[i] ?? []));

    const need = exchangeNeed(needLines, input.baseCurrency);
    toExchangeMinor.push(need.totalMinor);
    for (const line of need.byCurrency) {
      const series = exchangeByCurrency.get(line.currency) ?? {
        cells: periods.map(() => 0n),
        amountCells: periods.map(() => 0n),
      };
      series.cells[i] = line.minor;
      series.amountCells[i] = line.amountMinor;
      exchangeByCurrency.set(line.currency, series);
    }
  }

  const built: GridRow[] = rows.map((row) => {
    const cells = cellsByRow.get(keyOf(row.targetKind, row.targetId))!;
    const lastAlive = cells.reduce((acc, cell, i) => (cell.state === 'planned' ? i : acc), -1);
    const endsAfterIndex =
      hasLifecycle(row) && cells.some((c) => c.state === 'ended') ? lastAlive : null;
    return {
      targetKind: row.targetKind,
      targetId: row.targetId,
      name: row.name,
      sourceCurrency: row.sourceCurrency,
      cells,
      totalMinor: cells.reduce((acc, c) => acc + c.minor, 0n),
      endsAfterIndex,
    };
  });

  // Порядок строк = порядок каскада: таблица читается сверху вниз так же, как раздаются деньги.
  /*
   * Разделы показываем все пять, даже пустые. Пустая таблица без разделов — это лист бумаги: она
   * не показывает, что вообще можно заполнить. Человек, пришедший из Excel, ждёт готовую форму со
   * строками «долги», «корзины», «конверты», «категории», «цели» — и заполняет её по месту.
   */
  const groups: GridGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const groupRows = built.filter((r) => r.targetKind === kind);
    const totals = periods.map((_, i) =>
      groupRows.reduce((acc, r) => acc + (r.cells[i]?.minor ?? 0n), 0n),
    );
    groups.push({
      kind,
      rows: groupRows,
      totals,
      totalMinor: totals.reduce((a, b) => a + b, 0n),
    });
  }

  return {
    rows: groups.flatMap((g) => g.rows),
    groups,
    footer: {
      freeMinor,
      perDayMinor,
      toExchangeMinor,
      toExchangeByCurrency: [...exchangeByCurrency.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([currency, series]) => ({
          currency,
          cells: series.cells,
          amountCells: series.amountCells,
        })),
    },
  };
}

/** Порядок групп = порядок раздачи каскада (01-domain-model §Каскад). */
const GROUP_ORDER: readonly TargetKind[] = ['debt', 'bucket', 'envelope', 'category', 'goal'];
