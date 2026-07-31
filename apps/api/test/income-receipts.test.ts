import { describe, expect, test } from 'vitest';
import { expectOk, getPlan, onboarded, seedRate, signedUp, type TestClient } from './client.ts';

/**
 * Поступление дохода (issue #48): пока выплата «ожидается», план считается по плановой сумме;
 * как только человек подтвердил факт, план обязан пересчитаться по фактической сумме и по курсу,
 * зафиксированному в день выплаты.
 *
 * Проверяется ровно то, что ломает доверие к цифре дня: расхождение факта с планом, ручной курс
 * вместо чужой котировки и иммутабельность зафиксированного снапшота (правило 2).
 */

interface IncomeSourceRow {
  id: string;
  label: string;
}

interface ReceiptRow {
  id: string;
  sourceId: string;
  amountMinor: string;
  currency: string;
  baseAmountMinor: string;
  rate: string;
  rateSource: string;
  rateDate: string;
  occurredOn: string;
}

interface PlanIncomeEvent {
  sourceId: string;
  amountMinor: string;
  status: 'expected' | 'received';
  receiptId?: string;
}

async function firstSource(client: TestClient): Promise<IncomeSourceRow> {
  const rows = await expectOk<IncomeSourceRow[]>(await client.get('/v1/income-sources'));
  const first = rows[0];
  if (!first) throw new Error('источник дохода не создан онбордингом');
  return first;
}

/** Дата внутри текущего периода: подтверждение обязано попасть именно в него. */
async function dayInPeriod(client: TestClient): Promise<string> {
  const plan = await getPlan(client);
  return plan.period.startsOn;
}

