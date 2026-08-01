import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { expectOk, onboarded, type TestClient } from './client.ts';

/**
 * Импорт из Excel (issue #76). Проверяется то, ради чего он существует: перенести историю целиком,
 * ничего не потеряв и ничего не удвоив, с возможностью передумать.
 *
 * Три правила, вокруг которых написаны тесты:
 * 1. Предпросмотр ничего не пишет — человек сначала видит, что получится.
 * 2. Повторная загрузка того же файла не удваивает историю: совпадения показываются числом.
 * 3. Импорт откатывается целиком: пачка помнит, что именно она создала.
 */

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/journal.xlsx', import.meta.url)));

interface PreviewDto {
  sheets: { name: string; rows: number }[];
  journal: {
    rowsTotal: number;
    rowsReady: number;
    rowsSkipped: { sourceRow: number; reason: string }[];
    firstDate: string | null;
    lastDate: string | null;
    totalMinor: string;
    categories: { name: string; rows: number; existingId: string | null }[];
  };
}

interface CommitDto {
  batchId: string;
  rowsImported: number;
  rowsDuplicated: number;
  categoriesCreated: string[];
}

async function upload(client: TestClient, path: string, body: Record<string, unknown>) {
  return client.post(path, { ...body, fileBase64: fixture.toString('base64') });
}

