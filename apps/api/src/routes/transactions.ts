import { convert, money, parseEntry, periodForDate, type PeriodConfig } from '@multa/core';
import { isUuid } from '../http/ids.ts';
import { and, desc, eq, gte, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { today } from '../clock.ts';
import { db } from '../db/client.ts';
import { categories, transactions } from '../db/schema/domain.ts';
import { getRate } from '../fx/service.ts';
import { requireWorkspace, type AppVariables, type Workspace } from '../middleware.ts';
import { ensurePeriodForDate } from '../plan/assemble.ts';
import { parseEntryWithLlm } from '../receipts/textLlm.ts';
import { transcribe } from '../receipts/voice.ts';
import {
  textEntrySchema,
  transactionCreateSchema,
  transactionListSchema,
  voiceEntrySchema,
} from '../validation.ts';

/**
 * Факт трат (Спринт 3). Транзакция хранит триаду: сумма в своей валюте + `base_amount_minor`
 * + иммутабельный снапшот курса на дату траты (железное правило 2 — история не пересчитывается).
 *
 * Период вычисляется на сервере по `occurred_on`: клиент period_id не передаёт, поэтому
 * задним числом внесённая трата попадает в свой период, а не в текущий.
 */
export const transactionsRoute = new Hono<{ Variables: AppVariables }>();
transactionsRoute.use('*', requireWorkspace);

interface TransactionDto {
  id: string;
  kind: string;
  categoryId: string | null;
  amountMinor: string;
  currency: string;
  baseAmountMinor: string;
  rate: string;
  rateSource: string;
  rateDate: string;
  occurredOn: string;
  source: string;
  note: string | null;
}

/** bigint в JSON не сериализуется — суммы отдаём строками (как в PlanDto). */
function serialize(row: typeof transactions.$inferSelect): TransactionDto {
  return {
    id: row.id,
    kind: row.kind,
    categoryId: row.targetKind === 'category' ? row.targetId : null,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    baseAmountMinor: row.baseAmountMinor.toString(),
    rate: row.rate,
    rateSource: row.rateSource,
    rateDate: row.rateDate,
    occurredOn: row.occurredOn,
    source: row.source,
    note: row.note,
  };
}

/** Границы периода, в который попадает дата. Бросает `onboarding_incomplete` без якорей. */
function periodRange(ws: Workspace, on: string): { from: string; to: string } {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const period = periodForDate(ws.periodAnchors as PeriodConfig, on);
  return { from: period.startsOn, to: period.endsOn };
}

transactionsRoute.get('/transactions', async (c) => {
  const ws = c.get('workspace')!;
  const q = transactionListSchema.parse(c.req.query());
  const range = q.from && q.to ? { from: q.from, to: q.to } : periodRange(ws, today(ws.timezone));

  /*
   * Категория из запроса проверяется на принадлежность (правило 7: id от клиента не доверяем).
   * Иначе фильтр стал бы способом заглянуть в чужой воркспейс — «покажи траты по этой категории»,
   * где категория соседа. Чужая и несуществующая одинаково «не найдены»: ответ не должен
   * подтверждать существование чужой строки.
   */
  if (q.categoryId) {
    const owned = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, q.categoryId), eq(categories.workspaceId, ws.id)))
      .limit(1);
    if (!owned[0]) return c.json({ error: 'category_not_found' }, 404);
  }

  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.workspaceId, ws.id),
        gte(transactions.occurredOn, range.from),
        lt(transactions.occurredOn, range.to),
        ...(q.categoryId
          ? [eq(transactions.targetKind, 'category'), eq(transactions.targetId, q.categoryId)]
          : []),
      ),
    )
    .orderBy(desc(transactions.occurredOn), desc(transactions.id))
    .limit(q.limit);
  return c.json({ period: range, transactions: rows.map(serialize) });
});

