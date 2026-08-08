import { z } from 'zod';

/** Zod-схемы границ API (железное правило: валидация на границе). */

/**
 * Деньги — целые minor units (строка/число → bigint). Невалидный ввод отвергается
 * как ZodError (→ 400), а не роняет BigInt() сырым исключением (→ 500).
 */
const minor = z
  .union([z.string(), z.number()])
  .refine((v) => /^-?\d+$/.test(String(v).trim()), 'ожидается целое число (minor units)')
  .transform((v) => BigInt(String(v).trim()));

export const createWorkspaceSchema = z.object({
  baseCurrency: z.string().length(3),
  timezone: z.string().optional(),
  locale: z.enum(['ru', 'en']).optional(),
});

const ccy = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase());

// --- Доход: ритм планирования и источники денег (правило «ритм ≠ деньги») ---

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается дата YYYY-MM-DD');

/** Процент — десятичная строка в диапазоне (0, 100]. Считается в BigInt, не во float. */
const percent = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^\d+(\.\d+)?$/.test(s), 'процент — десятичное число')
  .refine((s) => Number(s) > 0 && Number(s) <= 100, 'процент в диапазоне (0, 100]');

const positiveMinor = minor.refine((v) => v > 0n, 'сумма должна быть положительной');

const monthDays = z
  .array(z.number().int().min(1).max(31))
  .min(1)
  .max(4)
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));

export const weekendRuleSchema = z.enum(['as-is', 'before', 'after']);

/** Ритм планирования: только регулярные виды — из ритма выводятся границы периодов. */
export const rhythmSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monthly-days'), days: monthDays }),
  z.object({
    kind: z.literal('every-weeks'),
    weeks: z.number().int().min(1).max(12),
    startsOn: isoDate,
  }),
]);

export const incomeScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monthly-days'), days: monthDays }),
  z.object({
    kind: z.literal('every-weeks'),
    weeks: z.number().int().min(1).max(12),
    startsOn: isoDate,
  }),
  z.object({ kind: z.literal('one-off'), date: isoDate }),
  /*
   * Ежедневный и недельный доход — не «нерегулярный»: он предсказуем частотой, а не датами.
   * Без них смена, такси и торговля попадали в «когда как» и выпадали из плана вместе с цифрой дня.
   */
  z.object({ kind: z.literal('daily') }),
  // 0 — воскресенье, как у `Date.getUTCDay`: ядро считает по тому же соглашению.
  z.object({ kind: z.literal('weekly'), weekday: z.number().int().min(0).max(6) }),
  z.object({ kind: z.literal('irregular') }),
]);

export const incomeAmountSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absolute'), amountMinor: positiveMinor }),
  z.object({ kind: z.literal('percent'), percent, ofMinor: positiveMinor }),
]);

export const incomeSourceSchema = z.object({
  label: z.string().min(1).max(60),
  currency: ccy,
  schedule: incomeScheduleSchema,
  amount: incomeAmountSchema,
  stability: z.enum(['fixed', 'variable']).default('fixed'),
  active: z.boolean().default(true),
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional(),
  sort: z.number().int().min(0).optional(),
});

/** Та же схема плюс id — ею же разбираются строки БД (jsonb-суммы приходят строками). */
export const incomeSourceRowSchema = incomeSourceSchema.extend({ id: z.string().uuid() });

export const incomeSourcePatchSchema = incomeSourceSchema.partial();

/**
 * Подтверждение поступления (issue #48). Сумма — в minor валюты прихода; валюта по умолчанию берётся
 * у источника. Курс — десятичная строка: его вводят руками, глядя на табло обменника, и он важнее
 * котировки на ту же дату. Float в курсе не допускаем по тем же причинам, что и в деньгах.
 */
