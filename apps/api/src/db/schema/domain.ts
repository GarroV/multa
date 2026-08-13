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
    /**
     * Когда онбординг был завершён впервые (Спринт 6, метрики).
     *
     * Флаг завершённости считался на лету при каждом запросе и нигде не сохранялся, поэтому воронку
     * нельзя было посчитать даже задним числом: брошенный на середине не отличался от «ещё не
     * дошёл». Момент фиксируется один раз и не переписывается — иначе это уже не воронка.
     */
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    /**
     * Последняя активность владельца — сырьё для возврата на 7-й день.
     *
     * Таблица сессий better-auth знает даты входов, но её никто не читал, а сессия живёт неделями:
     * «зашёл» и «пользовался» это разные события. Пишем при чтении плана, не чаще раза в сутки.
     */
    lastActiveOn: date('last_active_on'),
    /**
     * Настройки поведения (issue #49): буфер цифры дня, порядок сжатия, горизонт медианы, курс и
     * спред по умолчанию. jsonb, а не колонки: набор растёт вместе с интерфейсом, а правда о форме
     * живёт в `workspaceSettingsSchema` — она же чинит старые записи дефолтами при чтении.
     */
    settings: jsonb('settings'),
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

export const debts = pgTable(
  'debts',
  {
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
    /**
     * Ступени суммы платежа: «с такой-то даты столько-то» (запрос владельца 06.08.2026).
     * Пустой список = сумма не меняется, поэтому старые строки остаются валидными.
     * Правило «сколько действует на дату» — `amountOn` в @multa/core, один источник на всех.
     */
    amountSteps: jsonb('amount_steps'),
    /**
     * Кто кому должен (issue #94). `owed_by_me` — обычный долг, деньги уходят; `owed_to_me` — заём,
     * деньги должны прийти.
     *
     * Одно поле вместо второй таблицы: у займа те же колонки — сумма, остаток, срок, контрагент, — а
     * четвёртая почти такая же таблица гарантированно разошлась бы поведением с остальными тремя.
     *
     * Но в каскад заём не попадает НИКОГДА: иначе раздача начала бы откладывать деньги на возврат
     * чужого долга, то есть резервировать то, чего у человека нет, и цифра дня уменьшалась бы вместо
     * роста. Числа сошлись бы, смысл был бы перевёрнут — самая тихая из возможных ошибок.
     */
    direction: text('direction').notNull().default('owed_by_me'),
    counterparty: text('counterparty'),
    agreedRate: numeric('agreed_rate', { precision: 20, scale: 10 }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    /* Значение вне пары молча превратило бы заём в долг — то есть перевернуло бы знак денег. */
    check('debts_direction_ck', sql`${t.direction} in ('owed_by_me','owed_to_me')`),
  ],
);

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
    /**
     * Осознанный пропуск взноса в этом периоде (issue #54). Признак на строке периода, а не на
     * цели: флаг на цели забывается и превращается в вечный пропуск.
     */
    frozen: boolean('frozen').notNull().default(false),
    /**
     * Сумму этой строки правил человек (пересборка плана), и сборка не имеет права её пересчитать
     * из таблицы обязательства. Без признака списание с цели затиралось на следующей же сборке:
     * прибавка получателю оставалась, дефицит закрывал каскад, и деньги теряла другая цель —
     * та, которую никто не выбирал (найдено адверсарным аудитом).
     */
    overridden: boolean('overridden').notNull().default(false),
  },
  (t) => [
    unique('planned_items_uq').on(t.periodId, t.targetKind, t.targetId),
    check(
      'planned_items_target_ck',
      /* 'recurring' — регулярный платёж, который откладывают отдельной строкой (флаг `reserve`). */
      sql`${t.targetKind} in ('category','debt','envelope','goal','bucket','recurring')`,
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
      sql`${t.reason} in ('overspend','manual','income_change','auto_suggest','undo')`,
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
    /**
     * Ссылка на плановую строку — связь исполнения с планом. `ON DELETE set null`: плановая строка
     * живёт один период и исчезает вместе с обязательством (удалили цель, закрыли долг, пропал
     * курс), а **факт исполнения обязан переживать это** — в транзакции лежит иммутабельный
     * снапшот курса (правило 2), и терять его нельзя. Без set null сборка плана падала на FK и
     * экран плана 500-ил навсегда (найдено адверсарным аудитом).
     */
    plannedItemId: uuid('planned_item_id').references(() => plannedItems.id, {
      onDelete: 'set null',
    }),
    /** Пачка импорта, создавшая строку: по ней импорт откатывается целиком (issue #76). */
    importBatchId: uuid('import_batch_id').references(() => importBatches.id, {
      onDelete: 'set null',
    }),
    /**
     * Отпечаток строки исходной таблицы (дата + сумма + позиция). По нему повторная загрузка того
     * же файла не удваивает историю: совпадения считаются дублями и показываются числом.
     */
    importKey: text('import_key'),
    /**
     * Ключ попытки записи, сгенерированный клиентом (офлайн-очередь, Спринт 6).
     *
     * Трата, записанная без сети, лежит в очереди и отправляется повторно при появлении связи. Без
     * ключа повтор создал бы вторую такую же трату — и человек увидел бы двойной расход, не поняв,
     * откуда он. Уникальность стоит в базе, а не в коде: на удачу такое не оставляют.
     */
    clientKey: text('client_key'),
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
    // Отпечаток импортированной строки уникален в воркспейсе: защита от удвоения истории стоит в
    // базе, а не только в коде — повторную загрузку файла не должна спасать только удача.
    unique('transactions_import_key_uq').on(t.workspaceId, t.importKey),
    unique('transactions_client_key_uq').on(t.workspaceId, t.clientKey),
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
  /**
   * Где меняли (issue #53). Отдельная колонка, а не заметка: по ней считается сравнение
   * провайдеров — одна из двух заявленных ценностей продукта. В заметке это была строка «для
   * человека», по которой нельзя ни сгруппировать, ни сравнить.
   */
  provider: text('provider'),
  occurredOn: date('occurred_on').notNull(),
  note: text('note'),
});

