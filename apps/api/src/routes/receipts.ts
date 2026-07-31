import { parseReceiptQr, splitReceipt, type ReceiptItem } from '@multa/core';
import { isUuid } from '../http/ids.ts';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import { categories, receipts, transactions } from '../db/schema/domain.ts';
import { requireWorkspace, type AppVariables, type Workspace } from '../middleware.ts';
import { ensurePeriodForDate } from '../plan/assemble.ts';
import { recognizeReceipt } from '../receipts/vision.ts';
import { receiptConfirmSchema, receiptPhotoSchema, receiptQrSchema } from '../validation.ts';

/**
 * Чеки (Спринт 5). Пайплайн из спеки: **QR всегда первым** — он бесплатный и точный;
 * vision-фоллбэк подключается отдельно и только когда QR не сработал.
 *
 * Разбор не создаёт транзакции сам: сначала пользователь видит раскладку (экран ревью), и
 * только подтверждение превращает её в факт. Иначе кривой чек молча портил бы бюджет.
 */
export const receiptsRoute = new Hono<{ Variables: AppVariables }>();
receiptsRoute.use('*', requireWorkspace);

/** Ключевые слова категорий: пока это само название (полноценный словарь — Спринт 5 позже). */
async function splitCategories(ws: Workspace) {
  const rows = await db
    .select({ id: categories.id, name: categories.name, isSystem: categories.isSystem })
    .from(categories)
    .where(and(eq(categories.workspaceId, ws.id), eq(categories.archived, false)))
    .orderBy(asc(categories.sort));
  const fallback = rows.find((r) => r.isSystem) ?? rows[rows.length - 1];
  return {
    list: rows
      .filter((r) => !r.isSystem)
      .map((r) => ({ id: r.id, name: r.name, keywords: [r.name] })),
    fallbackId: fallback?.id ?? null,
  };
}

receiptsRoute.get('/receipts', async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select()
    .from(receipts)
    .where(eq(receipts.workspaceId, ws.id))
    .orderBy(desc(receipts.purchasedAt))
    .limit(50);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      method: r.method,
      merchant: r.merchant,
      totalMinor: r.totalMinor != null ? r.totalMinor.toString() : null,
      currency: r.currency,
      purchasedAt: r.purchasedAt,
      items: r.items,
    })),
  );
});

/** Разбор QR: сохраняем чек и отдаём предлагаемую раскладку на ревью. */
receiptsRoute.post('/receipts/qr', async (c) => {
  const ws = c.get('workspace')!;
  const body = receiptQrSchema.parse(await c.req.json());
  const parsed = parseReceiptQr(body.payload);
  if (!parsed) return c.json({ error: 'qr_not_recognized' }, 422);

  const { list, fallbackId } = await splitCategories(ws);
  if (!fallbackId) return c.json({ error: 'no_categories' }, 409);

  // Позиции даёт фискальный сервис; пока их нет — вся сумма падает в «Общее» (правило фоллбека).
  const items: ReceiptItem[] = [];
  const totalMinor = parsed.totalMinor ?? body.totalMinor ?? null;
  if (totalMinor === null) return c.json({ error: 'total_unknown' }, 422);

  const split = splitReceipt({
    items,
    categories: list,
    fallbackCategoryId: fallbackId,
    totalMinor,
  });

  const inserted = await db
    .insert(receipts)
    .values({
      workspaceId: ws.id,
      status: split.confidence === 'high' ? 'parsed' : 'fallback',
      method: parsed.provider === 'fns_ru' ? 'qr_fns' : 'qr_rs',
      totalMinor,
      currency: parsed.currency,
      ...(parsed.purchasedAt ? { purchasedAt: new Date(parsed.purchasedAt) } : {}),
      qrPayload: parsed.raw,
      items: [],
    })
    .returning();

  return c.json(
    {
      receipt: { id: inserted[0]!.id, status: inserted[0]!.status, method: inserted[0]!.method },
      currency: parsed.currency,
      totalMinor: totalMinor.toString(),
      confidence: split.confidence,
      split: split.byCategory.map((a) => ({
        categoryId: a.categoryId,
        amountMinor: a.amountMinor.toString(),
      })),
    },
    201,
  );
});

