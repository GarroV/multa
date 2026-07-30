import { describe, expect, it } from 'vitest';
import { parseReceiptQr } from './receiptQr.ts';

describe('parseReceiptQr — разбор QR фискального чека (Спринт 5)', () => {
  it('ФНС РФ: вытаскивает сумму, дату и реквизиты для запроса позиций', () => {
    // Формат ФНС: t=дата&s=сумма&fn=ФН&i=номер ФД&fp=фискальный признак&n=тип
    const r = parseReceiptQr('t=20260730T1215&s=2340.50&fn=9960440301234567&i=12345&fp=1234567890&n=1');

    expect(r).toEqual({
      provider: 'fns_ru',
      totalMinor: 234050n,
      currency: 'RUB',
      purchasedAt: '2026-07-30T12:15:00Z',
      raw: 't=20260730T1215&s=2340.50&fn=9960440301234567&i=12345&fp=1234567890&n=1',
      reference: { fn: '9960440301234567', fd: '12345', fp: '1234567890' },
    });
  });

  it('ФНС РФ: сумма без копеек тоже валидна', () => {
    expect(parseReceiptQr('t=20260730T1215&s=500&fn=1&i=2&fp=3&n=1')?.totalMinor).toBe(50000n);
  });

  it('Сербия: ссылка suf.purs.gov.rs распознаётся по домену, сумма из параметров', () => {
    const r = parseReceiptQr('https://suf.purs.gov.rs/v/?vl=AjQ5T0tYSjU2NDlPS1hKNTaqAQAAtQEAAECEVQIAAAA%3D');

    expect(r?.provider).toBe('suf_rs');
    expect(r?.currency).toBe('RSD');
    // Позиции и сумма приходят из фискального сервиса — здесь фиксируем только ссылку.
    expect(r?.totalMinor).toBeNull();
  });

  it('мусор и не-чековые ссылки не превращаем в чек', () => {
    expect(parseReceiptQr('https://example.com/hello')).toBeNull();
    expect(parseReceiptQr('просто текст')).toBeNull();
    expect(parseReceiptQr('')).toBeNull();
  });

  it('ФНС без обязательных полей — не чек: сумма без фискальных реквизитов не проверяема', () => {
    expect(parseReceiptQr('t=20260730T1215&s=100')).toBeNull();
  });

  it('нулевая или отрицательная сумма отвергается', () => {
    expect(parseReceiptQr('t=20260730T1215&s=0&fn=1&i=2&fp=3&n=1')).toBeNull();
    expect(parseReceiptQr('t=20260730T1215&s=-5&fn=1&i=2&fp=3&n=1')).toBeNull();
  });

  it('дата с секундами и без — обе читаются', () => {
    expect(parseReceiptQr('t=20260730T121533&s=100&fn=1&i=2&fp=3&n=1')?.purchasedAt).toBe('2026-07-30T12:15:33Z');
    expect(parseReceiptQr('t=20260730T1215&s=100&fn=1&i=2&fp=3&n=1')?.purchasedAt).toBe('2026-07-30T12:15:00Z');
  });

  it('битая дата не роняет разбор — чек остаётся, дату уточнит пользователь', () => {
    const r = parseReceiptQr('t=непонятно&s=100&fn=1&i=2&fp=3&n=1');

    expect(r?.totalMinor).toBe(10000n);
    expect(r?.purchasedAt).toBeNull();
  });
});
