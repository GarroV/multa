import { parseCategoryDictionary, parseSpendJournal, type JournalRow } from '@multa/core';
import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { db } from '../db/client.ts';
import { categories, importBatches, transactions } from '../db/schema/domain.ts';
import { isUuid } from '../http/ids.ts';
import { readXlsx, type XlsxBook } from '../import/xlsx.ts';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import { importCommitSchema, importPreviewSchema } from '../validation.ts';

/**
 * Импорт истории из Excel (issue #76) — то, без чего человек не переезжает с таблицы: переносить
 * четыре года руками никто не станет.
 *
 * Три правила, из которых всё остальное следует:
 * 1. **Предпросмотр ничего не пишет.** Сначала человек видит, что получится: сколько строк, за
 *    какой период, на какую сумму, какие категории появятся.
 * 2. **Повторная загрузка не удваивает историю.** У каждой строки есть отпечаток (дата + сумма +
 *    позиция + комментарий); совпадения считаются дублями и показываются числом, а не пропускаются
 *    молча.
 * 3. **Импорт откатывается целиком.** Пачка помнит свои строки: передумать можно одним действием.
 */
export const importRoute = new Hono<{ Variables: AppVariables }>();
importRoute.use('*', requireWorkspace);

/**
 * Режет список на куски. Postgres принимает не больше 65535 параметров в одном запросе, а перенос
 * истории — это тысячи строк на полтора десятка колонок: без разбиения запрос падает с «bind
 * message has N parameter formats but 0 parameters» (поймано на настоящем файле в 4814 строк).
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** 14 колонок на строку: 500 строк — это 7000 параметров, с большим запасом до лимита. */
const INSERT_CHUNK = 500;
/** Проверка дублей передаёт по одному параметру на ключ, поэтому кусок может быть крупнее. */
const LOOKUP_CHUNK = 5000;

/** Читает файл и находит нужный лист; обе ошибки — понятные, а не «internal». */
function bookAndSheet(fileBase64: string, sheetName: string) {
  let book: XlsxBook;
  try {
    book = readXlsx(Buffer.from(fileBase64, 'base64'));
  } catch {
    // Что именно не так с файлом, человеку не поможет: он видит «это не таблица Excel».
    return { error: 'not_xlsx' as const };
  }
  const sheet = book.sheets.find((s) => s.name === sheetName);
  if (!sheet) return { error: 'sheet_not_found' as const, book };
  return { book, sheet };
}

/**
 * Отпечатки строк файла.
 *
 * Ключ — дата, сумма, позиция и комментарий. Номер строки в него не входит намеренно: человек мог
 * вставить строку выше, и это не делает остальные новыми.
 *
 * Строки-близнецы (одна и та же покупка дважды за день — обычное дело в журнале) получают к ключу
 * порядковый номер повторения: это две разные траты, и обе должны переехать. При этом повторная
 * загрузка того же файла даёт ровно те же ключи, поэтому история не удваивается.
 */
function importKeysOf(rows: readonly JournalRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const payload = [
      row.occurredOn,
      row.amountMinor.toString(),
      row.item ?? '',
      row.note ?? '',
    ].join(' ');
    const nth = (seen.get(payload) ?? 0) + 1;
    seen.set(payload, nth);
    return createHash('sha1').update(`${payload} #${nth}`).digest('hex');
  });
}

importRoute.post('/import/preview', async (c) => {
  const ws = c.get('workspace')!;
  const body = importPreviewSchema.parse(await c.req.json());
  const found = bookAndSheet(body.fileBase64, body.sheet);
  if ('error' in found && found.error === 'not_xlsx') return c.json({ error: 'not_xlsx' }, 400);
  if (!found.sheet) {
    return c.json(
      { error: 'sheet_not_found', sheets: found.book?.sheets.map((s) => s.name) ?? [] },
      400,
    );
  }

  let journal;
  try {
    journal = parseSpendJournal(found.sheet.rows, { currency: ws.baseCurrency });
  } catch {
    return c.json({ error: 'journal_header_not_found' }, 400);
  }

  const existing = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.workspaceId, ws.id), eq(categories.archived, false)));
  const byName = new Map(existing.map((cat) => [cat.name.toLowerCase(), cat.id]));

  const counts = new Map<string, number>();
  for (const row of journal.rows) {
    if (!row.category) continue;
    counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  }

  const total = journal.rows.reduce((sum, r) => sum + r.amountMinor, 0n);
  const dates = journal.rows.map((r) => r.occurredOn).sort();

  return c.json({
    sheets: found.book!.sheets.map((s) => ({ name: s.name, rows: s.rows.length })),
    journal: {
      rowsTotal: journal.rows.length + journal.skipped.length,
      rowsReady: journal.rows.length,
      // Отброшенные показываем с номерами строк: человек должен видеть, что именно не переедет.
      rowsSkipped: journal.skipped,
      firstDate: dates[0] ?? null,
      lastDate: dates.at(-1) ?? null,
      totalMinor: total.toString(),
      categories: [...counts.entries()].map(([name, rows]) => ({
        name,
        rows,
        existingId: byName.get(name.toLowerCase()) ?? null,
      })),
    },
  });
});

