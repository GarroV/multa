import { z } from 'zod';

/** Zod-схемы границ API (железное правило: валидация на границе). */

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
  expectedIncomeMinor: z.union([z.string(), z.number()]).transform((v) => BigInt(v)),
});

export const rateQuerySchema = z.object({
  from: z.string().length(3),
  to: z.string().length(3),
  on: z.string().optional(),
});

// --- CRUD обязательств (Спринт 2). Деньги — minor units (строка/число → bigint). ---

const minor = z.union([z.string(), z.number()]).transform((v) => BigInt(v));
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
