import { describe, expect, it } from 'vitest';
import { parseVisionPayload, RECEIPT_SCHEMA } from './vision.ts';

describe('parseVisionPayload — разбор ответа vision-модели', () => {
  it('читает итог, валюту, магазин и позиции', () => {
    const r = parseVisionPayload(
      JSON.stringify({
        merchant: 'Maxi',
        currency: 'rsd',
        purchasedOn: '2026-07-29',
        totalMajor: '2340.50',
        items: [
          { name: 'Хлеб', amountMajor: '89.00' },
          { name: 'Молоко', amountMajor: '150.50' },
        ],
      }),
    );

    expect(r).toEqual({
      merchant: 'Maxi',
      currency: 'RSD',
      purchasedOn: '2026-07-29',
      totalMinor: 234050n,
      items: [
        { name: 'Хлеб', amountMinor: 8900n },
        { name: 'Молоко', amountMinor: 15050n },
      ],
    });
  });

  it('модель вернула мусор вместо JSON — не роняем запрос, отдаём null', () => {
    expect(parseVisionPayload('извините, я не смог прочитать чек')).toBeNull();
    expect(parseVisionPayload('')).toBeNull();
  });

  it('нет итога — чек бесполезен: null, а не выдуманная сумма из позиций', () => {
    expect(
      parseVisionPayload(
        JSON.stringify({ currency: 'RSD', items: [{ name: 'Хлеб', amountMajor: '89' }] }),
      ),
    ).toBeNull();
  });

  it('нулевой или отрицательный итог отвергается', () => {
    expect(parseVisionPayload(JSON.stringify({ currency: 'RSD', totalMajor: '0' }))).toBeNull();
    expect(parseVisionPayload(JSON.stringify({ currency: 'RSD', totalMajor: '-10' }))).toBeNull();
  });

  it('валюты нет — тоже отказ: суммы без валюты в мультивалютном бюджете бессмысленны', () => {
    expect(parseVisionPayload(JSON.stringify({ totalMajor: '100' }))).toBeNull();
  });

  it('битые позиции выбрасываются, а сам чек остаётся', () => {
    const r = parseVisionPayload(
      JSON.stringify({
        currency: 'RUB',
        totalMajor: '500',
        items: [
          { name: 'Хлеб', amountMajor: '89' },
          { name: '', amountMajor: '10' },
          { name: 'Кола', amountMajor: 'непонятно' },
        ],
      }),
    );

    expect(r?.items).toEqual([{ name: 'Хлеб', amountMinor: 8900n }]);
    expect(r?.totalMinor).toBe(50000n);
  });

  it('дата не в формате YYYY-MM-DD отбрасывается, чек остаётся', () => {
    const r = parseVisionPayload(
      JSON.stringify({ currency: 'RUB', totalMajor: '100', purchasedOn: '29.07.2026' }),
    );

    expect(r?.purchasedOn).toBeNull();
    expect(r?.totalMinor).toBe(10000n);
  });

  it('схема для structured output требует итог и валюту', () => {
    expect(RECEIPT_SCHEMA.required).toContain('totalMajor');
    expect(RECEIPT_SCHEMA.required).toContain('currency');
    expect(RECEIPT_SCHEMA.additionalProperties).toBe(false);
  });
});