transactionsRoute.post('/transactions', async (c) => {
  const ws = c.get('workspace')!;
  const body = transactionCreateSchema.parse(await c.req.json());
  const occurredOn = body.occurredOn ?? today(ws.timezone);

  // Категория — только своя и живая (правило 7: скоуп из токена, id от клиента не доверяем).
  if (body.categoryId) {
    const owned = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, body.categoryId),
          eq(categories.workspaceId, ws.id),
          eq(categories.archived, false),
        ),
      );
    if (!owned[0]) return c.json({ error: 'category_not_found' }, 404);
  }

  // Снапшот курса на дату траты. Своя валюта → 1:1 (источник 'base', курс не нужен).
  const needsRate = body.currency !== ws.baseCurrency;
  // Курс — по личным курсам воркспейса тоже (issue #48): курс дня выплаты, введённый руками,
  // обязан применяться и к тратам, иначе план и факт считаются по разным курсам.
  const snap = needsRate ? await getRate(body.currency, ws.baseCurrency, occurredOn, ws.id) : null;
  if (needsRate && !snap) return c.json({ error: 'rate_unavailable' }, 404);
  const baseAmountMinor = snap
    ? convert(money(body.amountMinor, body.currency), snap).minor
    : body.amountMinor;

  const { periodId } = await ensurePeriodForDate(ws, occurredOn);

  const inserted = await db
    .insert(transactions)
    .values({
      workspaceId: ws.id,
      periodId,
      kind: body.kind,
      ...(body.categoryId ? { targetKind: 'category', targetId: body.categoryId } : {}),
      amountMinor: body.amountMinor,
      currency: body.currency,
      baseAmountMinor,
      rate: snap ? snap.rate : '1',
      rateSource: snap ? snap.source : 'base',
      rateDate: snap ? snap.date : occurredOn,
      occurredOn,
      source: body.source ?? 'manual',
      ...(body.note ? { note: body.note } : {}),
      ...(body.rawInput ? { rawInput: body.rawInput } : {}),
      ...(body.clientKey ? { clientKey: body.clientKey } : {}),
    })
    /*
     * Повтор той же попытки не создаёт вторую трату (офлайн-очередь, Спринт 6). Клиент, отправивший
     * трату без сети, повторит её при появлении связи — и не может знать, дошла ли первая попытка.
     * Без этой защиты человек увидел бы двойной расход и не понял бы, откуда он.
     */
    .onConflictDoNothing({ target: [transactions.workspaceId, transactions.clientKey] })
    .returning();

  const row = inserted[0];
  if (row) return c.json(serialize(row), 201);

  // Конфликт: запись уже есть. Отдаём её же со статусом 200 — это не ошибка, а «уже сделано».
  const existing = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.workspaceId, ws.id), eq(transactions.clientKey, body.clientKey!)))
    .limit(1);
  if (!existing[0]) return c.json({ error: 'conflict' }, 409);
  return c.json(serialize(existing[0]), 200);
});

transactionsRoute.delete('/transactions/:id', async (c) => {
  const ws = c.get('workspace')!;
  if (!isUuid(c.req.param('id'))) return c.json({ error: 'not_found' }, 404);
  const deleted = await db
    .delete(transactions)
    .where(and(eq(transactions.id, c.req.param('id')), eq(transactions.workspaceId, ws.id)))
    .returning({ id: transactions.id });
  if (!deleted[0]) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

/**
 * Разбор свободной фразы: «250 продукты», «кофе 4.5 eur вчера».
 *
 * Порядок как у чеков: сначала бесплатный regex-парсер ядра, и только если он не нашёл суммы —
 * платный LLM (единственный внешний ключ в продукте). Ничего не записываем: отдаём разбор, чтобы
 * пользователь увидел, как его поняли, и подтвердил. Не разобрали — 422, а не случайная трата.
 */
/** Один разбор для клавиатуры и голоса: расхождения в поведении недопустимы. */
async function parsePhrase(ws: Workspace, text: string) {
  const catRows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.workspaceId, ws.id), eq(categories.archived, false)));
  const names = catRows.map((c2) => c2.name);
  const ctx = { baseCurrency: ws.baseCurrency, today: today(ws.timezone), categories: names };

  const local = parseEntry(text, ctx);
  if (local.amountMinor !== null) {
    const hit = local.categoryName
      ? catRows.find((c2) => c2.name === local.categoryName)
      : undefined;
    return {
      source: 'regex' as const,
      kind: local.kind,
      amountMinor: local.amountMinor.toString(),
      currency: local.currency,
      occurredOn: local.occurredOn,
      categoryId: hit?.id ?? null,
      categoryName: local.categoryName ?? null,
      note: local.note ?? null,
    };
  }

  const llm = await parseEntryWithLlm(text, ctx);
  if (!llm) return null;
  const hit = llm.categoryName ? catRows.find((c2) => c2.name === llm.categoryName) : undefined;
  return {
    source: 'llm' as const,
    kind: llm.kind,
    amountMinor: llm.amountMinor.toString(),
    currency: llm.currency,
    occurredOn: llm.occurredOn,
    categoryId: hit?.id ?? null,
    categoryName: llm.categoryName,
    note: llm.note,
  };
}

transactionsRoute.post('/transactions/parse', async (c) => {
  const ws = c.get('workspace')!;
  const body = textEntrySchema.parse(await c.req.json());
  const parsed = await parsePhrase(ws, body.text);
  if (!parsed) return c.json({ error: 'not_understood' }, 422);
  return c.json(parsed);
});

/**
 * Голос: запись → Whisper → тот же разбор фразы. Своей логики понимания у голоса нет,
 * иначе он начал бы расходиться с клавиатурой.
 */
transactionsRoute.post('/transactions/voice', async (c) => {
  const ws = c.get('workspace')!;
  const body = voiceEntrySchema.parse(await c.req.json());

  const text = await transcribe(body.audioUrl, ws.locale === 'en' ? 'en' : 'ru');
  if (!text) return c.json({ error: 'transcription_failed' }, 422);

  const parsed = await parsePhrase(ws, text);
  if (!parsed) return c.json({ error: 'not_understood', transcript: text }, 422);
  return c.json({ ...parsed, transcript: text });
});
