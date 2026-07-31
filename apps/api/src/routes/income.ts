import { Hono } from 'hono';
import { isUuid } from '../http/ids.ts';
import {
  deleteSourceById,
  insertSource,
  listSourceRows,
  patchSourceById,
  replaceOnboardingIncome,
  serializeSource,
  skipOnboarding,
} from '../income/store.ts';
import {
  deleteReceipt,
  findSource,
  insertReceipt,
  ReceiptDuplicate,
  ReceiptRateUnavailable,
  serializeReceipt,
} from '../income/receipts.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import {
  incomeReceiptSchema,
  incomeSourcePatchSchema,
  incomeSourceSchema,
  onboardingIncomeSchema,
} from '../validation.ts';

/** Кривой id — это «нет такого», а не 500 от драйвера на некорректном uuid. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Источники дохода: CRUD + атомарный шаг онбординга. Скоуп — только из токена (правило 7). */
export const incomeRoute = new Hono<{ Variables: AppVariables }>();
incomeRoute.use('*', requireWorkspace);

incomeRoute.get('/income-sources', async (c) => {
  const ws = c.get('workspace')!;
  return c.json((await listSourceRows(ws.id)).map(serializeSource));
});

incomeRoute.post('/income-sources', async (c) => {
  const ws = c.get('workspace')!;
  const body = incomeSourceSchema.parse(await c.req.json());
  return c.json(serializeSource(await insertSource(ws.id, body)), 201);
});

incomeRoute.patch('/income-sources/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
  const patch = incomeSourcePatchSchema.parse(await c.req.json());
  const row = await patchSourceById(ws.id, id, patch);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(serializeSource(row));
});

incomeRoute.delete('/income-sources/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
  if (!(await deleteSourceById(ws.id, id))) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

/**
 * Подтверждение поступления (issue #48): фактическая сумма, дата и — при желании — курс дня
 * выплаты. После этого план считается по факту, а не по ожидаемой сумме.
 */
incomeRoute.post('/income-sources/:id/received', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  const body = incomeReceiptSchema.parse(await c.req.json());
  if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);

  const source = await findSource(ws.id, id);
  if (!source) return c.json({ error: 'not_found' }, 404);

  try {
    const row = await insertReceipt(ws.id, ws.baseCurrency, id, {
      amountMinor: BigInt(body.amountMinor),
      // Валюта по умолчанию — валюта источника: обычно приходит именно в ней.
      currency: body.currency ?? source.currency,
      occurredOn: body.occurredOn,
      ...(body.rate ? { rate: body.rate } : {}),
      ...(body.note ? { note: body.note } : {}),
    });
    return c.json(serializeReceipt(row), 201);
  } catch (err) {
    if (err instanceof ReceiptDuplicate) return c.json({ error: 'receipt_exists' }, 409);
    if (err instanceof ReceiptRateUnavailable) return c.json({ error: 'rate_unavailable' }, 422);
    throw err;
  }
});

/** Отмена подтверждения: план возвращается к плановой сумме источника. */
incomeRoute.delete('/income-receipts/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
  if (!(await deleteReceipt(ws.id, id))) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

/** Шаг онбординга «когда приходят деньги»: ритм и источники за один атомарный запрос. */
incomeRoute.post('/onboarding/income', async (c) => {
  const ws = c.get('workspace')!;
  const body = onboardingIncomeSchema.parse(await c.req.json());
  const rows = await replaceOnboardingIncome(ws.id, body);
  return c.json({ sources: rows.map(serializeSource) }, 201);
});

/**
 * Пропустить обучение: пускаем в приложение без дохода. Ритм ставим дефолтный, если его нет —
 * иначе периоды неопределимы и пустой дашборд не смог бы показать даже границы. Доход остаётся
 * пустым: план будет чистым листом, пока пользователь не заполнит источники в настройках.
 */
incomeRoute.post('/onboarding/skip', async (c) => {
  const ws = c.get('workspace')!;
  await skipOnboarding(ws.id, ws.periodAnchors == null);
  return c.body(null, 204);
});
