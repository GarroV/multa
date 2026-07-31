import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { user } from './auth.ts';

// Хелперы общих колонок.
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ccy = (name: string) => char(name, { length: 3 });

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    baseCurrency: ccy('base_currency').notNull().default('RUB'),
    timezone: text('timezone').notNull().default('Europe/Belgrade'),
    locale: text('locale').notNull().default('ru'),
    // Ритм планирования: PeriodConfig из @multa/core. Задаёт ГРАНИЦЫ периодов.
    // Деньги здесь не живут — они в income_sources (правило «ритм ≠ деньги»).
    periodAnchors: jsonb('period_anchors'),
    // Правило переноса выплаты, попавшей на выходной. Влияет на границы периодов.
    paydayWeekendRule: text('payday_weekend_rule').notNull().default('before'),
    // Пользователь пропустил обучение: пускаем в приложение без дохода (план будет пустым).
    // Флаг на сервере, а не в localStorage: с другого устройства онбординг не должен спрашивать заново.
    onboardingSkipped: boolean('onboarding_skipped').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    check('workspaces_weekend_rule_ck', sql`${t.paydayWeekendRule} in ('as-is','before','after')`),
  ],
);

/**
 * Источники дохода: только деньги (сколько и когда приходит). Границы периодов задаёт
 * ритм воркспейса (workspaces.period_anchors), поэтому здесь нет ни якорей, ни флагов.
 * schedule/amount — jsonb с типами IncomeSchedule/IncomeAmount из @multa/core;
 * суммы внутри jsonb — строки-целые minor units (bigint в JSON не кладём).
 */
export const incomeSources = pgTable(
  'income_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    currency: ccy('currency').notNull(),
    schedule: jsonb('schedule').notNull(),
    amount: jsonb('amount').notNull(),
    stability: text('stability').notNull().default('fixed'),
    active: boolean('active').notNull().default(true),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    sort: integer('sort').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('income_sources_stability_ck', sql`${t.stability} in ('fixed','variable')`),
    index('income_sources_ws_idx').on(t.workspaceId, t.sort),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    currency: ccy('currency').notNull(),
    kind: text('kind').notNull(),
    balanceMinor: bigint('balance_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    archived: boolean('archived').notNull().default(false),
  },
  (t) => [check('accounts_kind_ck', sql`${t.kind} in ('cash','card','savings','other')`)],
);

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  icon: text('icon'),
  isSystem: boolean('is_system').notNull().default(false),
  protected: boolean('protected').notNull().default(false),
  sort: integer('sort').notNull().default(0),
  archived: boolean('archived').notNull().default(false),
});

export const payPeriods = pgTable(
  'pay_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    expectedIncomeMinor: bigint('expected_income_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    status: text('status').notNull().default('planned'),
  },
  (t) => [
    unique('pay_periods_ws_start_uq').on(t.workspaceId, t.startsOn),
    check('pay_periods_status_ck', sql`${t.status} in ('planned','active','closed')`),
  ],
);

