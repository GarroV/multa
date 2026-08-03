import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded } from './client.ts';

/**
 * Несистемный доход: ежедневный и недельный.
 *
 * Первый живой тестировщик (2026-08-03) бросил онбординг на первом же шаге: доход у неё приходит
 * каждый день, а выбрать можно было только «числа месяца», «раз в N недель» и «когда как».
 * «Когда как» — не её случай: доход предсказуем, просто частотой, а не датами; уводить его в
 * «нерегулярный» значило бы выкинуть его из плана целиком и оставить человека без цифры дня.
 *
 * Проверяем именно границу API: ядро эти виды уже считает, но пока схема их не пропускает,
 * продукта у пользователя нет.
 */

interface SourceRow {
  id: string;
  schedule: { kind: string; weekday?: number };
}

describe('несистемный доход через API', () => {
  test('ежедневный источник принимается и даёт приход каждый день периода', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });

    const created = await expectOk<SourceRow>(
      await client.post('/v1/income-sources', {
        label: 'Смены',
        currency: 'RUB',
        schedule: { kind: 'daily' },
        amount: { kind: 'absolute', amountMinor: '250000' },
        stability: 'variable',
      }),
      201,
    );
    expect(created.schedule.kind).toBe('daily');

    const plan = await getPlan(client);
    const days = plan.income.events.filter((e) => e.sourceId === created.id);
    /* Полумесяц — минимум 13 дней; проверяем «каждый день», а не точное число. */
    expect(days.length).toBeGreaterThanOrEqual(13);
  });

  test('недельный источник принимается и приходит по одному дню недели', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });

    const created = await expectOk<SourceRow>(
      await client.post('/v1/income-sources', {
        label: 'Подработка по пятницам',
        currency: 'RUB',
        schedule: { kind: 'weekly', weekday: 5 },
        amount: { kind: 'absolute', amountMinor: '800000' },
        stability: 'variable',
      }),
      201,
    );
    expect(created.schedule).toEqual({ kind: 'weekly', weekday: 5 });

    const plan = await getPlan(client);
    const days = plan.income.events.filter((e) => e.sourceId === created.id);
    expect(days.length).toBeGreaterThanOrEqual(2);
    for (const e of days) {
      expect(new Date(`${e.date}T00:00:00Z`).getUTCDay()).toBe(5);
    }
  });

  test('день недели вне 0..6 отклоняется', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const res = await client.post('/v1/income-sources', {
      label: 'Кривой день',
      currency: 'RUB',
      schedule: { kind: 'weekly', weekday: 7 },
      amount: { kind: 'absolute', amountMinor: '100000' },
    });
    expect(res.status).toBe(400);
  });
});