describe('импорт журнала из Excel', () => {
  test('предпросмотр показывает, что получится, и ничего не пишет', async () => {
    const client = await onboarded();
    const preview = await expectOk<PreviewDto>(
      await upload(client, '/v1/import/preview', { sheet: 'Журнал' }),
    );

    expect(preview.sheets.map((s) => s.name)).toContain('Журнал');
    expect(preview.journal.rowsReady).toBe(3);
    expect(preview.journal.firstDate).toBe('2022-12-01');
    // 130,00 + 139,99 + 550,00 = 819,99
    expect(preview.journal.totalMinor).toBe('81999');
    // Категории из файла сопоставлены с существующими: «Транспорт» есть в пресетах, «Хобби» — нет.
    const transport = preview.journal.categories.find((c) => c.name === 'Транспорт');
    const hobby = preview.journal.categories.find((c) => c.name === 'Хобби');
    expect(transport?.existingId).not.toBeNull();
    expect(hobby?.existingId).toBeNull();

    // Ничего не записано: предпросмотр — это только взгляд.
    const txs = await expectOk<{ transactions: unknown[] }>(await client.get('/v1/transactions'));
    expect(txs.transactions).toHaveLength(0);
  });

  test('без названия листа предпросмотр отвечает составом книги', async () => {
    // Интерфейс не знает имён листов, пока не прочитает файл: первый запрос отвечает именно на это.
    const client = await onboarded();
    const preview = await expectOk<PreviewDto & { journal: null }>(
      await client.post('/v1/import/preview', { fileBase64: fixture.toString('base64') }),
    );
    expect(preview.sheets.map((s) => s.name)).toEqual(['Журнал', 'Словарь']);
    expect(preview.journal).toBeNull();
  });

  test('запись создаёт траты, недостающие категории и пачку импорта', async () => {
    const client = await onboarded();
    const result = await expectOk<CommitDto>(
      await upload(client, '/v1/import/commit', { sheet: 'Журнал' }),
      201,
    );
    expect(result.rowsImported).toBe(3);
    expect(result.categoriesCreated).toContain('Хобби');

    const cats = await expectOk<{ name: string }[]>(await client.get('/v1/categories'));
    expect(cats.map((c) => c.name)).toContain('Хобби');

    // Траты видны в своём периоде: ищем по диапазону, потому что даты историчные.
    const txs = await expectOk<{ transactions: { amountMinor: string }[] }>(
      await client.get('/v1/transactions?from=2022-01-01&to=2027-01-01'),
    );
    expect(txs.transactions).toHaveLength(3);
  });

  test('повторная загрузка того же файла не удваивает историю', async () => {
    const client = await onboarded();
    await expectOk<CommitDto>(await upload(client, '/v1/import/commit', { sheet: 'Журнал' }), 201);
    const again = await expectOk<CommitDto>(
      await upload(client, '/v1/import/commit', { sheet: 'Журнал' }),
      201,
    );

    expect(again.rowsImported).toBe(0);
    // Совпадения названы числом, а не пропущены молча: человек должен видеть, что ничего не делось.
    expect(again.rowsDuplicated).toBe(3);
    const txs = await expectOk<{ transactions: unknown[] }>(
      await client.get('/v1/transactions?from=2022-01-01&to=2027-01-01'),
    );
    expect(txs.transactions).toHaveLength(3);
  });

  test('импорт откатывается целиком', async () => {
    const client = await onboarded();
    const result = await expectOk<CommitDto>(
      await upload(client, '/v1/import/commit', { sheet: 'Журнал' }),
      201,
    );

    await expectOk(await client.del(`/v1/import/batches/${result.batchId}`));
    const txs = await expectOk<{ transactions: unknown[] }>(
      await client.get('/v1/transactions?from=2022-01-01&to=2027-01-01'),
    );
    expect(txs.transactions).toHaveLength(0);
    // Категории, созданные импортом, остаются: человек мог уже завести в них бюджет.
    const cats = await expectOk<{ name: string }[]>(await client.get('/v1/categories'));
    expect(cats.map((c) => c.name)).toContain('Хобби');
  });

  test('после отката тот же файл импортируется заново', async () => {
    const client = await onboarded();
    const first = await expectOk<CommitDto>(
      await upload(client, '/v1/import/commit', { sheet: 'Журнал' }),
      201,
    );
    await expectOk(await client.del(`/v1/import/batches/${first.batchId}`));

    const second = await expectOk<CommitDto>(
      await upload(client, '/v1/import/commit', { sheet: 'Журнал' }),
      201,
    );
    expect(second.rowsImported).toBe(3);
    expect(second.rowsDuplicated).toBe(0);
  });

  test('одинаковые строки в файле переносятся обе, но повтор файла их не удваивает', async () => {
    /*
     * В настоящем журнале встречаются строки-близнецы: одна и та же покупка дважды за день. Это
     * две разные траты, и обе должны переехать — на реальном файле первая версия отпечатка их
     * схлопывала и падала на уникальном индексе.
     */
    const client = await onboarded();
    const twins = readFileSync(fileURLToPath(new URL('./fixtures/twins.xlsx', import.meta.url)));
    const upload2 = () =>
      client.post('/v1/import/commit', {
        fileBase64: twins.toString('base64'),
        sheet: 'Журнал',
      });

    const first = await expectOk<CommitDto>(await upload2(), 201);
    expect(first.rowsImported).toBe(2);

    const second = await expectOk<CommitDto>(await upload2(), 201);
    expect(second.rowsImported).toBe(0);
    expect(second.rowsDuplicated).toBe(2);
  });

  test('не-таблица и неизвестный лист отклоняются понятной ошибкой', async () => {
    const client = await onboarded();
    const notXlsx = await client.post('/v1/import/preview', {
      fileBase64: Buffer.from('просто текст').toString('base64'),
      sheet: 'Журнал',
    });
    expect(notXlsx.status).toBe(400);
    expect(await notXlsx.json()).toMatchObject({ error: 'not_xlsx' });

    const wrongSheet = await upload(client, '/v1/import/preview', { sheet: 'Нет такого' });
    expect(wrongSheet.status).toBe(400);
    expect(await wrongSheet.json()).toMatchObject({ error: 'sheet_not_found' });
  });

  test('чужую пачку импорта откатить нельзя', async () => {
    const alice = await onboarded();
    const batch = await expectOk<CommitDto>(
      await upload(alice, '/v1/import/commit', { sheet: 'Журнал' }),
      201,
    );

    const bob = await onboarded();
    expect((await bob.del(`/v1/import/batches/${batch.batchId}`)).status).toBe(404);
    const txs = await expectOk<{ transactions: unknown[] }>(
      await alice.get('/v1/transactions?from=2022-01-01&to=2027-01-01'),
    );
    expect(txs.transactions).toHaveLength(3);
  });
});