export const debts = pgTable('debts', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  currency: ccy('currency').notNull(),
  principalMinor: bigint('principal_minor', { mode: 'bigint' }).notNull(),
  remainingMinor: bigint('remaining_minor', { mode: 'bigint' }).notNull(),
  paymentMinor: bigint('payment_minor', { mode: 'bigint' }).notNull(),
  dueDate: date('due_date'),
  counterparty: text('counterparty'),
  agreedRate: numeric('agreed_rate', { precision: 20, scale: 10 }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const envelopes = pgTable(
  'envelopes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    currency: ccy('currency').notNull(),
    ruleKind: text('rule_kind').notNull(),
    ruleValue: numeric('rule_value', { precision: 12, scale: 4 }).notNull(),
    balanceMinor: bigint('balance_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (t) => [check('envelopes_rule_kind_ck', sql`${t.ruleKind} in ('fixed','percent')`)],
);

export const goals = pgTable('goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  currency: ccy('currency').notNull(),
  targetMinor: bigint('target_minor', { mode: 'bigint' }).notNull(),
  savedMinor: bigint('saved_minor', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  plannedPerPeriodMinor: bigint('planned_per_period_minor', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  achievedAt: timestamp('achieved_at', { withTimezone: true }),
});

export const currencyBuckets = pgTable('currency_buckets', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  fromCurrency: ccy('from_currency').notNull(),
  toCurrency: ccy('to_currency').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  active: boolean('active').notNull().default(true),
});

export const plannedItems = pgTable(
  'planned_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    periodId: uuid('period_id')
      .notNull()
      .references(() => payPeriods.id, { onDelete: 'cascade' }),
    targetKind: text('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    plannedMinor: bigint('planned_minor', { mode: 'bigint' }).notNull(),
    executionStatus: text('execution_status').notNull().default('pending'),
    executedMinor: bigint('executed_minor', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    auto: boolean('auto').notNull().default(false),
  },
  (t) => [
    unique('planned_items_uq').on(t.periodId, t.targetKind, t.targetId),
    check(
      'planned_items_target_ck',
      sql`${t.targetKind} in ('category','debt','envelope','goal','bucket')`,
    ),
    check(
      'planned_items_status_ck',
      sql`${t.executionStatus} in ('pending','confirmed','partial','skipped','n_a')`,
    ),
  ],
);

export const planRevisions = pgTable(
  'plan_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    periodId: uuid('period_id')
      .notNull()
      .references(() => payPeriods.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    moves: jsonb('moves').notNull(),
    accepted: boolean('accepted').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'plan_revisions_reason_ck',
      sql`${t.reason} in ('overspend','manual','income_change','auto_suggest')`,
    ),
  ],
);

export const receipts = pgTable(
  'receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    method: text('method'),
    merchant: text('merchant'),
    totalMinor: bigint('total_minor', { mode: 'bigint' }),
    currency: ccy('currency'),
    purchasedAt: timestamp('purchased_at', { withTimezone: true }),
    items: jsonb('items'),
    imagePath: text('image_path'),
    qrPayload: text('qr_payload'),
  },
  (t) => [
    check('receipts_status_ck', sql`${t.status} in ('pending','parsed','fallback','failed')`),
    check(
      'receipts_method_ck',
      sql`${t.method} is null or ${t.method} in ('qr_fns','qr_rs','vision')`,
    ),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id),
    periodId: uuid('period_id').references(() => payPeriods.id),
    kind: text('kind').notNull(),
    targetKind: text('target_kind'),
    targetId: uuid('target_id'),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: ccy('currency').notNull(),
    baseAmountMinor: bigint('base_amount_minor', { mode: 'bigint' }).notNull(),
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
    rateSource: text('rate_source').notNull(),
    rateDate: date('rate_date').notNull(),
    occurredOn: date('occurred_on').notNull(),
    source: text('source').notNull().default('manual'),
    note: text('note'),
    rawInput: text('raw_input'),
    receiptId: uuid('receipt_id').references(() => receipts.id),
    transferPairId: uuid('transfer_pair_id'),
    plannedItemId: uuid('planned_item_id').references(() => plannedItems.id),
  },
  (t) => [
    check(
      'transactions_kind_ck',
      sql`${t.kind} in ('expense','income','transfer_out','transfer_in','exchange')`,
    ),
    check(
      'transactions_source_ck',
      sql`${t.source} in ('manual','text','voice','receipt','recurring','import')`,
    ),
    check(
      'transactions_target_ck',
      sql`${t.targetKind} is null or ${t.targetKind} in ('category','debt','envelope','goal')`,
    ),
  ],
);

export const exchangeOps = pgTable('exchange_ops', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  bucketId: uuid('bucket_id').references(() => currencyBuckets.id),
  // Счета появятся позже (в MVP их нет), поэтому валюты хранятся в самой операции,
  // а ссылки на счёт опциональны: размен «наличкой у меняльника» тоже факт.
  fromAccount: uuid('from_account').references(() => accounts.id),
  toAccount: uuid('to_account').references(() => accounts.id),
  fromCurrency: ccy('from_currency').notNull(),
  toCurrency: ccy('to_currency').notNull(),
  fromMinor: bigint('from_minor', { mode: 'bigint' }).notNull(),
  toMinor: bigint('to_minor', { mode: 'bigint' }).notNull(),
  actualRate: numeric('actual_rate', { precision: 20, scale: 10 }).notNull(),
  // Официального курса на дату может не быть — тогда спред не считается (null, а не ноль).
  officialRate: numeric('official_rate', { precision: 20, scale: 10 }),
  officialSource: text('official_source'),
  spreadPct: numeric('spread_pct', { precision: 8, scale: 4 }),
  spreadMinor: bigint('spread_minor', { mode: 'bigint' }),
  occurredOn: date('occurred_on').notNull(),
  note: text('note'),
});

export const recurringItems = pgTable(
  'recurring_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    targetId: uuid('target_id'),
    name: text('name').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: ccy('currency').notNull(),
    schedule: jsonb('schedule').notNull(),
    nextOn: date('next_on'),
    escalation: jsonb('escalation'),
    active: boolean('active').notNull().default(true),
  },
  // Доходы живут в income_sources — две правды об одном факте дали бы дрейф.
  (t) => [check('recurring_items_kind_ck', sql`${t.kind} in ('expense','envelope','goal','debt')`)],
);

// Глобальный кэш официальных курсов (публичные данные, без workspace). Исторические не меняются.
export const fxRates = pgTable(
  'fx_rates',
  {
    source: text('source').notNull(),
    base: char('base', { length: 3 }).notNull(),
    quote: char('quote', { length: 3 }).notNull(),
    onDate: date('on_date').notNull(),
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.base, t.quote, t.onDate] })],
);
