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

export const patchWorkspaceSchema = createWorkspaceSchema.partial();

export const anchorsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monthly-days'), days: z.array(z.number().int().min(1).max(31)).min(1) }),
  z.object({ kind: z.literal('every-weeks'), weeks: z.number().int().positive(), startsOn: z.string() }),
  z.object({ kind: z.literal('custom'), dates: z.array(z.string()).min(2) }),
]);

export const paydaySchema = z.object({
  anchors: anchorsSchema,
  expectedIncomeMinor: minor,
});

export const rateQuerySchema = z.object({
  from: z.string().length(3),
  to: z.string().length(3),
  on: z.string().optional(),
});

// --- CRUD обязательств (Спринт 2). Деньги — minor units (см. `minor` выше). ---

const ccy = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase());

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
