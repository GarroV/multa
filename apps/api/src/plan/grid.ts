import {
  amountOn,
  debtPaymentForPeriod,
  convert,
  recurringDueIn,
  normalizeSteps,
  type AmountStep,
  daysInPeriod as daysOf,
  expectedIncomeForPeriod,
  generatePeriods,
  incomeEventsIn,
  money,
  projectGrid,
  type GridRowSpec,
  type PayPeriod,
  type PeriodConfig,
  type TargetKind,
  type WeekendRule,
} from '@multa/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import {
  categories,
  currencyBuckets,
  debts,
  envelopes,
  goals,
  payPeriods,
  plannedItems,
  recurringItems,
} from '../db/schema/domain.ts';
import { getRate } from '../fx/service.ts';
import { listSources } from '../income/store.ts';
import type { Workspace } from '../middleware.ts';
import { settingsOf } from '../settings/store.ts';
import { parsePaymentsBySource } from './assemble.ts';
import { SHARING_SECTION_OF } from './sharing.ts';
import type { ShareMode } from '../validation.ts';
import { getCurrentPlan } from './assemble.ts';

/**
 * Ступени из jsonb: суммы там строками (bigint в JSON не живёт). Кривая запись — не повод падать
 * пятисоткой на чтении плана, поэтому мусорные элементы отбрасываются, а не роняют ответ.
 */
function parseAmountSteps(raw: unknown): AmountStep[] {
  if (!Array.isArray(raw)) return [];
  const out: AmountStep[] = [];
  for (const item of raw) {
    const step = item as { from?: unknown; amountMinor?: unknown };
    if (typeof step?.from !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(step.from)) continue;
    if (typeof step.amountMinor !== 'string' || !/^-?\d+$/.test(step.amountMinor)) continue;
    out.push({ from: step.from, amountMinor: BigInt(step.amountMinor) });
  }
  return normalizeSteps(out);
}

/**
 * Мастер-сетка «строки × периоды выплат» (issue #47) — взгляд из Excel основателя: полгода вперёд
 * одной таблицей.
 *
 * Три решения, определяющие всю ручку:
 *
 * 1. **Первая колонка — это ровно экран «План».** Она берётся из `getCurrentPlan`, а не считается
 *    заново: две главные таблицы про одни и те же деньги обязаны совпадать в копейку, иначе
 *    доверия не будет ни к одной. Побочный эффект тот же, что у открытия «Плана» (текущий и
 *    следующий периоды материализуются) — нового здесь не появляется.
 * 2. **Будущие колонки — чистая проекция, ничего не пишущая.** Собирать их `assembleForPeriod`
 *    нельзя: она создаёт `pay_periods`, пишет `planned_items` и делает разовый перенос бюджетов
 *    категорий. Одно открытие матрицы зафиксировало бы планы на полгода вперёд, и последующая
 *    правка бюджета до них бы уже не доехала.
 * 3. **Курс — только «сегодняшний».** Котировок на будущее не существует, и выдумывать снапшот
 *    нельзя (правило 2). Всё, что в другой валюте, приводится к базовой по курсу на `asOf`; чего
 *    привести не удалось — уходит в `unresolved`, а не в тихий ноль.
 */

export interface GridCellDto {
  minor: string;
  state: 'planned' | 'none' | 'ended';
}

export interface GridRowDto {
  targetKind: TargetKind | 'income' | 'recurring';
  targetId: string;
  name: string;
  sourceCurrency: string;
  cells: GridCellDto[];
  totalMinor: string;
  /** Индекс последней живой колонки; null — строка не кончается на горизонте. */
  endsAfterIndex: number | null;
}

export interface GridGroupDto {
  kind: TargetKind | 'income' | 'recurring';
  /**
   * Группа вне итогов: её суммы НЕ входят в подвал (issue #80). Большинство регулярных платежей
   * уже сидит внутри бюджета категории, и сложить их в «свободный остаток» значило бы посчитать
   * одни деньги дважды. Показываем, потому что «этого платежа тут нет» человек читает как «его не
   * будет», но подпись обязана быть честной.
   */
  informational?: true;
  rows: GridRowDto[];
  totals: string[];
  totalMinor: string;
}

