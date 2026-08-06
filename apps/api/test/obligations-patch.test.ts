import { describe, expect, test } from 'vitest';
import { expectOk, onboarded } from './client.ts';

/**
 * Правка обязательств (issue #91).
 *
 * До этого ручки долгов, конвертов, целей и корзин умели только GET/POST/DELETE. Значит опечатку в
 * названии долга или неверную сумму конверта нельзя было исправить — только удалить строку и
 * завести заново, а вместе с долгом уходила история платежей и прогноз закрытия. У категорий,
 * счетов, регулярных платежей и источников дохода PATCH при этом был: продукт вёл себя
 * по-разному с однородными сущностями.
 */

interface Row {
  id: string;
  name: string;
  currency: string;
  remainingMinor?: string;
  paymentMinor?: string;
  targetMinor?: string;
  ruleValue?: string;
  amountMinor?: string;
}

const SECTIONS = [
  {
    path: 'debts',
    create: {
      name: 'Кредит',
      currency: 'RUB',
      principalMinor: '50000000',
      remainingMinor: '50000000',
      paymentMinor: '1200000',
    },
    patch: { name: 'Кредит банка', paymentMinor: '1500000' },
    check: (row: Row) => {
      expect(row.name).toBe('Кредит банка');
      expect(row.paymentMinor).toBe('1500000');
      // Непереданное поле обязано уцелеть: PATCH правит, а не пересоздаёт.
      expect(row.remainingMinor).toBe('50000000');
    },
  },
  {
    path: 'envelopes',
    create: { name: 'Здоровье', currency: 'RUB', ruleKind: 'fixed', ruleValue: '300000' },
    patch: { name: 'Здоровье и спорт' },
    check: (row: Row) => {
      expect(row.name).toBe('Здоровье и спорт');
      // numeric из базы приходит как «300000.0000» — сравниваем значение, а не его запись.
      expect(Number(row.ruleValue)).toBe(300000);
    },
  },
  {
    path: 'goals',
    create: { name: 'Мотоцикл', currency: 'RUB', targetMinor: '30000000' },
    patch: { targetMinor: '35000000' },
    check: (row: Row) => {
      expect(row.targetMinor).toBe('35000000');
      expect(row.name).toBe('Мотоцикл');
    },
  },
  {
    path: 'buckets',
    create: { name: 'Аренда', fromCurrency: 'RUB', toCurrency: 'EUR', amountMinor: '60000000' },
    patch: { amountMinor: '65000000' },
    check: (row: Row) => {
      expect(row.amountMinor).toBe('65000000');
      expect(row.name).toBe('Аренда');
    },
  },
] as const;

describe('правка обязательств', () => {
  for (const section of SECTIONS) {
    test(`${section.path}: правка меняет заданное и не трогает остальное`, async () => {
      const client = await onboarded();
      const created = await expectOk<Row>(
        await client.post(`/v1/${section.path}`, section.create),
        201,
      );

      const patched = await expectOk<Row>(
        await client.patch(`/v1/${section.path}/${created.id}`, section.patch),
      );
      section.check(patched);
      expect(patched.id).toBe(created.id);

      // Правка должна быть записана, а не только отражена в ответе.
      const list = await expectOk<Row[]>(await client.get(`/v1/${section.path}`));
      const stored = list.find((r) => r.id === created.id);
      if (!stored) throw new Error('строка исчезла из списка после правки');
      section.check(stored);
    });

    test(`${section.path}: чужую строку править нельзя`, async () => {
      const alice = await onboarded();
      const bob = await onboarded();
      const mine = await expectOk<Row>(
        await alice.post(`/v1/${section.path}`, section.create),
        201,
      );

      const res = await bob.patch(`/v1/${section.path}/${mine.id}`, section.patch);
      expect(res.status).toBe(404);

      // И у владельца строка осталась нетронутой — отказ не должен быть «тихим успехом».
      const list = await expectOk<Row[]>(await alice.get(`/v1/${section.path}`));
      expect(list.find((r) => r.id === mine.id)?.name).toBe(section.create.name);
    });
  }

  test('несуществующий id — 404, а не «успешно»', async () => {
    const client = await onboarded();
    const res = await client.patch('/v1/debts/00000000-0000-4000-8000-000000000000', {
      name: 'нет такого',
    });
    expect(res.status).toBe(404);
  });

  test('пустое тело правки отклоняется: молчаливый no-op выглядит как сохранение', async () => {
    const client = await onboarded();
    const created = await expectOk<Row>(await client.post('/v1/debts', SECTIONS[0].create), 201);
    const res = await client.patch(`/v1/debts/${created.id}`, {});
    expect(res.status).toBe(400);
  });
});