export const incomeReceiptSchema = z.object({
  amountMinor: positiveMinor.transform((v) => v.toString()),
  currency: ccy.optional(),
  occurredOn: isoDate,
  rate: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine(
      (v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0,
      'курс — положительное десятичное число',
    )
    .optional(),
  note: z.string().min(1).max(200).optional(),
});

/**
 * Счёт (issue #45). Остаток может быть нулевым и отрицательным — кредитка бывает в минусе, поэтому
 * здесь `minor`, а не `positiveMinor`. Вид счёта ограничен теми же значениями, что в check-констрейнте
 * базы: расхождение между схемой и Zod дало бы 500 вместо понятного 400.
 */
/**
 * Горизонт аналитики (issue #51). Диапазон ограничен: один период — не история, а десятки периодов
 * превращают спарклайн в кашу. Мусор отклоняем, а не подменяем дефолтом молча.
 */
/**
 * Настройки воркспейса (issue #49). Каждая группа со своими дефолтами, поэтому чтение старой записи
 * без части полей даёт полный объект — миграции данных на каждое новое поле не нужны.
 *
 * Порядок сжатия ограничен режущимися уровнями: долги и валютные корзины автоматика не трогает ни
 * при какой настройке (железное правило 3), и протащить их сюда нельзя даже запросом.
 */
export const compressibleKind = z.enum(['goal', 'envelope', 'category']);

const periodsSettings = z.object({
  /** Предлагать поднять заниженные статьи (советы по медиане факта). */
  suggestRaises: z.boolean().default(true),
});

const currencySettings = z.object({
  rateSource: z.enum(['cbr', 'ecb', 'manual']).default('cbr'),
  /** Спред по умолчанию в базисных пунктах: 150 = 1,5%. */
  defaultSpreadBp: z.number().int().min(0).max(2000).default(0),
  defaultProvider: z.string().min(1).max(40).nullable().default(null),
});

const cascadeSettings = z.object({
  /** Доля остатка, которую не включаем в дневной темп. Больше половины — уже вторая заначка. */
  bufferPct: z.number().int().min(0).max(50).default(0),
  compressOrder: z.array(compressibleKind).min(1).max(3).default(['goal', 'envelope', 'category']),
});

/**
 * Обучение (issue #28). Флаг на сервере, а не в localStorage: человек заходит с телефона после
 * ноутбука, и тур не должен начинаться заново.
 */
const tourSettings = z.object({
  planDone: z.boolean().default(false),
});

const signalsSettings = z.object({
  /** За сколько дней до конца периода считать «деньги кончатся раньше» тревогой. */
  burnThresholdDays: z.number().int().min(1).max(14).default(3),
  /** Сколько прошлых периодов берём в медиану: меньше двух — не история. */
  medianPeriods: z.number().int().min(2).max(24).default(6),
  /** Запас хода ниже этого числа дней — сигнал (issue #50). */
  runwayWarnDays: z.number().int().min(1).max(90).default(14),
  /** Доля дохода, связанная обязательствами, выше этой — сигнал. */
  lockedWarnPct: z.number().int().min(10).max(95).default(60),
  /** Сколько сигналов показывать: длинный список перестают читать. */
  maxSignals: z.number().int().min(3).max(12).default(6),
});

/**
 * Матрица видимости по разделам (issue #46).
 *
 * `open` — участник видит строки; `sum` — только итог раздела; `hidden` — не видит ничего, но
 * сумма всё равно попадает в каскад отдельной строкой «Личное». Правило продукта: **скрыть можно
 * содержимое, но не факт траты** — иначе совместный план врёт, и деньги «исчезают» из общего
 * котла.
 *
 * По умолчанию всё открыто: приглашают ради совместного планирования, а не ради слежки; сузить
 * владелец может в любой момент.
 */
const shareMode = z.enum(['open', 'sum', 'hidden']);

const sharingSettings = z.object({
  income: shareMode.default('open'),
  debts: shareMode.default('open'),
  buckets: shareMode.default('open'),
  envelopes: shareMode.default('open'),
  categories: shareMode.default('open'),
  goals: shareMode.default('open'),
  /** Регулярные платежи: в каскаде не участвуют, но имя платежа так же личное, как имя долга. */
  recurring: shareMode.default('open'),
});

export type ShareMode = z.infer<typeof shareMode>;
export type SharingSettings = z.infer<typeof sharingSettings>;

export const workspaceSettingsSchema = z
  .object({
    periods: periodsSettings.default({}),
    currency: currencySettings.default({}),
    cascade: cascadeSettings.default({}),
    signals: signalsSettings.default({}),
    sharing: sharingSettings.default({}),
    tour: tourSettings.default({}),
  })
  .default({});

/** Частичная правка: тронутые группы сливаются с сохранёнными, остальное остаётся как было. */
export const workspaceSettingsPatchSchema = z.object({
  periods: periodsSettings.partial().optional(),
  currency: currencySettings.partial().optional(),
  cascade: cascadeSettings.partial().optional(),
  signals: signalsSettings.partial().optional(),
  sharing: sharingSettings.partial().optional(),
  tour: tourSettings.partial().optional(),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

/**
 * Импорт из Excel (issue #76). Файл приходит base64: он маленький (таблица на четыре года — меньше
 * мегабайта), а multipart ради одного поля усложнил бы и клиент, и тесты. Потолок в 12 МБ — защита
 * от случайной заливки чего-то не того, а не от злого умысла.
 */
const MAX_IMPORT_BASE64 = 12 * 1024 * 1024;

export const importPreviewSchema = z.object({
  fileBase64: z.string().min(1).max(MAX_IMPORT_BASE64),
  /**
   * Лист необязателен: первый запрос отвечает на вопрос «что вообще в файле» и возвращает список
   * листов. Без этого интерфейс не может предложить выбор — он не знает имён.
   */
  sheet: z.string().min(1).max(120).optional(),
});

export const importCommitSchema = z.object({
  fileBase64: z.string().min(1).max(MAX_IMPORT_BASE64),
  sheet: z.string().min(1).max(120),
  /** Лист-словарь «позиция → категория»: нужен там, где в строке журнала категории нет. */
  dictionarySheet: z.string().min(1).max(120).optional(),
  filename: z.string().min(1).max(200).optional(),
});

/** Горизонт сравнения провайдеров (issue #53): меньше месяца — не выборка, больше двух лет — не про сейчас. */
export const spreadQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

/**
 * Горизонт мастер-сетки (issue #47). Кламп обязателен: параметр множит объём расчёта — каждая
 * колонка это отдельный прогон каскада.
 */
export const planGridQuerySchema = z.object({
  periods: z.coerce.number().int().min(1).max(12).default(6),
});

export const analyticsQuerySchema = z.object({
  periods: z.coerce.number().int().min(2).max(24).default(6),
});

export const accountSchema = z.object({
  name: z.string().min(1).max(60),
  currency: ccy,
  kind: z.enum(['cash', 'card', 'savings', 'other']).default('cash'),
  balanceMinor: minor.transform((v) => v.toString()).optional(),
});

export const accountPatchSchema = accountSchema
  .partial()
  .extend({ archived: z.boolean().optional() });

/** Онбординг: ритм + правило выходных + набор источников одним запросом (атомарно). */
export const onboardingIncomeSchema = z.object({
  rhythm: rhythmSchema,
  weekendRule: weekendRuleSchema.default('before'),
  sources: z.array(incomeSourceSchema).min(1),
});

export const patchWorkspaceSchema = createWorkspaceSchema.partial().extend({
  rhythm: rhythmSchema.optional(),
  weekendRule: weekendRuleSchema.optional(),
});

export const rateQuerySchema = z.object({
  from: z.string().length(3),
  to: z.string().length(3),
  on: z.string().optional(),
});

// --- CRUD обязательств (Спринт 2). Деньги — minor units (см. `minor` выше). ---

/**
 * Ступени суммы: «с такой-то даты столько-то» (запрос владельца 06.08.2026, «интернет 2 500 до
 * октября, потом 4 000»). Пустой список = сумма не меняется; правило чтения — `amountOn` в ядре.
 *
 * Ограничение сверху не бюрократия: список ступеней уходит в jsonb и читается на каждый период
 * плана, а горизонт сетки — полгода. Сотня ступеней означала бы, что человек пытается вести здесь
 * график, для которого нужна другая сущность.
 */
export const amountStepsSchema = z
  .array(z.object({ from: isoDate, amountMinor: minor.transform((v) => v.toString()) }))
  .max(24)
  .optional();

export const debtCreateSchema = z.object({
  name: z.string().min(1),
  currency: ccy,
  principalMinor: minor,
  remainingMinor: minor,
  paymentMinor: minor,
  amountSteps: amountStepsSchema,
  dueDate: z.string().optional(),
  counterparty: z.string().optional(),
});

export const envelopeCreateSchema = z.object({
  name: z.string().min(1),
  currency: ccy,
  ruleKind: z.enum(['fixed', 'percent']),
  ruleValue: z.union([z.string(), z.number()]).transform((v) => String(v)),
  balanceMinor: minor.optional(),
});

export const goalCreateSchema = z.object({
  name: z.string().min(1),
  currency: ccy,
  targetMinor: minor,
  savedMinor: minor.optional(),
  plannedPerPeriodMinor: minor.optional(),
});

export const bucketCreateSchema = z.object({
  name: z.string().min(1),
  fromCurrency: ccy,
  toCurrency: ccy,
  amountMinor: minor,
});

/*
 * Правка обязательств (issue #91). Частичные схемы, а не повтор полных: править одно поле, не
 * трогая остальные, — и есть смысл PATCH.
 *
 * Валюта в список правимого НЕ входит намеренно. Сумма хранится в minor units своей валюты, и смена
 * валюты у существующей строки молча переозначила бы уже записанное число: 50 000 копеек стали бы
 * 50 000 центов. Валюту меняют заведением новой строки — там сумма вводится заново.
 */
const withoutCurrency = <T extends z.ZodRawShape>(shape: T) => {
  const { currency: _c, fromCurrency: _f, toCurrency: _t, ...rest } = shape as z.ZodRawShape;
  return rest;
};

/** Пустое тело — ошибка, а не no-op: «сохранено», при котором ничего не изменилось, обманывает. */
const nonEmpty = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine((v) => Object.keys(v as object).length > 0, { message: 'empty_patch' });

export const debtPatchSchema = nonEmpty(
  z.object(withoutCurrency(debtCreateSchema.shape)).partial(),
);
export const envelopePatchSchema = nonEmpty(
  z.object(withoutCurrency(envelopeCreateSchema.shape)).partial(),
);
export const goalPatchSchema = nonEmpty(
  z.object(withoutCurrency(goalCreateSchema.shape)).partial(),
);
export const bucketPatchSchema = nonEmpty(
  z.object(withoutCurrency(bucketCreateSchema.shape)).partial(),
);

// --- Категории (Спринт 2). Бюджет категории на период — в base-валюте. ---

export const categoryCreateSchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional(),
  protected: z.boolean().optional(),
});

export const categoryPatchSchema = z.object({
  name: z.string().min(1).optional(),
  icon: z.string().optional(),
  protected: z.boolean().optional(),
  sort: z.number().int().optional(),
});

/** Бюджет категории на текущий период (base-валюта, целые minor, не отрицательный). */
export const categoryBudgetSchema = z.object({
  plannedMinor: minor.refine((v) => v >= 0n, 'бюджет не может быть отрицательным'),
});

// --- Факт (Спринт 3). Транзакция хранит сумму в своей валюте + снапшот курса. ---
// Дату валидирует тот же `isoDate`, что и ритм дохода выше: один формат даты на границе API.

/**
 * Ручной ввод траты. Сумма — положительная (знак несёт `kind`, см. 02-data-schema).
 * `categoryId` опционален: «крупный мазок» без категории — легитимный сценарий (04-web-ux §Ввод).
 * `occurredOn` по умолчанию сегодня; период вычисляется на сервере по этой дате.
 */
export const transactionCreateSchema = z
  .object({
    /** Трата или внеплановый приход («сегодня прилетел side hustle»). Знак несёт kind. */
    kind: z.enum(['expense', 'income']).default('expense'),
    amountMinor: minor.refine((v) => v > 0n, 'сумма должна быть больше нуля'),
    currency: ccy,
    categoryId: z.string().uuid().optional(),
    occurredOn: isoDate.optional(),
    note: z.string().max(500).optional(),
    source: z.enum(['manual', 'text', 'voice', 'receipt', 'import']).optional(),
    rawInput: z.string().max(500).optional(),
  })
  .refine((v) => v.kind !== 'income' || v.categoryId === undefined, {
    // Категории описывают траты: приход с категорией исказил бы её бюджет и остаток.
    message: 'у прихода не бывает категории',
    path: ['categoryId'],
  });

/**
 * Подтверждение плановой строки. Без суммы — «сделал целиком»; с суммой меньше плана —
 * частичное исполнение (остаток остаётся видимым в плане).
 */
export const executionSchema = z.object({
  executedMinor: minor.refine((v) => v >= 0n, 'сумма не может быть отрицательной').optional(),
});

/**
 * Факт размена: обе стороны сделки. Валюты обязаны различаться (проверяется в роуте),
 * суммы — положительные: «отдал 0» это не размен.
 */
export const exchangeCreateSchema = z.object({
  /** Где меняли (issue #53): по нему считается сравнение провайдеров, поэтому это поле, а не заметка. */
  provider: z.string().min(1).max(40).optional(),
  fromCurrency: ccy,
  toCurrency: ccy,
  fromMinor: positiveMinor,
  toMinor: positiveMinor,
  occurredOn: isoDate.optional(),
  bucketId: z.string().uuid().optional(),
  note: z.string().max(500).optional(),
});

/** Свободная фраза для разбора: «250 продукты», «кофе 4.5 eur вчера». */
export const textEntrySchema = z.object({
  text: z.string().min(1).max(300),
});

/** Голосовая заметка: только data:audio/... — ссылки на чужие файлы не тянем. */
export const voiceEntrySchema = z.object({
  audioUrl: z
    .string()
    .min(20)
    .max(14_000_000)
    .refine((v) => v.startsWith('data:audio/'), 'ожидается data:audio/...'),
});

/** Запрос вариантов пересборки: какой строке и сколько нужно добавить. */
export const rebalanceQuerySchema = z.object({
  targetId: z.string().uuid(),
  needMinor: positiveMinor,
});

/** Применение пересборки: откуда, куда, сколько. Долги и корзины источником быть не могут. */
export const rebalanceApplySchema = z.object({
  fromKind: z.enum(['category', 'envelope', 'goal']),
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
  amountMinor: positiveMinor,
});

// --- Регулярные платежи вне обязательств (#21) ---

/** Расписание платежа. Доходы описываются своей схемой — здесь только расходы и взносы. */
export const recurringScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monthly-days'), days: monthDays }),
  z.object({
    kind: z.literal('every-weeks'),
    weeks: z.number().int().min(1).max(12),
    startsOn: isoDate,
  }),
  /*
   * «N-й <день недели> месяца» (issue #55). nth = -1 означает «последний»; пятёрки здесь нет
   * намеренно: пятый вторник бывает не каждый месяц, и такое правило молча пропускало бы платёж.
   */
  z.object({
    kind: z.literal('monthly-nth-weekday'),
    nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]),
    weekday: z.number().int().min(0).max(6),
  }),
  z.object({
    kind: z.literal('yearly'),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
  }),
  /** «В каждую выплату»: дата берётся из периода, поэтому у правила нет параметров. */
  z.object({ kind: z.literal('each-payout') }),
  z.object({ kind: z.literal('one-off'), date: isoDate }),
  z.object({ kind: z.literal('irregular') }),
]);

