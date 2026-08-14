/**
 * Демо-данные (issue #56). Один воркспейс, который любой смотрящий открывает без регистрации.
 *
 * Три правила этого файла:
 * 1. **Идемпотентность.** `seedDemo()` можно звать сколько угодно раз: он стирает данные
 *    демо-воркспейса и насыпает их заново. Пользователь и воркспейс переживают сброс, чтобы
 *    ссылка на демо не менялась.
 * 2. **Только английский** (правило демо-доступа): locale воркспейса — `en`, все названия строк
 *    английские, независимо от языка продукта.
 * 3. **Наполненность важнее аккуратности цифр.** Медианы, тренды, burn-rate и прогноз обязаны
 *    что-то показывать, поэтому сеется история шести закрытых периодов, а не только текущий.
 */

import { convert, exchangeResult, money } from '@multa/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import {
  accounts,
  categories,
  currencyBuckets,
  debts,
  envelopes,
  exchangeOps,
  fxManualRates,
  goals,
  incomeReceipts,
  incomeSources,
  payPeriods,
  plannedItems,
  planRevisions,
  receipts,
  recurringItems,
  transactions,
  workspaces,
} from '../db/schema/domain.ts';
import { user } from '../db/schema/auth.ts';
import { getRate } from '../fx/service.ts';
import { logger } from '../logger.ts';
import { ensurePeriodForDate } from '../plan/assemble.ts';

export const DEMO_EMAIL = 'demo@multa.local';
/** Пароль демо — спидбамп, не секрет: он и так уходит клиенту при входе в демо. */
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'multa-demo-2026';
const DEMO_TZ = 'Europe/Belgrade';

export interface DemoWorkspace {
  readonly workspaceId: string;
  readonly userId: string;
}

/** Демо-пользователь и его воркспейс, если они уже созданы. */
export async function findDemoWorkspace(): Promise<DemoWorkspace | null> {
  const users = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, DEMO_EMAIL))
    .limit(1);
  const u = users[0];
  if (!u) return null;
  const ws = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerId, u.id))
    .limit(1);
  return ws[0] ? { workspaceId: ws[0].id, userId: u.id } : null;
}

/** Воркспейс демо-пользователя: создаётся один раз, при сбросе только чистится. */
async function ensureWorkspace(userId: string): Promise<string> {
  const existing = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId))
    .limit(1);
  if (existing[0]) {
    await db
      .update(workspaces)
      .set({
        baseCurrency: 'RUB',
        locale: 'en',
        timezone: DEMO_TZ,
        periodAnchors: { kind: 'monthly-days', days: [10, 25], weekendRule: 'before' },
        paydayWeekendRule: 'before',
        onboardingSkipped: false,
        settings: DEMO_SETTINGS,
      })
      .where(eq(workspaces.id, existing[0].id));
    return existing[0].id;
  }
  const inserted = await db
    .insert(workspaces)
    .values({
      ownerId: userId,
      baseCurrency: 'RUB',
      locale: 'en',
      timezone: DEMO_TZ,
      periodAnchors: { kind: 'monthly-days', days: [10, 25], weekendRule: 'before' },
      paydayWeekendRule: 'before',
      settings: DEMO_SETTINGS,
    })
    .returning({ id: workspaces.id });
  return inserted[0]!.id;
}

/**
 * Демо приходят смотреть на наполненный продукт, а не учиться им пользоваться: обучающий тур
 * (issue #28) здесь выключен, иначе первый экран показа — затемнение с подсказкой, а не план.
 */
const DEMO_SETTINGS = { tour: { planDone: true } } as const;