/** Подтверждение раскладки: превращает чек в транзакции периода той даты, когда он выдан. */
receiptsRoute.post('/receipts/:id/confirm', async (c) => {
  const ws = c.get('workspace')!;
  if (!isUuid(c.req.param('id'))) return c.json({ error: 'not_found' }, 404);
  const body = receiptConfirmSchema.parse(await c.req.json());
  const rows = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, c.req.param('id')), eq(receipts.workspaceId, ws.id)))
    .limit(1);
  const receipt = rows[0];
  if (!receipt) return c.json({ error: 'not_found' }, 404);
  if (receipt.currency == null) return c.json({ error: 'currency_unknown' }, 409);

  const occurredOn = receipt.purchasedAt
    ? receipt.purchasedAt.toISOString().slice(0, 10)
    : today(ws.timezone);
  const { periodId } = await ensurePeriodForDate(ws, occurredOn);

  // Категории проверяем ДО удаления прежних трат: иначе отклонённая правка раскладки
  // стирала бы уже записанный факт (проверял — стирала).
  const owned = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.workspaceId, ws.id), eq(categories.archived, false)));
  const allowed = new Set(owned.map((o) => o.id));
  if (body.split.some((s) => !allowed.has(s.categoryId)))
    return c.json({ error: 'category_not_found' }, 404);

  // Переписываем траты чека одной транзакцией БД: между удалением и вставкой нет момента,
  // когда чек подтверждён, а трат нет.
  await db.transaction(async (tx) => {
    await tx
      .delete(transactions)
      .where(and(eq(transactions.workspaceId, ws.id), eq(transactions.receiptId, receipt.id)));
    await tx.insert(transactions).values(
      body.split.map((s) => ({
        workspaceId: ws.id,
        periodId,
        kind: 'expense',
        targetKind: 'category',
        targetId: s.categoryId,
        amountMinor: s.amountMinor,
        currency: receipt.currency!,
        baseAmountMinor: s.amountMinor,
        rate: '1',
        rateSource: 'base',
        rateDate: occurredOn,
        occurredOn,
        source: 'receipt',
        receiptId: receipt.id,
      })),
    );
    await tx.update(receipts).set({ status: 'parsed' }).where(eq(receipts.id, receipt.id));
  });
  return c.json({ ok: true, transactions: body.split.length });
});

/**
 * Фото чека — платный путь, включается только если QR не сработал (клиент сначала пробует QR).
 * Модель может ошибиться, поэтому раскладка всё равно уходит на ревью, а не в транзакции.
 */
receiptsRoute.post('/receipts/photo', async (c) => {
  const ws = c.get('workspace')!;
  const body = receiptPhotoSchema.parse(await c.req.json());

  const recognized = await recognizeReceipt(body.imageUrl);
  if (!recognized) return c.json({ error: 'vision_failed' }, 422);

  const { list, fallbackId } = await splitCategories(ws);
  if (!fallbackId) return c.json({ error: 'no_categories' }, 409);

  const split = splitReceipt({
    items: recognized.items,
    categories: list,
    fallbackCategoryId: fallbackId,
    totalMinor: recognized.totalMinor,
  });

  const inserted = await db
    .insert(receipts)
    .values({
      workspaceId: ws.id,
      status: split.confidence === 'high' ? 'parsed' : 'fallback',
      method: 'vision',
      ...(recognized.merchant ? { merchant: recognized.merchant } : {}),
      totalMinor: recognized.totalMinor,
      currency: recognized.currency,
      ...(recognized.purchasedOn
        ? { purchasedAt: new Date(`${recognized.purchasedOn}T12:00:00Z`) }
        : {}),
      items: recognized.items.map((i) => ({ name: i.name, amountMinor: i.amountMinor.toString() })),
    })
    .returning();

  return c.json(
    {
      receipt: { id: inserted[0]!.id, status: inserted[0]!.status, method: 'vision' },
      merchant: recognized.merchant,
      currency: recognized.currency,
      totalMinor: recognized.totalMinor.toString(),
      confidence: split.confidence,
      items: recognized.items.map((i) => ({ name: i.name, amountMinor: i.amountMinor.toString() })),
      split: split.byCategory.map((a) => ({
        categoryId: a.categoryId,
        amountMinor: a.amountMinor.toString(),
      })),
    },
    201,
  );
});