export interface GridDto {
  baseCurrency: string;
  periods: { startsOn: string; endsOn: string; daysInPeriod: number; materialized: boolean }[];
  groups: GridGroupDto[];
  footer: {
    freeMinor: string[];
    perDayMinor: string[];
    toExchangeMinor: string[];
    toExchangeByCurrency: { currency: string; cells: string[] }[];
  };
  /** Строки, которые не удалось привести к базовой валюте: показываем их отдельно, а не прячем. */
  unresolved: { targetKind: TargetKind; targetId: string; name: string; sourceCurrency: string }[];
}

const keyOf = (kind: TargetKind, id: string): string => `${kind}:${id}`;

/** Целая часть numeric-строки как minor units. Та же семантика, что в сборке плана. */
const numericToMinor = (value: string): bigint => BigInt(value.trim().split('.')[0] || '0');

/**
 * Бюджеты категорий, заданные на конкретные периоды горизонта.
 *
 * Ключ — «дата начала периода : id категории»: сетка знает периоды по датам (их же она отдаёт в
 * колонках), а не по внутренним id, и склеивать одно с другим в вызывающем коде значило бы завести
 * там вторую арифметику периодов.
 *
 * Берём только материализованные периоды: у остальных плана и быть не может, а запрос по всем
 * датам горизонта ничего бы не нашёл.
 */
async function plannedByPeriod(
  workspaceId: string,
  periods: readonly PayPeriod[],
): Promise<Map<string, bigint>> {
  const starts = periods.map((p) => p.startsOn);
  const rows = await db
    .select({
      startsOn: payPeriods.startsOn,
      targetId: plannedItems.targetId,
      plannedMinor: plannedItems.plannedMinor,
    })
    .from(plannedItems)
    .innerJoin(payPeriods, eq(payPeriods.id, plannedItems.periodId))
    .where(
      and(
        eq(plannedItems.workspaceId, workspaceId),
        eq(plannedItems.targetKind, 'category'),
        inArray(payPeriods.startsOn, starts),
      ),
    );
  return new Map(rows.map((r) => [`${r.startsOn}:${r.targetId}`, r.plannedMinor]));
}

/** Заменяет нулевой (текущий) столбец значением с «Плана», оставляя будущие как есть. */
function withCurrent(cells: string[], current: string): string[] {
  return cells.length === 0 ? cells : [current, ...cells.slice(1)];
}

