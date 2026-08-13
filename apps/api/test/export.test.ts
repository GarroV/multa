import { describe, expect, test } from 'vitest';
import { app } from '../src/app.ts';
import { categoryId, expectOk, onboarded } from './client.ts';

/**
 * Экспорт данных (Спринт 6). Условие, без которого нельзя звать посторонних: человек, отдавший
 * продукту свои деньги, должен уметь забрать их и уйти — файлом, а не письмом основателю.
 *
 * Выгружаются траты: остальное (план, обязательства) выводится из них и настроек, а история
 * операций — то единственное, что человек вводил руками и что нельзя восстановить.
 */
describe('экспорт трат в CSV', () => {
  test('отдаёт файл с заголовком и строками', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const food = await categoryId(client, 'Продукты');
    await expectOk(
      await client.post('/v1/transactions', {
        amountMinor: '125000',
        currency: 'RUB',
        categoryId: food,
        occurredOn: '2026-08-01',
        note: 'кофе, большой',
      }),
      201,
    );

    const res = await client.get('/v1/export/transactions.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    // Имя файла в заголовке: браузер должен сохранить его как файл, а не показать текстом.
    expect(res.headers.get('content-disposition')).toContain('attachment');

    const text = await res.text();
    const [head, ...rows] = text.split('\r\n');
    expect(head).toBe('date,kind,amount,currency,base_amount,base_currency,rate,category,note');
    expect(rows).toHaveLength(1);
    // Запятая в заметке экранирована — иначе строка молча съезжает на колонку.
    expect(rows[0]).toContain('"кофе, большой"');
    expect(rows[0]).toContain('2026-08-01');
    expect(rows[0]).toContain('Продукты');
  });

  test('чужие траты в выгрузку не попадают', async () => {
    const alice = await onboarded({ payoutMinor: '30000000' });
    await expectOk(
      await alice.post('/v1/transactions', {
        amountMinor: '999000',
        currency: 'RUB',
        occurredOn: '2026-08-02',
        note: 'секрет алисы',
      }),
      201,
    );

    const bob = await onboarded();
    const text = await (await bob.get('/v1/export/transactions.csv')).text();
    expect(text).not.toContain('секрет алисы');
  });

  test('без входа файл не отдаётся', async () => {
    // Прямо в приложение, без банки cookie: выгрузка данных не должна открываться по одной ссылке.
    const res = await app.request('http://localhost:3000/v1/export/transactions.csv');
    expect(res.status).toBe(401);
  });
});