/** Сдвиг даты на N дней в ISO. */
function shift(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Курсы, на которые демо опирается, если кэш ЦБ/ЕЦБ ещё пуст (чистая машина, CI, свежий прод). */
const DEMO_RATES: { base: string; rate: string }[] = [
  { base: 'EUR', rate: '90.9' },
  { base: 'RSD', rate: '0.78' },
];

/**
 * Подстраховка курсов демо. Без котировок валютные траты не записались бы («rate_unavailable»),
 * а копилка потерь на спреде осталась бы пустой — то есть демо не показало бы ровно то, ради чего
 * продукт и нужен. Вставляем как `manual` и только там, где котировки нет: настоящие курсы
 * приоритетнее и не перетираются.
 */
/**
 * Курсы демо — **личные** курсы демо-воркспейса, а не публичные котировки.
 *
 * Раньше они писались в глобальный `fx_rates` с `source: 'manual'`, и после появления приоритета
 * ручного курса (issue #48) вход в демо начал переопределять курс всем остальным воркспейсам:
 * транзакция реального пользователя в EUR считалась по демо-курсу вместо котировки ЦБ. Найдено
 * адверсарным аудитом. Теперь курсы живут в `fx_manual_rates` демо-воркспейса и наружу не видны
 * (правило 7).
 */
async function ensureDemoRates(
  workspaceId: string,
  asOf: string,
  days: readonly string[],
): Promise<void> {
  const dates = [...new Set([asOf, ...days])];
  await db
    .insert(fxManualRates)
    .values(
      dates.flatMap((onDate) =>
        DEMO_RATES.map((r) => ({
          workspaceId,
          base: r.base,
          quote: 'RUB',
          onDate,
          rate: r.rate,
        })),
      ),
    )
    .onConflictDoNothing();
}

/** Всё, что можно пересеять. Пользователь и воркспейс не трогаются — ссылка на демо стабильна. */
async function wipe(workspaceId: string): Promise<void> {
  const ws = eq(transactions.workspaceId, workspaceId);
  await db.delete(transactions).where(ws);
  await db.delete(exchangeOps).where(eq(exchangeOps.workspaceId, workspaceId));
  await db.delete(receipts).where(eq(receipts.workspaceId, workspaceId));
  await db.delete(planRevisions).where(eq(planRevisions.workspaceId, workspaceId));
  await db.delete(incomeReceipts).where(eq(incomeReceipts.workspaceId, workspaceId));
  await db.delete(fxManualRates).where(eq(fxManualRates.workspaceId, workspaceId));
  await db.delete(plannedItems).where(eq(plannedItems.workspaceId, workspaceId));
  await db.delete(payPeriods).where(eq(payPeriods.workspaceId, workspaceId));
  await db.delete(recurringItems).where(eq(recurringItems.workspaceId, workspaceId));
  await db.delete(incomeSources).where(eq(incomeSources.workspaceId, workspaceId));
  await db.delete(currencyBuckets).where(eq(currencyBuckets.workspaceId, workspaceId));
  await db.delete(debts).where(eq(debts.workspaceId, workspaceId));
  await db.delete(envelopes).where(eq(envelopes.workspaceId, workspaceId));
  await db.delete(goals).where(eq(goals.workspaceId, workspaceId));
  await db.delete(categories).where(eq(categories.workspaceId, workspaceId));
  await db.delete(accounts).where(eq(accounts.workspaceId, workspaceId));
}

/** Английские категории демо: пресеты продукта плюс те, что нужны валютным тратам. */
const DEMO_CATEGORIES: { name: string; sort: number; isSystem?: boolean; protected?: boolean }[] = [
  { name: 'Groceries', sort: 0 },
  { name: 'Eating out', sort: 1 },
  { name: 'Transport', sort: 2 },
  { name: 'Home', sort: 3 },
  { name: 'Kids', sort: 4, protected: true },
  { name: 'Health', sort: 5 },
  { name: 'Fun', sort: 6 },
  { name: 'General', sort: 99, isSystem: true },
];

/**
 * История факта по категориям за шесть закрытых периодов, в minor units базовой валюты.
 * Цифры подобраны так, чтобы аналитика говорила по делу: Groceries систематически выше плана
 * (вердикт «поднять план»), Transport растёт линейно (тренд), Fun скачет (вердикт «нестабильно»).
 */
const HISTORY: Record<string, number[]> = {
  Groceries: [1_920_000, 2_040_000, 2_180_000, 2_210_000, 2_340_000, 2_260_000],
  'Eating out': [1_320_000, 1_240_000, 1_410_000, 1_380_000, 1_290_000, 1_350_000],
  Transport: [460_000, 500_000, 540_000, 590_000, 620_000, 680_000],
  Fun: [610_000, 940_000, 520_000, 1_280_000, 490_000, 1_120_000],
  Home: [820_000, 800_000, 860_000, 840_000, 880_000, 860_000],
};

/** Бюджеты текущего периода: заниженные там, где история это покажет. */
const BUDGETS: Record<string, bigint> = {
  Groceries: 2_000_000n,
  'Eating out': 900_000n,
  Transport: 700_000n,
  Home: 500_000n,
  Kids: 400_000n,
  Fun: 300_000n,
};

/**
 * Пересеивает демо-воркспейс. Возвращает его id.
 *
 * Вызывается при входе в демо (если пусто), по расписанию и вручную из тестов.
 */
export async function seedDemo(userId: string): Promise<string> {
  const workspaceId = await ensureWorkspace(userId);
  await wipe(workspaceId);
  const asOf = today(DEMO_TZ);
  // Даты, на которые демо смотрит курсом: сегодня и дни разменов ниже.
  await ensureDemoRates(
    workspaceId,
    asOf,
    [20, 35, 50, 65].map((back) => shift(asOf, -back)),
  );

  const catRows = await db
    .insert(categories)
    .values(DEMO_CATEGORIES.map((c) => ({ workspaceId, ...c })))
    .returning({ id: categories.id, name: categories.name });
  const catId = (name: string): string => {
    const hit = catRows.find((c) => c.name === name);
    if (!hit) throw new Error(`demo seed: category ${name} missing`);
    return hit.id;
  };

  /*
   * Счета (issue #45): демо обязано показывать «сколько всего денег есть» — это первый блок плана.
   * Три валюты сразу, потому что продукт как раз про жизнь между валютами.
   */
  await db.insert(accounts).values([
    { workspaceId, name: 'Cash', currency: 'RUB', kind: 'cash', balanceMinor: 1_240_000n },
    { workspaceId, name: 'Debit card', currency: 'RUB', kind: 'card', balanceMinor: 5_130_000n },
    { workspaceId, name: 'Savings', currency: 'EUR', kind: 'savings', balanceMinor: 210_00n },
    { workspaceId, name: 'Dinar wallet', currency: 'RSD', kind: 'cash', balanceMinor: 980_000n },
  ]);

  await db.insert(incomeSources).values([
    {
      workspaceId,
      label: 'Salary · main',
      currency: 'RUB',
      schedule: { kind: 'monthly-days', days: [10] },
      amount: { kind: 'absolute', amountMinor: '19000000' },
      stability: 'fixed',
      sort: 0,
    },
    {
      workspaceId,
      label: 'Salary · advance',
      currency: 'RUB',
      schedule: { kind: 'monthly-days', days: [25] },
      amount: { kind: 'absolute', amountMinor: '12000000' },
      stability: 'fixed',
      sort: 1,
    },
    {
      workspaceId,
      label: 'Freelance · Upwork',
      currency: 'RUB',
      schedule: { kind: 'monthly-days', days: [10] },
      amount: { kind: 'absolute', amountMinor: '1800000' },
      stability: 'variable',
      sort: 2,
    },
  ]);

  // Долги: рассрочка закрывается следующим платежом — это даёт сигнал «освободится 8 000».
  await db.insert(debts).values([
    {
      workspaceId,
      name: 'Ozon installment',
      currency: 'RUB',
      principalMinor: 4_000_000n,
      remainingMinor: 800_000n,
      paymentMinor: 800_000n,
      counterparty: 'Ozon',
    },
    {
      workspaceId,
      name: 'Bank credit',
      currency: 'RUB',
      principalMinor: 24_000_000n,
      remainingMinor: 15_600_000n,
      paymentMinor: 1_200_000n,
      counterparty: 'Tinkoff',
    },
    /*
     * Заём (#94): деньги, которые должны вернуть. В демо он обязателен — без него смотрящий не
     * увидит, что раздел вообще есть, и решит, что продукт умеет только долги.
     *
     * Показывает главное свойство: платёж за период нулевой, потому что заём никто не откладывает.
     * В каскад он не входит и цифру дня не уменьшает — на экране это видно тем, что «Должны мне»
     * стоит отдельным разделом, а не строкой среди долгов.
     */
    {
      workspaceId,
      name: 'Lent to Marko',
      currency: 'EUR',
      direction: 'owed_to_me',
      principalMinor: 40_000n,
      remainingMinor: 25_000n,
      paymentMinor: 0n,
      counterparty: 'Marko',
    },
  ]);

  await db.insert(envelopes).values([
    { workspaceId, name: 'Investments', currency: 'RUB', ruleKind: 'percent', ruleValue: '10' },
    // ruleValue у fixed — minor units (так же его пишет и форма конвертов): 3 000 RUB.
    { workspaceId, name: 'Health buffer', currency: 'RUB', ruleKind: 'fixed', ruleValue: '300000' },
  ]);

  await db.insert(goals).values([
    {
      workspaceId,
      name: 'Motorcycle',
      currency: 'RUB',
      targetMinor: 42_000_000n,
      savedMinor: 21_000_000n,
      plannedPerPeriodMinor: 420_000n,
    },
    {
      workspaceId,
      name: 'Vacation · Montenegro',
      currency: 'EUR',
      targetMinor: 80_000n,
      savedMinor: 56_000n,
      plannedPerPeriodMinor: 5_000n,
    },
  ]);

  // Валютные корзины: тот самый сценарий продукта — доход в рублях, жизнь в EUR и RSD.
  await db.insert(currencyBuckets).values([
    {
      workspaceId,
      name: 'Rent basket',
      fromCurrency: 'RUB',
      toCurrency: 'EUR',
      amountMinor: 6_000_000n,
    },
    {
      workspaceId,
      name: 'Daily life basket',
      fromCurrency: 'RUB',
      toCurrency: 'RSD',
      amountMinor: 2_000_000n,
    },
  ]);

  await db.insert(recurringItems).values([
    {
      workspaceId,
      kind: 'expense',
      name: 'Apartment rent',
      amountMinor: 65_000n,
      currency: 'EUR',
      schedule: { kind: 'monthly-days', days: [25] },
    },
    {
      workspaceId,
      kind: 'expense',
      name: 'Utilities',
      amountMinor: 820_000n,
      currency: 'RSD',
      schedule: { kind: 'monthly-days', days: [1] },
    },
    {
      workspaceId,
      kind: 'expense',
      name: 'Internet + mobile',
      amountMinor: 310_000n,
      currency: 'RSD',
      schedule: { kind: 'monthly-days', days: [5] },
    },
    {
      workspaceId,
      kind: 'expense',
      name: 'Subscriptions · 4',
      amountMinor: 240_000n,
      currency: 'RUB',
      schedule: { kind: 'monthly-days', days: [12] },
    },
    {
      workspaceId,
      kind: 'expense',
      name: 'Gym',
      amountMinor: 450_000n,
      currency: 'RSD',
      schedule: { kind: 'monthly-days', days: [15] },
    },
    /*
     * Новые правила повтора (issue #55) должны быть видны в демо, иначе фича есть, а показать её
     * нечем: «второй вторник месяца», «раз в год» и «в каждую выплату».
     */
    {
      workspaceId,
      kind: 'expense',
      name: 'Cleaning lady',
      amountMinor: 350_000n,
      currency: 'RSD',
      schedule: { kind: 'monthly-nth-weekday', nth: 2, weekday: 2 },
    },
    {
      workspaceId,
      kind: 'expense',
      name: 'Car insurance',
      amountMinor: 4_200_000n,
      currency: 'RSD',
      schedule: { kind: 'yearly', month: 9, day: 12 },
    },
    {
      workspaceId,
      kind: 'expense',
      name: 'Kids club',
      amountMinor: 300_000n,
      currency: 'RUB',
      schedule: { kind: 'each-payout' },
      // Тумблер карты в демо тоже показан: событие есть, метки нет — карта не должна зарастать.
      showOnMap: false,
    },
  ]);

  const ws = (
    await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
  )[0]!;

  // Бюджеты текущего периода. Пишем прямо в planned_items: сборка плана их подхватит.
  const current = await ensurePeriodForDate(ws, asOf);
  await db.insert(plannedItems).values(
    Object.entries(BUDGETS).map(([name, plannedMinor]) => ({
      workspaceId,
      periodId: current.periodId,
      targetKind: 'category' as const,
      targetId: catId(name),
      plannedMinor,
      executionStatus: 'n_a' as const,
    })),
  );

  /*
   * Подтверждённое поступление (issue #48) и правка плана (issue #52): демо обязано показывать
   * работающие фичи, а не только их наличие в коде. Иначе смотрящий видит пустые панели там, где у
   * реального пользователя главные события периода.
   */
  const salary = (
    await db
      .select({ id: incomeSources.id, amount: incomeSources.amount })
      .from(incomeSources)
      .where(and(eq(incomeSources.workspaceId, workspaceId), eq(incomeSources.currency, 'RUB')))
      .limit(1)
  )[0];
  if (salary) {
    // Пришло чуть меньше плановой суммы — как в жизни, и цифра дня считается по факту.
    await db.insert(incomeReceipts).values({
      workspaceId,
      sourceId: salary.id,
      occurredOn: current.period.startsOn,
      amountMinor: 18_700_000n,
      currency: 'RUB',
      baseAmountMinor: 18_700_000n,
      rate: '1',
      rateSource: 'identity',
      rateDate: current.period.startsOn,
    });
  }

  // Одна правка в истории: «взяли из Fun, добавили в Groceries» — панель истории не пустая.
  const from = catId('Fun');
  const to = catId('Groceries');
  // Суммы берём из того же словаря бюджетов: правка обязана быть согласована с планом периода.
  const funBudget = BUDGETS.Fun ?? 0n;
  const groceriesBudget = BUDGETS.Groceries ?? 0n;
  const moveMinor = 50_000n;
  await db
    .update(plannedItems)
    .set({ plannedMinor: funBudget - moveMinor })
    .where(and(eq(plannedItems.periodId, current.periodId), eq(plannedItems.targetId, from)));
  await db
    .update(plannedItems)
    .set({ plannedMinor: groceriesBudget + moveMinor })
    .where(and(eq(plannedItems.periodId, current.periodId), eq(plannedItems.targetId, to)));
  await db.insert(planRevisions).values({
    workspaceId,
    periodId: current.periodId,
    reason: 'overspend',
    moves: [
      {
        fromKind: 'category',
        fromId: from,
        toKind: 'category',
        toId: to,
        amountMinor: moveMinor.toString(),
      },
    ],
  });

  // Факт закрытых периодов: по одной сводной трате на категорию и период («крупный мазок» —
  // легитимный сценарий продукта, а не деградация).
  const historyRows: (typeof transactions.$inferInsert)[] = [];
  /*
   * Дни истории отсчитываются от НАЧАЛА текущего периода, а не от «сегодня» (issue #88).
   *
   * Было `shift(asOf, -15 * back + 4)`: при полумесячном ритме и длинном периоде ближайший день
   * истории (asOf − 11) заезжал внутрь текущего периода, и сводная трата закрытого месяца
   * записывалась как трата этого. Демо копило чужой факт — 88 878 вместо 26 000 — и показывало
   * «деньги кончились сегодня, на день 0». Причём только во второй половине периода, из-за чего
   * это выглядело как флейк теста, а не как баг.
   */
  for (let back = 6; back >= 1; back -= 1) {
    const day = shift(current.period.startsOn, -15 * back + 4);
    const { periodId } = await ensurePeriodForDate(ws, day);
    // Fail-fast: молчаливое попадание истории в текущий период — ровно тот баг, что был выше.
    if (periodId === current.periodId) {
      throw new Error(`demo_seed_history_in_current_period:${day}`);
    }
    for (const [name, series] of Object.entries(HISTORY)) {
      const amount = BigInt(series[6 - back] ?? series[series.length - 1]!);
      historyRows.push({
        workspaceId,
        periodId,
        kind: 'expense',
        targetKind: 'category',
        targetId: catId(name),
        amountMinor: amount,
        currency: 'RUB',
        baseAmountMinor: amount,
        rate: '1',
        rateSource: 'base',
        rateDate: day,
        occurredOn: day,
        source: 'manual',
      });
    }
  }

  // Факт текущего периода: Groceries почти исчерпаны (даёт burn-сигнал), Transport ещё пуст.
  const eurRate = await getRate('EUR', 'RUB', asOf, workspaceId);
  const rsdRate = await getRate('RSD', 'RUB', asOf, workspaceId);
  const currentFacts: {
    name: string;
    minor: bigint;
    currency: 'RUB' | 'EUR' | 'RSD';
    day: string;
    note?: string;
  }[] = [
    {
      name: 'Groceries',
      minor: 1_800_000n,
      currency: 'RUB',
      day: shift(asOf, -3),
      note: 'groceries for the week',
    },
    { name: 'Eating out', minor: 610_000n, currency: 'RUB', day: shift(asOf, -2) },
    { name: 'Eating out', minor: 450n, currency: 'EUR', day: shift(asOf, -1), note: 'coffee' },
    { name: 'Home', minor: 214_000n, currency: 'RSD', day: shift(asOf, -1) },
  ];
  /*
   * Факт масштабируется по пройденной части периода (issue #88).
   *
   * До этого суммы были фиксированными: демо тратило одни и те же 26 000 и на второй день периода,
   * и на предпоследний. Ближе к выплате это превращалось в «деньги кончились сегодня, на день 0» —
   * то есть человек, которому дали ссылку, видел сломанный бюджет вместо продукта. Теперь темп
   * трат ровный: доля потраченного равна доле прошедшего времени, а сама доля заведомо ниже плана,
   * поэтому цифра дня остаётся положительной в любой день периода.
   */
  const periodDays = BigInt(
    Math.max(
      1,
      Math.round(
        (Date.parse(`${current.period.endsOn}T00:00:00Z`) -
          Date.parse(`${current.period.startsOn}T00:00:00Z`)) /
          86_400_000,
      ),
    ),
  );
  const elapsedDays = BigInt(
    Math.min(
      Number(periodDays),
      Math.max(
        1,
        Math.round(
          (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${current.period.startsOn}T00:00:00Z`)) /
            86_400_000,
        ),
      ),
    ),
  );
  /** Целочисленно: деньги — minor units, float в них запрещён (правило 1). */
  const soFar = (minor: bigint): bigint => (minor * elapsedDays) / periodDays;

  /*
   * Дни трат прижимаем к началу периода. Сид ставит их как «сегодня минус 1..3 дня», и в первый же
   * день нового периода все три уезжали в предыдущий: демо показывало период без единой траты, а
   * «потрачено» — ноль (поймано инвариантом demo.test.ts 10.08.2026). Трата вне периода не только
   * портит картинку, она искажает и темп: цифра дня считается по факту внутри периода.
   */
  const inPeriod = (day: string): string =>
    day < current.period.startsOn ? current.period.startsOn : day;

  for (const f of currentFacts) {
    const snap = f.currency === 'RUB' ? null : f.currency === 'EUR' ? eurRate : rsdRate;
    /*
     * Через ядровой `convert`, а не `Number(...) * Number(...)`: float в деньгах запрещён (правило
     * 1), и он же игнорирует экспоненты валют — RSD с exponent 0 пересчитывался как двузначный.
     * Рядом, у разменов, уже использовался convert; здесь остался старый расчёт (найдено аудитом).
     */
    const amountMinor = soFar(f.minor);
    // Ноль тратой не показываем: пустая строка «0» в списке трат читается как сбой ввода.
    if (amountMinor <= 0n) continue;
    const baseAmountMinor = snap
      ? convert(money(amountMinor, f.currency), snap).minor
      : amountMinor;
    historyRows.push({
      workspaceId,
      periodId: current.periodId,
      kind: 'expense',
      targetKind: 'category',
      targetId: catId(f.name),
      amountMinor,
      currency: f.currency,
      baseAmountMinor,
      rate: snap ? snap.rate : '1',
      rateSource: snap ? snap.source : 'base',
      rateDate: snap ? snap.date : inPeriod(f.day),
      occurredOn: inPeriod(f.day),
      source: 'manual',
      ...(f.note ? { note: f.note } : {}),
    });
  }
  await db.insert(transactions).values(historyRows);

  /*
   * История разменов. Полученную сумму НЕ хардкодим: она считается от официального курса на дату
   * минус заданный спред в базисных пунктах. Иначе демо показывает бессмыслицу — до 31.07.2026
   * суммы стояли константами, и на экране статистики средний спред выходил −0,4% при отдельных
   * операциях «+9,4%» и «−30,8%», то есть меняла как будто платил сверху рыночного курса.
   */
  const fxHistory: {
    from: 'RUB';
    to: 'EUR' | 'RSD';
    fromMinor: bigint;
    spreadBp: bigint;
    back: number;
    provider: string;
  }[] = [
    /*
     * Разные обменники с повторяемостью: сравнение провайдеров (issue #53) молчит, пока у лучшего
     * одна сделка, поэтому у Wise их две — иначе демо показывает панель без главного вывода.
     */
    {
      from: 'RUB',
      to: 'EUR',
      fromMinor: 6_000_000n,
      spreadBp: 180n,
      back: 20,
      provider: 'Menjačnica',
    },
    {
      from: 'RUB',
      to: 'RSD',
      fromMinor: 4_000_000n,
      spreadBp: 90n,
      back: 35,
      provider: 'Menjačnica',
    },
    { from: 'RUB', to: 'EUR', fromMinor: 6_000_000n, spreadBp: 260n, back: 50, provider: 'Bank' },
    { from: 'RUB', to: 'EUR', fromMinor: 5_500_000n, spreadBp: 120n, back: 65, provider: 'Wise' },
    { from: 'RUB', to: 'EUR', fromMinor: 4_500_000n, spreadBp: 110n, back: 12, provider: 'Wise' },
  ];
  for (const op of fxHistory) {
    const day = shift(asOf, -op.back);
    const official = await getRate(op.from, op.to, day, workspaceId);
    if (!official) continue;
    // Честная сумма по официальному курсу, затем удержание спреда — так это и происходит у менялы.
    const fairMinor = convert(money(op.fromMinor, op.from), official).minor;
    const toMinor = fairMinor - (fairMinor * op.spreadBp) / 10_000n;
    // Спред считает то же ядро, что и роут размена: у демо-данных не должно быть своей арифметики,
    // иначе «сколько я теряю на менялах» в демо и в жизни расходились бы.
    const result = exchangeResult({
      fromMinor: op.fromMinor,
      fromCurrency: op.from,
      toMinor,
      toCurrency: op.to,
      official,
    });
    if (result.effectiveRate === null) continue;
    await db.insert(exchangeOps).values({
      workspaceId,
      fromCurrency: op.from,
      toCurrency: op.to,
      fromMinor: op.fromMinor,
      toMinor,
      actualRate: result.effectiveRate,
      officialRate: official.rate,
      officialSource: official.source,
      ...(result.spreadPct !== null ? { spreadPct: result.spreadPct } : {}),
      ...(result.lostMinor !== null ? { spreadMinor: result.lostMinor } : {}),
      occurredOn: day,
      provider: op.provider,
    });
  }

  logger.info(`demo: воркспейс ${workspaceId} пересеян (${historyRows.length} транзакций)`);
  return workspaceId;
}

/** Пусто ли демо: по этому признаку вход в демо решает, сеять ли заново. */
export async function demoIsEmpty(workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(categories)
    .where(
      and(eq(categories.workspaceId, workspaceId), inArray(categories.archived, [true, false])),
    );
  return (rows[0]?.n ?? 0) === 0;
}