/**
 * Участники воркспейса (issue #46). Владелец — строка с ролью `owner`, он же `workspaces.owner_id`;
 * дубль намеренный: список участников должен читаться одним запросом, без объединения с другой
 * таблицей.
 *
 * Правило продукта: правит строку только её владелец. Участник видит воркспейс по матрице
 * видимости, но ничего в нём не меняет — это держит middleware, а не доверие к клиенту (правило 7).
 */
export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    check('workspace_members_role_ck', sql`${t.role} in ('owner','member')`),
    // Один и тот же человек не может состоять в воркспейсе дважды.
    unique('workspace_members_uq').on(t.workspaceId, t.userId),
  ],
);

/**
 * Приглашение по коду (issue #46). Почты в профиле $0 нет, поэтому ссылку владелец передаёт сам —
 * код одноразовый и сгорает после принятия.
 */
export const workspaceInvites = pgTable('workspace_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  code: text('code').notNull().unique(),
  createdAt: createdAt(),
  acceptedBy: text('accepted_by').references(() => user.id, { onDelete: 'set null' }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
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
    /** Первая дата платежа: до неё событий нет (issue #55). */
    startsOn: date('starts_on'),
    /** Отменённая подписка перестаёт быть событием, но остаётся в истории. */
    endsOn: date('ends_on'),
    /**
     * Показывать ли платёж на карте периода (issue #55). Default true: сейчас там видны все
     * платежи, и миграция не имеет права молча обрезать человеку карту.
     */
    showOnMap: boolean('show_on_map').notNull().default(true),
    nextOn: date('next_on'),
    /**
     * Откладывать деньги на этот платёж отдельной строкой каскада.
     *
     * По умолчанию false, и это не осторожность, а единственный честный дефолт: большинство
     * регулярных трат уже сидит внутри бюджета «Расходов», и включить их в раздачу молча значило бы
     * посчитать одни деньги дважды. Знает об этом только человек, поэтому решение — его, построчно.
     */
    reserve: boolean('reserve').notNull().default(false),
    /**
     * Ступени суммы: «интернет 2 500 до октября, потом 4 000». Раньше на этом месте стояла
     * `escalation` — колонка, объявленная и не использованная ни строчкой кода за всё время.
     * Расплывчатое имя под точный смысл хуже отсутствия поля: следующий читатель гадает, что оно
     * делает, и не находит ответа в коде.
     */
    amountSteps: jsonb('amount_steps'),
    active: boolean('active').notNull().default(true),
  },
  // Доходы живут в income_sources — две правды об одном факте дали бы дрейф.
  (t) => [check('recurring_items_kind_ck', sql`${t.kind} in ('expense','envelope','goal','debt')`)],
);

// Глобальный кэш официальных курсов (публичные данные, без workspace). Исторические не меняются.
/**
 * Подтверждённые поступления дохода (issue #48). Пока выплаты нет, план считает по ожидаемой
 * сумме источника; подтверждение фиксирует, сколько пришло на самом деле и по какому курсу.
 *
 * Курс лежит снапшотом (правило 2): человек вводит курс дня выплаты, глядя на табло обменника, и
 * последующая публикация котировок не имеет права переписать историю.
 */
export const incomeReceipts = pgTable(
  'income_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => incomeSources.id, { onDelete: 'cascade' }),
    occurredOn: date('occurred_on').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
    currency: ccy('currency').notNull(),
    baseAmountMinor: bigint('base_amount_minor', { mode: 'bigint' }).notNull(),
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
    rateSource: text('rate_source').notNull(),
    rateDate: date('rate_date').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => [
    // Одно подтверждение на выплату источника: иначе доход периода удваивался бы молча.
    unique('income_receipts_source_day_uq').on(t.workspaceId, t.sourceId, t.occurredOn),
    index('income_receipts_ws_day_idx').on(t.workspaceId, t.occurredOn),
  ],
);

/**
 * Личные курсы воркспейса (issue #48): курс дня выплаты, который человек ввёл руками, глядя на
 * табло обменника. Отдельно от `fx_rates` намеренно — там публичные котировки, общие для всех
 * воркспейсов, и запись личного факта туда протекала бы в чужие планы (правило 7).
 */
/**
 * Пачка импорта (issue #76): чем именно и когда была залита история. Нужна ровно для одного —
 * чтобы импорт можно было **откатить целиком**: перенос четырёх лет вслепую человек делать не
 * станет, если отменить его нельзя.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    sheet: text('sheet').notNull(),
    rowsTotal: integer('rows_total').notNull().default(0),
    rowsImported: integer('rows_imported').notNull().default(0),
    rowsDuplicated: integer('rows_duplicated').notNull().default(0),
    status: text('status').notNull().default('committed'),
    createdAt: createdAt(),
  },
  (t) => [
    check('import_batches_status_ck', sql`${t.status} in ('committed','rolled_back')`),
    index('import_batches_ws_idx').on(t.workspaceId, t.createdAt),
  ],
);

export const fxManualRates = pgTable(
  'fx_manual_rates',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    base: char('base', { length: 3 }).notNull(),
    quote: char('quote', { length: 3 }).notNull(),
    onDate: date('on_date').notNull(),
    rate: numeric('rate', { precision: 20, scale: 10 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.base, t.quote, t.onDate] })],
);

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
