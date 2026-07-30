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

export const debtCreateSchema = z.object({
  name: z.string().min(1),
  currency: ccy,
  principalMinor: minor,
  remainingMinor: minor,
  paymentMinor: minor,
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
export const transactionCreateSchema = z.object({
  amountMinor: minor.refine((v) => v > 0n, 'сумма должна быть больше нуля'),
  currency: ccy,
  categoryId: z.string().uuid().optional(),
  occurredOn: isoDate.optional(),
  note: z.string().max(500).optional(),
  source: z.enum(['manual', 'text', 'voice', 'receipt', 'import']).optional(),
  rawInput: z.string().max(500).optional(),
});

/** Фильтр списка транзакций. Без параметров — текущий период. */
export const transactionListSchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
