import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.ts';
import { categories, debts, envelopes, goals } from '../src/db/schema/domain.ts';
import { expectOk, onboarded, type TestClient } from './client.ts';

/**
 * Перенос плана из Excel (issue #124) — то, ради чего продукт вообще нужен владельцу: он ведёт
 * бюджет в таблице, и пока таблица не переезжает, Multa остаётся вторым местом учёта.
 *
 * Раскладку строк по видам делает человек: файл даёт имена, а не природу («Сбер» это кредит,
 * «Отпуск» цель). Угадывать нельзя — вид решает судьбу строки в каскаде: долг неприкосновенен, а
 * категорию при нехватке режут. Поэтому проверяется не только «создалось», но и что продукт НЕ
 * создаёт того, о чём его не просили.
 */

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/master-grid.xlsx', import.meta.url)),
);

interface PlanPreviewDto {
  sheets: { name: string; rows: number }[];
  plan: {
    periods: number;
    from: string | null;
    to: string | null;
    incomeTotalMinor: string;
    lines: { name: string; medianMinor: string; paidPeriods: number; totalMinor: string }[];
    suggestions: {
      index: number;
      name: string;
      kind: string;
      reason: string;
      perPeriodMinor: string;
      totalAheadMinor: string;
    }[];
  } | null;
}

interface ApplyDto {
  created: { debts: number; goals: number; envelopes: number; categories: number };
  skipped: { name: string; reason: string }[];
}

async function upload(client: TestClient, path: string, body: Record<string, unknown>) {
  return client.post(path, { ...body, fileBase64: fixture.toString('base64') });
}

/** Идентификатор воркспейса наружу отдаёт только `/v1/me`: клиент его не знает и знать не должен. */
async function workspaceIdOf(client: TestClient): Promise<string> {
  const me = await expectOk<{ workspace: { id: string } | null }>(await client.get('/v1/me'));
  return me.workspace!.id;
}

