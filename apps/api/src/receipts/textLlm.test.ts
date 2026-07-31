import { describe, expect, it } from 'vitest';
import { parseTextPayload, TEXT_ENTRY_SCHEMA } from './textLlm.ts';

describe('parseTextPayload — разбор ответа LLM для текстового ввода', () => {
  it('читает сумму, валюту, дату, вид и категорию', () => {
    const r = parseTextPayload(
      JSON.stringify({
        kind: 'expense',
        amountMajor: '1250.50',
        currency: 'rsd',
        occurredOn: '2026-07-29',
        categoryName: 'Продукты',
        note: 'Maxi',
      }),
      { baseCurrency: 'RUB', today: '2026-07-30' },
    );

    expect(r).toEqual({
      kind: 'expense',
      amountMinor: 125050n,
      currency: 'RSD',
      occurredOn: '2026-07-29',
      categoryName: 'Продукты',
      note: 'Maxi',
    });
  });

  it('валюты нет — берём базовую воркспейса, а не отказываем', () => {
    const r = parseTextPayload(JSON.stringify({ kind: 'expense', amountMajor: '300' }), {
      baseCurrency: 'RUB',
      today: '2026-07-30',
    });

    expect(r?.currency).toBe('RUB');
    expect(r?.amountMinor).toBe(30000n);
  });

  it('даты нет — сегодня воркспейса', () => {
    const r = parseTextPayload(JSON.stringify({ kind: 'expense', amountMajor: '300' }), {
      baseCurrency: 'RUB',
      today: '2026-07-30',
    });

    expect(r?.occurredOn).toBe('2026-07-30');
  });

  it('без суммы — отказ: выдуманная сумма хуже просьбы уточнить', () => {
    expect(
      parseTextPayload(JSON.stringify({ kind: 'expense' }), {
        baseCurrency: 'RUB',
        today: '2026-07-30',
      }),
    ).toBeNull();
    expect(parseTextPayload('не понял', { baseCurrency: 'RUB', today: '2026-07-30' })).toBeNull();
  });

  it('ноль и минус отвергаются: знак несёт вид операции', () => {
    const ctx = { baseCurrency: 'RUB', today: '2026-07-30' };
    expect(parseTextPayload(JSON.stringify({ kind: 'expense', amountMajor: '0' }), ctx)).toBeNull();
    expect(
      parseTextPayload(JSON.stringify({ kind: 'expense', amountMajor: '-5' }), ctx),
    ).toBeNull();
  });

  it('приход не получает категорию даже если модель её придумала', () => {
    const r = parseTextPayload(
      JSON.stringify({ kind: 'income', amountMajor: '15000', categoryName: 'Кафе' }),
      { baseCurrency: 'RUB', today: '2026-07-30' },
    );

    expect(r?.kind).toBe('income');
    expect(r?.categoryName).toBeNull();
  });

  it('дата из будущего отбрасывается: вводят факт, а не план', () => {
    const r = parseTextPayload(
      JSON.stringify({ kind: 'expense', amountMajor: '100', occurredOn: '2027-01-01' }),
      { baseCurrency: 'RUB', today: '2026-07-30' },
    );

    expect(r?.occurredOn).toBe('2026-07-30');
  });

  it('схема strict: сумма обязательна, лишних полей нет', () => {
    expect(TEXT_ENTRY_SCHEMA.required).toContain('amountMajor');
    expect(TEXT_ENTRY_SCHEMA.additionalProperties).toBe(false);
  });
});