export async function getPlanGrid(
  ws: Workspace,
  asOf: string,
  periodsWanted: number,
  /** Участник видит сетку через матрицу видимости: закрытые разделы сворачиваются (issue #84). */
  asMember = false,
): Promise<GridDto> {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const base = ws.baseCurrency;
  const anchors = ws.periodAnchors as PeriodConfig;
  const sharing = settingsOf(ws).sharing;
  const periods = generatePeriods(anchors, asOf, periodsWanted);
  if (periods.length === 0) throw new Error('period_undeterminable');

  // Первая колонка — состояние экрана «План» как есть, включая правки человека и заморозки.
  const plan = await getCurrentPlan(ws, asOf);

  const [debtRows, bucketRows, envelopeRows, goalRows, categoryRows, sources] = await Promise.all([
    db
      .select()
      .from(debts)
      .where(
        and(
          eq(debts.workspaceId, ws.id),
          sql`${debts.closedAt} is null`,
          // Заём в раздачу не идёт: иначе каскад откладывал бы деньги на возврат чужого долга (#94).
          sql`${debts.direction} = 'owed_by_me'`,
        ),
      ),
    db
      .select()
      .from(currencyBuckets)
      .where(and(eq(currencyBuckets.workspaceId, ws.id), eq(currencyBuckets.active, true))),
    db.select().from(envelopes).where(eq(envelopes.workspaceId, ws.id)),
    db
      .select()
      .from(goals)
      .where(and(eq(goals.workspaceId, ws.id), sql`${goals.achievedAt} is null`)),
    db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, ws.id), eq(categories.archived, false))),
    listSources(ws.id),
  ]);

  /*
   * Карта курсов на «сегодня», один запрос на валюту. Дальше все строки конвертируются из неё:
   * иначе grid звал бы getRate на каждую пару × период и делал бы это тем чаще, чем длиннее
   * горизонт.
   */
  const currencies = new Set<string>();
  for (const d of debtRows) currencies.add(d.currency);
  for (const b of bucketRows) currencies.add(b.fromCurrency);
  for (const e of envelopeRows) if (e.ruleKind !== 'percent') currencies.add(e.currency);
  for (const g of goalRows) currencies.add(g.currency);
  for (const s of sources) currencies.add(s.currency);
  currencies.delete(base);

  const rateEntries = await Promise.all(
    [...currencies].map(async (ccy) => [ccy, await getRate(ccy, base, asOf, ws.id)] as const),
  );
  const rates = new Map(rateEntries);
  const toBase = (minor: bigint, ccy: string): bigint | null => {
    if (ccy === base) return minor;
    const snap = rates.get(ccy);
    return snap ? convert(money(minor, ccy), snap).minor : null;
  };

  const unresolved: GridDto['unresolved'] = [];
  const rows: GridRowSpec[] = [];

  /** Кладёт строку в матрицу; невыразимую в базовой валюте — в список нерешённых. */
  const push = (
    targetKind: TargetKind,
    targetId: string,
    name: string,
    sourceCurrency: string,
    sourceMinor: bigint,
    extra?: Partial<GridRowSpec>,
  ): void => {
    if (sourceMinor <= 0n && extra?.percent === undefined) return;
    const perPeriodMinor = toBase(sourceMinor, sourceCurrency);
    if (perPeriodMinor === null) {
      unresolved.push({ targetKind, targetId, name, sourceCurrency });
      return;
    }
    rows.push({ targetKind, targetId, name, sourceCurrency, perPeriodMinor, ...extra });
  };

  /*
   * Источники дохода по колонкам: нужны долгам с разбивкой платежа («5 000 с аванса, 15 000 с
   * зарплаты»). Считаем один раз на весь горизонт, а не на каждый долг.
   */
  const sourcesByPeriod = periods.map((p: PayPeriod) => [
    ...new Set(
      incomeEventsIn(sources, p, ws.paydayWeekendRule as WeekendRule).map((e) => e.sourceId),
    ),
  ]);

  for (const d of debtRows) {
    const remaining = toBase(d.remainingMinor, d.currency);
    /*
     * Сумма платежа может меняться во времени (ступени). Каждая колонка — свой период, поэтому
     * считаем её на дату начала периода: так «интернет 2 500 до октября» и стоит 2 500 в сентябре
     * и 4 000 с октября, а не одним числом на весь горизонт.
     */
    const steps = parseAmountSteps(d.amountSteps);
    const bySource = parsePaymentsBySource(d.paymentsBySource);
    /*
     * Колонка считается тем же правилом ядра, что и план (`debtPaymentForPeriod`). Своя формула
     * здесь однажды уже развела план и таблицу по цифре дня — второй раз наступать не будем.
     */
    const byIndex =
      steps.length === 0 && bySource.length === 0
        ? undefined
        : periods.map(
            (p: PayPeriod, i: number) =>
              toBase(
                debtPaymentForPeriod(
                  { paymentMinor: d.paymentMinor, steps, bySource },
                  sourcesByPeriod[i] ?? [],
                  p.startsOn,
                ),
                d.currency,
              ) ?? 0n,
          );
    push('debt', d.id, d.name, d.currency, d.paymentMinor, {
      ...(remaining !== null ? { remainingMinor: remaining } : {}),
      ...(byIndex ? { perPeriodByIndex: byIndex } : {}),
    });
  }
  for (const b of bucketRows) {
    push('bucket', b.id, b.name, b.fromCurrency, b.amountMinor, { toCurrency: b.toCurrency });
  }
  for (const e of envelopeRows) {
    if (e.ruleKind === 'percent') {
      // Доля считается от дохода каждого периода — FX здесь не участвует.
      rows.push({
        targetKind: 'envelope',
        targetId: e.id,
        name: e.name,
        sourceCurrency: base,
        perPeriodMinor: 0n,
        percent: e.ruleValue,
      });
    } else {
      push('envelope', e.id, e.name, e.currency, numericToMinor(e.ruleValue));
    }
  }
  for (const g of goalRows) {
    const left = g.targetMinor - g.savedMinor;
    const remaining = toBase(left > 0n ? left : 0n, g.currency);
    push('goal', g.id, g.name, g.currency, g.plannedPerPeriodMinor, {
      ...(remaining !== null ? { remainingMinor: remaining } : {}),
    });
  }

  /*
   * Категории — интент человека, а не вывод из обязательства: их «план на период» живёт в
   * planned_items текущего периода. Вперёд тянем тот же бюджет: обещать себе другую сумму на
   * будущее человек нигде не просил, а обнулять её значило бы показать полгода без еды.
   */
  const categoryPlan = new Map(
    plan.allocations
      .filter((a) => a.targetKind === 'category')
      .map((a) => [a.targetId, BigInt(a.plannedMinor)]),
  );

  /*
   * Бюджеты, заданные на конкретные будущие периоды (правка ячейки сетки, 13.08.2026).
   *
   * Раньше вперёд тянулся один и тот же бюджет текущего периода, и запись в будущий столбец не
   * влияла ни на что: правка молча пропадала. Теперь там, где для периода есть свой planned_item,
   * берётся он, а где нет — по-прежнему бюджет текущего периода.
   */
  const futurePlans = await plannedByPeriod(ws.id, periods);

  for (const c of categoryRows) {
    const planned = categoryPlan.get(c.id) ?? 0n;
    const byIndex = periods.map((p: PayPeriod, i: number) =>
      i === 0 ? planned : (futurePlans.get(`${p.startsOn}:${c.id}`) ?? planned),
    );
    // Строки нет, только если её нет ни в одном периоде: иначе бюджет на май пропал бы из таблицы.
    if (byIndex.every((v: bigint) => v <= 0n)) continue;
    rows.push({
      targetKind: 'category',
      targetId: c.id,
      name: c.name,
      sourceCurrency: base,
      perPeriodMinor: planned,
      perPeriodByIndex: byIndex,
      ...(c.protected ? { protected: true } : {}),
    });
  }

  // Доход по периодам: события источников внутри периода, приведённые по «сегодняшнему» курсу.
  const weekendRule = ws.paydayWeekendRule as WeekendRule;
  const incomeMinor: bigint[] = periods.map((period: PayPeriod, i: number) => {
    // Первая колонка берёт доход из плана: там уже учтён факт поступлений (issue #48).
    if (i === 0) return BigInt(plan.incomeMinor);
    const events = incomeEventsIn(sources, period, weekendRule);
    const total = expectedIncomeForPeriod(events, base, (m) => {
      const snap = rates.get(m.currency);
      return snap ? convert(m, snap) : null;
    });
    return total.incomeMinor;
  });

  const saved = periods.map((_: PayPeriod, i: number) =>
    i === 0
      ? new Map(
          plan.allocations.map((a) => [keyOf(a.targetKind, a.targetId), BigInt(a.allocatedMinor)]),
        )
      : undefined,
  );

  const grid = projectGrid({
    periods: periods.map((p: PayPeriod) => ({
      startsOn: p.startsOn,
      endsOn: p.endsOn,
      daysInPeriod: daysOf(p),
    })),
    incomeMinor,
    rows,
    compressOrder: settingsOf(ws).cascade.compressOrder,
    saved,
  });

  /*
   * Регулярные платежи отдельной группой (issue #80). В каскаде их нет — они не делят доход, а
   * списываются сами, — но человек, заведя счёт за интернет, ищет его именно здесь: таблица
   * называется «что впереди», и отсутствие строки читается как «платежа не будет».
   *
   * Группа помечена `informational` и в подвал не идёт. Сложить её в итоги нельзя: большинство
   * таких трат уже сидит внутри бюджета категории, и «свободный остаток» посчитал бы одни деньги
   * дважды — ровно то, из-за чего группу и отложили при первой версии матрицы.
   *
   * Сумма по колонке — сколько списаний правило даёт в этом периоде: платёж 5-го числа при
   * полумесячном ритме попадает не в каждый период, и рисовать его всюду значило бы врать.
   */
  const recurringRows = await db
    .select()
    .from(recurringItems)
    .where(and(eq(recurringItems.workspaceId, ws.id), eq(recurringItems.active, true)));

  const recurringGroup: GridGroupDto | null =
    recurringRows.length === 0
      ? null
      : (() => {
          const rows: GridRowDto[] = recurringRows.map((item) => {
            const steps = parseAmountSteps(item.amountSteps);
            const cells = periods.map((period: PayPeriod) => {
              const due = recurringDueIn(
                [
                  {
                    id: item.id,
                    name: item.name,
                    // Сумма на дату периода: ступени работают и здесь.
                    amountMinor: amountOn(item.amountMinor, steps, period.startsOn),
                    currency: item.currency,
                    schedule: item.schedule as never,
                    startsOn: item.startsOn,
                    endsOn: item.endsOn,
                  },
                ],
                period,
              );
              const minor = due.reduce(
                (acc, d) => acc + (toBase(d.amountMinor, d.currency) ?? 0n),
                0n,
              );
              return {
                minor: minor.toString(),
                state: (minor > 0n ? 'planned' : 'none') as 'planned' | 'none',
              };
            });
            return {
              targetKind: 'recurring' as const,
              targetId: item.id,
              name: item.name,
              sourceCurrency: item.currency,
              cells,
              totalMinor: cells.reduce((acc, c) => acc + BigInt(c.minor), 0n).toString(),
              endsAfterIndex: null,
            };
          });
          const totals = periods.map((_: PayPeriod, i: number) =>
            rows.reduce((acc, r) => acc + BigInt(r.cells[i]!.minor), 0n).toString(),
          );
          return {
            kind: 'recurring',
            informational: true,
            rows,
            totals,
            totalMinor: totals.reduce((acc, v) => acc + BigInt(v), 0n).toString(),
          };
        })();

  const cellsToStrings = (cells: readonly bigint[]) => cells.map((v) => v.toString());

  /*
   * Доход — отдельная группа сверху: это не строка каскада, но без неё таблица не читается.
   *
   * Внутри группы — строка на источник, чтобы «57 420» можно было развернуть и увидеть, из чего
   * они сложились. Колонка «сейчас» считается той же арифметикой, что и итог периода в плане:
   * подтверждённое поступление берётся по своему снапшоту курса, ожидаемое — по сегодняшнему
   * (и ноль, если курса нет). Иначе строки не сошлись бы с суммой над ними, а таблица с двумя
   * разными правдами про одни деньги хуже таблицы без разбивки.
   */
  /* Нет курса — ноль, ровно как в итоге периода: план тоже не выдумывает неизвестную сумму. */
  const incomeToBase = (amountMinor: bigint, currency: string): bigint =>
    toBase(amountMinor, currency) ?? 0n;

  const incomeBySource = new Map<string, { label: string; currency: string; cells: bigint[] }>();
  const ensureRow = (sourceId: string, label: string, currency: string) => {
    const existing = incomeBySource.get(sourceId);
    if (existing) return existing;
    const fresh = { label, currency, cells: periods.map(() => 0n) };
    incomeBySource.set(sourceId, fresh);
    return fresh;
  };

  for (const e of plan.income.events) {
    const row = ensureRow(e.sourceId, e.label, e.currency);
    row.cells[0] =
      (row.cells[0] ?? 0n) +
      (e.baseAmountMinor !== undefined
        ? BigInt(e.baseAmountMinor)
        : incomeToBase(BigInt(e.amountMinor), e.currency));
  }

  periods.forEach((period: PayPeriod, i: number) => {
    if (i === 0) return;
    for (const e of incomeEventsIn(sources, period, weekendRule)) {
      const row = ensureRow(e.sourceId, e.label, e.currency);
      row.cells[i] = (row.cells[i] ?? 0n) + incomeToBase(e.amountMinor, e.currency);
    }
  });

  const incomeRows: GridRowDto[] = [...incomeBySource.entries()].map(([sourceId, row]) => ({
    targetKind: 'income' as const,
    targetId: sourceId,
    name: row.label,
    sourceCurrency: row.currency,
    cells: row.cells.map((v) => ({ minor: v.toString(), state: 'planned' as const })),
    totalMinor: row.cells.reduce((a, b) => a + b, 0n).toString(),
    endsAfterIndex: null,
  }));

  const incomeGroup: GridGroupDto = {
    kind: 'income',
    rows: incomeRows,
    totals: incomeMinor.map((v) => v.toString()),
    totalMinor: incomeMinor.reduce((a, b) => a + b, 0n).toString(),
  };

  /*
   * Матрица видимости для сетки (issue #84). `sum` показывает участнику суммы без имён, `hidden` —
   * не показывает ничего, но деньги всё равно остаются в итогах столбца.
   */
  const sectionMode = (kind: string): ShareMode => {
    if (!asMember) return 'open';
    const section = SHARING_SECTION_OF[kind];
    return section ? sharing[section] : 'open';
  };

  const hiddenGroups = grid.groups.filter((g) => sectionMode(g.kind) !== 'open');
  const privateGroup =
    hiddenGroups.length === 0
      ? null
      : {
          kind: 'private' as TargetKind,
          rows: [],
          totals: cellsToStrings(
            periods.map((_: PayPeriod, i: number) =>
              hiddenGroups.reduce((acc: bigint, g) => acc + (g.totals[i] ?? 0n), 0n),
            ),
          ),
          totalMinor: hiddenGroups.reduce((acc: bigint, g) => acc + g.totalMinor, 0n).toString(),
        };

  return {
    baseCurrency: base,
    periods: periods.map((p: PayPeriod, i: number) => ({
      startsOn: p.startsOn,
      endsOn: p.endsOn,
      daysInPeriod: daysOf(p),
      // Материализована только первая колонка: остальные — проекция, в БД их нет.
      materialized: i === 0,
    })),
    groups: [
      incomeGroup,
      ...(recurringGroup ? [recurringGroup] : []),
      ...grid.groups
        .filter((g) => sectionMode(g.kind) === 'open')
        .map((g) => ({
          kind: g.kind,
          rows: g.rows.map((r) => ({
            targetKind: r.targetKind,
            targetId: r.targetId,
            name: r.name,
            sourceCurrency: r.sourceCurrency,
            cells: r.cells.map((c) => ({ minor: c.minor.toString(), state: c.state })),
            totalMinor: r.totalMinor.toString(),
            endsAfterIndex: r.endsAfterIndex,
          })),
          totals: cellsToStrings(g.totals),
          totalMinor: g.totalMinor.toString(),
        })),
      /*
       * Закрытые разделы сворачиваются в «Личное» с суммами по колонкам, а не исчезают (issue #84).
       * Исчезновение хуже сокрытия: деньги пропали бы из столбцов, итоги перестали бы сходиться, и
       * участник спланировал бы на несуществующие деньги. Имён строк здесь нет — только суммы.
       */
      ...(privateGroup ? [privateGroup] : []),
    ],
    footer: {
      freeMinor: withCurrent(cellsToStrings(grid.footer.freeMinor), plan.freeMinor),
      /*
       * Первый столбец подвала — ровно с «Плана», не из сеточной сборки. Сетка делит всю жизнь на
       * всю длину периода; план — остаток на жизнь на ОСТАВШИЕСЯ дни, с учётом уже потраченного.
       * Для будущих столбцов сеточная формула верна (весь период впереди, факта нет), а текущий
       * обязан совпадать с «Планом» до копейки — иначе два экрана показывают за один день разное
       * (найдено осмотром механики 14.08.2026).
       */
      perDayMinor: withCurrent(cellsToStrings(grid.footer.perDayMinor), plan.canSpendPerDayMinor),
      toExchangeMinor: cellsToStrings(grid.footer.toExchangeMinor),
      toExchangeByCurrency: grid.footer.toExchangeByCurrency.map((x) => ({
        currency: x.currency,
        cells: cellsToStrings(x.cells),
      })),
    },
    unresolved,
  };
}