describe('перенос плана из Excel', () => {
  test('предпросмотр подсказывает вид каждой строки и ничего не пишет', async () => {
    const client = await onboarded();
    const preview = await expectOk<PlanPreviewDto>(
      await upload(client, '/v1/import/plan-preview', { sheet: 'План' }),
    );

    const names = preview.plan!.suggestions.map((s) => s.name);
    expect(names).toContain('Сбер');
    // «Итого затраты» — арифметика по остальным строкам. Перенеси её категорией, и план раздуется
    // вдвое: человек получит двойник поверх настоящих статей.
    const total = preview.plan!.suggestions.find((s) => s.name === 'Итого затраты');
    expect(total).toMatchObject({ kind: 'skip', reason: 'looks_like_total' });
    // Обычная статья — категория: единственный вид, который каскад режет при нехватке.
    expect(preview.plan!.suggestions.find((s) => s.name === 'Еда, продукты')).toMatchObject({
      kind: 'category',
      reason: 'default',
    });
    /*
     * Подсказка называет ровно ту сумму, которая переедет. Раньше предпросмотр показывал медиану по
     * всей истории, а записывалась медиана будущих колонок — человек решал раскладку по одному
     * числу, а получал другое (поймано смоуком на эталонном файле).
     */
    const sber = preview.plan!.suggestions.find((s) => s.name === 'Сбер')!;
    expect(sber.perPeriodMinor).toBe('1200000');

    const wsId = await workspaceIdOf(client);
    const rows = await db.select().from(debts).where(eq(debts.workspaceId, wsId));
    expect(rows).toHaveLength(0);
  });

  test('перенос создаёт ровно то, что выбрал человек', async () => {
    const client = await onboarded();
    const preview = await expectOk<PlanPreviewDto>(
      await upload(client, '/v1/import/plan-preview', { sheet: 'План' }),
    );
    const indexOf = (name: string) => preview.plan!.suggestions.find((s) => s.name === name)!.index;

    const applied = await expectOk<ApplyDto>(
      await upload(client, '/v1/import/plan-apply', {
        sheet: 'План',
        assignment: {
          [indexOf('Сбер')]: 'debt',
          [indexOf('Отпуск')]: 'goal',
          [indexOf('Еда, продукты')]: 'category',
        },
      }),
    );
    expect(applied.created).toEqual({ debts: 1, goals: 1, envelopes: 0, categories: 1 });

    const wsId = await workspaceIdOf(client);
    const debtRows = await db.select().from(debts).where(eq(debts.workspaceId, wsId));
    expect(debtRows).toHaveLength(1);
    expect(debtRows[0]!.name).toBe('Сбер');
    // Платёж — медиана будущих колонок, остаток — их сумма. Взяв всю историю, продукт удвоил бы
    // долг и требовал бы платить годы после закрытия.
    expect(debtRows[0]!.paymentMinor).toBe(1_200_000n);

    const goalRows = await db.select().from(goals).where(eq(goals.workspaceId, wsId));
    expect(goalRows.map((g) => g.name)).toEqual(['Отпуск']);

    const catRows = await db
      .select()
      .from(categories)
      .where(and(eq(categories.workspaceId, wsId), eq(categories.archived, false)));
    expect(catRows.map((c) => c.name)).toContain('Еда, продукты');
    // Итоговой строки среди созданного быть не должно: её не выбирали.
    expect(catRows.map((c) => c.name)).not.toContain('Итого затраты');
  });

  test('строка без вида не переносится: продукт не решает за человека', async () => {
    const client = await onboarded();
    const applied = await expectOk<ApplyDto>(
      await upload(client, '/v1/import/plan-apply', { sheet: 'План', assignment: {} }),
    );
    expect(applied.created).toEqual({ debts: 0, goals: 0, envelopes: 0, categories: 0 });
  });

  test('строка без денег впереди не создаёт пустую сущность и говорит почему', async () => {
    const client = await onboarded();
    const preview = await expectOk<PlanPreviewDto>(
      await upload(client, '/v1/import/plan-preview', { sheet: 'План' }),
    );
    const equipment = preview.plan!.suggestions.find((s) => s.name === 'Оборудование')!;
    expect(equipment.reason).toBe('nothing_ahead');

    const applied = await expectOk<ApplyDto>(
      await upload(client, '/v1/import/plan-apply', {
        sheet: 'План',
        assignment: { [equipment.index]: 'debt' },
      }),
    );
    expect(applied.created.debts).toBe(0);
    expect(applied.skipped).toEqual([{ name: 'Оборудование', reason: 'nothing_ahead' }]);
  });

  test('повторный перенос не удваивает: сущность с тем же именем остаётся одна', async () => {
    /*
     * Человек загружает файл дважды — уточнил раскладку, поправил суммы в таблице. Второй прогон не
     * должен давать «Сбер» и «Сбер (2)»: дубль долга удвоил бы неприкосновенную часть каскада и
     * съел бы деньги, которых нет.
     */
    const client = await onboarded();
    const preview = await expectOk<PlanPreviewDto>(
      await upload(client, '/v1/import/plan-preview', { sheet: 'План' }),
    );
    const sber = preview.plan!.suggestions.find((s) => s.name === 'Сбер')!.index;

    await expectOk(
      await upload(client, '/v1/import/plan-apply', {
        sheet: 'План',
        assignment: { [sber]: 'debt' },
      }),
    );
    const second = await expectOk<ApplyDto>(
      await upload(client, '/v1/import/plan-apply', {
        sheet: 'План',
        assignment: { [sber]: 'debt' },
      }),
    );
    expect(second.created.debts).toBe(0);

    const wsId = await workspaceIdOf(client);
    const rows = await db.select().from(debts).where(eq(debts.workspaceId, wsId));
    expect(rows).toHaveLength(1);
  });

  test('конверт переносится фиксированной суммой на период', async () => {
    const client = await onboarded();
    const preview = await expectOk<PlanPreviewDto>(
      await upload(client, '/v1/import/plan-preview', { sheet: 'План' }),
    );
    const food = preview.plan!.suggestions.find((s) => s.name === 'Еда, продукты')!.index;

    const applied = await expectOk<ApplyDto>(
      await upload(client, '/v1/import/plan-apply', {
        sheet: 'План',
        assignment: { [food]: 'envelope' },
      }),
    );
    expect(applied.created.envelopes).toBe(1);

    const wsId = await workspaceIdOf(client);
    const rows = await db.select().from(envelopes).where(eq(envelopes.workspaceId, wsId));
    expect(rows[0]).toMatchObject({ name: 'Еда, продукты', ruleKind: 'fixed' });
  });

  test('лист не тот — понятная ошибка, а не пустой перенос', async () => {
    const client = await onboarded();
    const res = await upload(client, '/v1/import/plan-apply', {
      sheet: 'Нет такого листа',
      assignment: {},
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'sheet_not_found' });
  });
});