export const recurringCreateSchema = z.object({
  kind: z.enum(['expense', 'envelope', 'goal', 'debt']).default('expense'),
  name: z.string().min(1).max(60),
  amountMinor: positiveMinor,
  currency: ccy,
  schedule: recurringScheduleSchema,
  targetId: z.string().uuid().optional(),
  /** Срок жизни платежа (issue #55): «первая дата» из редактора и дата отмены. */
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional(),
  showOnMap: z.boolean().optional(),
  amountSteps: amountStepsSchema,
});

export const recurringPatchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  amountMinor: positiveMinor.optional(),
  currency: ccy.optional(),
  schedule: recurringScheduleSchema.optional(),
  active: z.boolean().optional(),
  // null — снять ограничение срока; отличать от «поле не прислали» обязательно.
  startsOn: isoDate.nullable().optional(),
  endsOn: isoDate.nullable().optional(),
  showOnMap: z.boolean().optional(),
  // null — снять все ступени разом; пустой массив означает то же, но через явную правку списка.
  amountSteps: amountStepsSchema.nullable(),
});

// --- Чеки (Спринт 5). QR пробуется первым, он бесплатный. ---

/** Содержимое QR. totalMinor — на случай, когда сумма живёт в фискальном сервисе (Сербия). */
export const receiptQrSchema = z.object({
  payload: z.string().min(4).max(1000),
  totalMinor: positiveMinor.optional(),
  currency: ccy.optional(),
});

/** Фото чека: data URL или https-ссылка. Ограничение длины — защита от гигантских payload. */
export const receiptPhotoSchema = z.object({
  imageUrl: z
    .string()
    .min(20)
    .max(8_000_000)
    .refine(
      (v) => v.startsWith('data:image/') || v.startsWith('https://'),
      'ожидается data:image/... или https://',
    ),
});

/** Подтверждение раскладки чека: суммы по категориям, как их видит пользователь. */
export const receiptConfirmSchema = z.object({
  split: z.array(z.object({ categoryId: z.string().uuid(), amountMinor: positiveMinor })).min(1),
});

/** Фильтр списка транзакций. Без параметров — текущий период. */
export const transactionListSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
