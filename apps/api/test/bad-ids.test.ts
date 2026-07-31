import { describe, expect, test } from 'vitest';
import { onboarded } from './client.ts';

/**
 * Кривой id в пути — это «нет такого», а не сбой сервера.
 *
 * Найдено адверсарным аудитом: `DELETE /v1/exchange-ops/not-a-uuid` и `/v1/buckets/not-a-uuid`
 * отвечали 500, потому что Postgres бросает 22P02 на нечисловом uuid. Пятисотка и врёт клиенту
 * («у нас всё сломалось» вместо «такого нет»), и засоряет логи чужими ошибками, из-за чего в них
 * тонут настоящие аварии.
 *
 * Тест идёт по всем ручкам с `:id` сразу: дефект был классовым, и починка одной ручки его бы не
 * закрыла.
 */

const GARBAGE = ['not-a-uuid', '123', '../etc/passwd', '00000000-0000-0000-0000-00000000000'];

const ENDPOINTS: {
  method: 'get' | 'del' | 'patch' | 'post' | 'put';
  path: (id: string) => string;
}[] = [
  { method: 'del', path: (id) => `/v1/exchange-ops/${id}` },
  { method: 'del', path: (id) => `/v1/buckets/${id}` },
  { method: 'del', path: (id) => `/v1/debts/${id}` },
  { method: 'del', path: (id) => `/v1/envelopes/${id}` },
  { method: 'del', path: (id) => `/v1/goals/${id}` },
  { method: 'del', path: (id) => `/v1/transactions/${id}` },
  { method: 'del', path: (id) => `/v1/accounts/${id}` },
  { method: 'del', path: (id) => `/v1/categories/${id}` },
  { method: 'del', path: (id) => `/v1/income-sources/${id}` },
  { method: 'del', path: (id) => `/v1/income-receipts/${id}` },
  { method: 'del', path: (id) => `/v1/recurring-items/${id}` },
  { method: 'patch', path: (id) => `/v1/accounts/${id}` },
  { method: 'patch', path: (id) => `/v1/categories/${id}` },
  { method: 'patch', path: (id) => `/v1/income-sources/${id}` },
  { method: 'patch', path: (id) => `/v1/recurring-items/${id}` },
  { method: 'post', path: (id) => `/v1/receipts/${id}/confirm` },
  { method: 'post', path: (id) => `/v1/plan/current/revisions/${id}/undo` },
  { method: 'post', path: (id) => `/v1/plan/current/items/goal/${id}/freeze` },
  { method: 'post', path: (id) => `/v1/income-sources/${id}/received` },
  { method: 'put', path: (id) => `/v1/plan/current/categories/${id}` },
];

describe('кривой id в пути', () => {
  test('ни одна ручка не отвечает 500 на мусорный id', async () => {
    const client = await onboarded();
    const failures: string[] = [];

    for (const endpoint of ENDPOINTS) {
      for (const id of GARBAGE) {
        const path = endpoint.path(id);
        const res =
          endpoint.method === 'del'
            ? await client.del(path)
            : endpoint.method === 'get'
              ? await client.get(path)
              : endpoint.method === 'patch'
                ? await client.patch(path, {})
                : endpoint.method === 'put'
                  ? await client.put(path, { plannedMinor: '1000' })
                  : await client.post(path, { amountMinor: '1000', occurredOn: '2026-07-25' });
        // 400 (не прошла схема тела) и 404 (нет такого) допустимы; 500 — нет.
        if (res.status >= 500)
          failures.push(`${endpoint.method.toUpperCase()} ${path} → ${res.status}`);
      }
    }

    expect(failures).toEqual([]);
  });
});