describe('подтверждение поступления', () => {
  test('фактическая сумма меньше плана — план пересобирается по факту', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const source = await firstSource(client);
    const on = await dayInPeriod(client);
    const before = await getPlan(client);
    expect(BigInt(before.incomeMinor)).toBe(30_000_000n);

    await expectOk(
      await client.post(`/v1/income-sources/${source.id}/received`, {
        amountMinor: '25000000',
        occurredOn: on,
      }),
      201,
    );

    const after = await getPlan(client);
    // Доход периода — фактический: цифра дня, посчитанная по плановой сумме, обманывала бы.
    expect(BigInt(after.incomeMinor)).toBe(25_000_000n);
    const event = after.income.events.find((e) => e.sourceId === source.id) as
      PlanIncomeEvent | undefined;
    expect(event?.status).toBe('received');
    expect(event?.amountMinor).toBe('25000000');
  });

  test('приход больше плана тоже учитывается, а не обрезается до плана', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const source = await firstSource(client);
    const on = await dayInPeriod(client);

    await expectOk(
      await client.post(`/v1/income-sources/${source.id}/received`, {
        amountMinor: '34000000',
        occurredOn: on,
      }),
      201,
    );

    const plan = await getPlan(client);
    expect(BigInt(plan.incomeMinor)).toBe(34_000_000n);
  });

  test('ручной курс дня выплаты побеждает котировку источника', async () => {
    const client = await onboarded({ baseCurrency: 'RUB', payoutMinor: '30000000' });
    const source = await firstSource(client);
    const on = await dayInPeriod(client);
    // Котировка ЦБ на ту же дату — та, что подставилась бы без ручного ввода.
    await seedRate('EUR', 'RUB', '90.0000000000', on, 'cbr');

    const receipt = await expectOk<ReceiptRow>(
      await client.post(`/v1/income-sources/${source.id}/received`, {
        amountMinor: '300000',
        currency: 'EUR',
        occurredOn: on,
        rate: '93.5',
      }),
      201,
    );

    expect(receipt.rateSource).toBe('manual');
    // 3 000 EUR по курсу 93.5 = 280 500 RUB, а не 270 000 по курсу ЦБ.
    expect(receipt.baseAmountMinor).toBe('28050000');
    const plan = await getPlan(client);
    expect(BigInt(plan.incomeMinor)).toBe(28_050_000n);
  });

  test('зафиксированный курс не переписывается новой котировкой (правило 2)', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const source = await firstSource(client);
    const on = await dayInPeriod(client);

    const receipt = await expectOk<ReceiptRow>(
      await client.post(`/v1/income-sources/${source.id}/received`, {
        amountMinor: '300000',
        currency: 'EUR',
        occurredOn: on,
        rate: '93.5',
      }),
      201,
    );
    const fixed = receipt.baseAmountMinor;

    // Котировка обновилась (ЦБ опубликовал курс позже) — история не пересчитывается.
    await seedRate('EUR', 'RUB', '99.0000000000', on, 'cbr');
    const plan = await getPlan(client);
    expect(BigInt(plan.incomeMinor)).toBe(BigInt(fixed));
  });

  test('нехватка после урезанного прихода сжимает снизу вверх, долги остаются целыми', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const source = await firstSource(client);
    const on = await dayInPeriod(client);

    await expectOk(
      await client.post('/v1/debts', {
        name: 'Кредит',
        currency: 'RUB',
        principalMinor: '50000000',
        remainingMinor: '50000000',
        paymentMinor: '15000000',
      }),
      201,
    );
    await expectOk(
      await client.post('/v1/goals', {
        name: 'Мотоцикл',
        currency: 'RUB',
        targetMinor: '40000000',
        plannedPerPeriodMinor: '12000000',
      }),
      201,
    );

    await expectOk(
      await client.post(`/v1/income-sources/${source.id}/received`, {
        amountMinor: '18000000',
        occurredOn: on,
      }),
      201,
    );

    const plan = await getPlan(client);
    const debt = plan.allocations.find((a) => a.targetKind === 'debt');
    const goal = plan.allocations.find((a) => a.targetKind === 'goal');
    expect(BigInt(debt?.allocatedMinor ?? '0')).toBe(15_000_000n);
    // Цель уступает первой — это и есть обратное сжатие каскада.
    expect(BigInt(goal?.allocatedMinor ?? '0')).toBeLessThan(12_000_000n);
    expect(BigInt(plan.compressedMinor)).toBeGreaterThan(0n);
  });

  test('повторное подтверждение того же события отклоняется, отмена возвращает план к плановому', async () => {
    const client = await onboarded({ payoutMinor: '30000000' });
    const source = await firstSource(client);
    const on = await dayInPeriod(client);

    const receipt = await expectOk<ReceiptRow>(
      await client.post(`/v1/income-sources/${source.id}/received`, {
        amountMinor: '25000000',
        occurredOn: on,
      }),
      201,
    );
    // Второй раз — 409, а не тихое удвоение дохода.
    expect(
      (
        await client.post(`/v1/income-sources/${source.id}/received`, {
          amountMinor: '25000000',
          occurredOn: on,
        })
      ).status,
    ).toBe(409);

    await expectOk(await client.del(`/v1/income-receipts/${receipt.id}`), 200);
    const plan = await getPlan(client);
    expect(BigInt(plan.incomeMinor)).toBe(30_000_000n);
    expect(plan.income.events.every((e) => (e as PlanIncomeEvent).status === 'expected')).toBe(
      true,
    );
  });

  test('чужой источник и чужое подтверждение недоступны', async () => {
    const alice = await onboarded();
    const source = await firstSource(alice);
    const on = await dayInPeriod(alice);
    const receipt = await expectOk<ReceiptRow>(
      await alice.post(`/v1/income-sources/${source.id}/received`, {
        amountMinor: '25000000',
        occurredOn: on,
      }),
      201,
    );

    const bob = await onboarded();
    expect(
      (
        await bob.post(`/v1/income-sources/${source.id}/received`, {
          amountMinor: '1000',
          occurredOn: on,
        })
      ).status,
    ).toBe(404);
    expect((await bob.del(`/v1/income-receipts/${receipt.id}`)).status).toBe(404);
  });

  test('личный курс не протекает в чужой воркспейс', async () => {
    const alice = await onboarded({ payoutMinor: '30000000' });
    const source = await firstSource(alice);
    const on = await dayInPeriod(alice);
    // Публичная котировка на ту же дату — её и должен видеть второй воркспейс.
    await seedRate('EUR', 'RUB', '90.0000000000', on, 'cbr');
    await expectOk(
      await alice.post(`/v1/income-sources/${source.id}/received`, {
        amountMinor: '100000',
        currency: 'EUR',
        occurredOn: on,
        rate: '120.0',
      }),
      201,
    );

    const bob = await onboarded({ payoutMinor: '30000000' });
    const bobSource = await firstSource(bob);
    const bobReceipt = await expectOk<ReceiptRow>(
      await bob.post(`/v1/income-sources/${bobSource.id}/received`, {
        amountMinor: '100000',
        currency: 'EUR',
        occurredOn: on,
      }),
      201,
    );
    // Курс Алисы (120) — её личный факт: Боб считается по котировке ЦБ (90), а не по нему.
    expect(bobReceipt.rateSource).toBe('cbr');
    expect(bobReceipt.baseAmountMinor).toBe('9000000');
  });

  test('без воркспейса ручка недоступна', async () => {
    // Зарегистрировались, но воркспейс не создали: middleware отвечает 409 workspace_required —
    // тот же контракт, что у остальных ручек, отдельного поведения у поступлений нет.
    const client = await signedUp();
    expect(
      (
        await client.post('/v1/income-sources/00000000-0000-0000-0000-000000000000/received', {
          amountMinor: '1000',
          occurredOn: '2026-07-25',
        })
      ).status,
    ).toBe(409);
  });
});