importRoute.post('/import/commit', async (c) => {
  const ws = c.get('workspace')!;
  const body = importCommitSchema.parse(await c.req.json());
  const found = bookAndSheet(body.fileBase64, body.sheet);
  if ('error' in found && found.error === 'not_xlsx') return c.json({ error: 'not_xlsx' }, 400);
  if (!found.sheet) return c.json({ error: 'sheet_not_found' }, 400);

  let journal;
  try {
    journal = parseSpendJournal(found.sheet.rows, { currency: ws.baseCurrency });
  } catch {
    return c.json({ error: 'journal_header_not_found' }, 400);
  }

  // Словарь позиций нужен там, где в строке нет категории: он подсказывает, куда её отнести.
  const dictSheet = body.dictionarySheet
    ? found.book!.sheets.find((s) => s.name === body.dictionarySheet)
    : undefined;
  const dictionary = dictSheet
    ? parseCategoryDictionary(dictSheet.rows)
    : new Map<string, string>();

  const wanted = new Set<string>();
  for (const row of journal.rows) {
    const name = row.category ?? (row.item ? dictionary.get(row.item.toLowerCase()) : undefined);
    if (name) wanted.add(name);
  }

  const existing = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(and(eq(categories.workspaceId, ws.id), eq(categories.archived, false)));
  const byName = new Map(existing.map((cat) => [cat.name.toLowerCase(), cat.id]));

  const created: string[] = [];
  for (const name of wanted) {
    if (byName.has(name.toLowerCase())) continue;
    const rows = await db
      .insert(categories)
      .values({ workspaceId: ws.id, name, sort: 900 })
      .returning({ id: categories.id });
    byName.set(name.toLowerCase(), rows[0]!.id);
    created.push(name);
  }

  const keys = importKeysOf(journal.rows);
  const seen = new Set<string | null>();
  for (const part of chunk(keys, LOOKUP_CHUNK)) {
    const known = await db
      .select({ importKey: transactions.importKey })
      .from(transactions)
      .where(and(eq(transactions.workspaceId, ws.id), inArray(transactions.importKey, part)));
    for (const row of known) seen.add(row.importKey);
  }

  // Держим пары «строка + её ключ»: ключ зависит от места строки среди близнецов и заново не
  // пересчитывается.
  const pairs = journal.rows.map((row, i) => ({ row, key: keys[i]! }));
  const fresh = pairs.filter((pair) => !seen.has(pair.key));
  const duplicated = pairs.length - fresh.length;

  const batchId = await db.transaction(async (tx) => {
    const batch = await tx
      .insert(importBatches)
      .values({
        workspaceId: ws.id,
        filename: body.filename ?? 'import.xlsx',
        sheet: body.sheet,
        rowsTotal: journal.rows.length + journal.skipped.length,
        rowsImported: fresh.length,
        rowsDuplicated: duplicated,
      })
      .returning({ id: importBatches.id });
    const id = batch[0]!.id;

    for (const part of chunk(fresh, INSERT_CHUNK)) {
      await tx.insert(transactions).values(
        part.map(({ row, key }) => {
          const name = row.category ?? (row.item ? dictionary.get(row.item.toLowerCase()) : null);
          const categoryId = name ? (byName.get(name.toLowerCase()) ?? null) : null;
          return {
            workspaceId: ws.id,
            kind: 'expense' as const,
            ...(categoryId ? { targetKind: 'category' as const, targetId: categoryId } : {}),
            amountMinor: row.amountMinor,
            currency: ws.baseCurrency,
            // Историю переносим в базовой валюте таблицы: курс на дату здесь не выдумываем — в
            // исходнике его нет, а придуманный снапшот нарушил бы правило 2.
            baseAmountMinor: row.amountMinor,
            rate: '1',
            rateSource: 'base',
            rateDate: row.occurredOn,
            occurredOn: row.occurredOn,
            source: 'import' as const,
            note: row.note ?? row.item,
            importBatchId: id,
            importKey: key,
          };
        }),
      );
    }
    return id;
  });

  return c.json(
    {
      batchId,
      rowsImported: fresh.length,
      rowsDuplicated: duplicated,
      rowsSkipped: journal.skipped.length,
      categoriesCreated: created,
    },
    201,
  );
});

/**
 * Откат пачки: удаляет ровно те траты, которые она создала. Категории остаются — человек мог уже
 * задать в них бюджет, и удалять их вместе с историей было бы неожиданно.
 */
importRoute.delete('/import/batches/:id', async (c) => {
  const ws = c.get('workspace')!;
  const id = c.req.param('id');
  if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);

  const batch = await db
    .select({ id: importBatches.id, status: importBatches.status })
    .from(importBatches)
    .where(and(eq(importBatches.workspaceId, ws.id), eq(importBatches.id, id)))
    .limit(1);
  if (!batch[0]) return c.json({ error: 'not_found' }, 404);
  if (batch[0].status === 'rolled_back') return c.json({ error: 'already_rolled_back' }, 409);

  const removed = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(transactions)
      .where(and(eq(transactions.workspaceId, ws.id), eq(transactions.importBatchId, id)))
      .returning({ id: transactions.id });
    await tx.update(importBatches).set({ status: 'rolled_back' }).where(eq(importBatches.id, id));
    return rows.length;
  });

  return c.json({ ok: true, rowsRemoved: removed });
});

importRoute.get('/import/batches', async (c) => {
  const ws = c.get('workspace')!;
  const rows = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.workspaceId, ws.id))
    .orderBy(importBatches.createdAt);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      sheet: r.sheet,
      rowsTotal: r.rowsTotal,
      rowsImported: r.rowsImported,
      rowsDuplicated: r.rowsDuplicated,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  );
});
