import { describe, expect, it } from 'vitest';
import { compareProviders, type ProviderDeal } from './providers.ts';

/**
 * Сравнение провайдеров размена (issue #53) — одна из двух заявленных ценностей продукта.
 *
 * Правило, вокруг которого всё построено: выигрыш считается **по факту сделок**, а не по обещанию
 * курса. «Меняльня даёт лучше» имеет смысл только если человек через неё реально менял, и только
 * на тех объёмах, которые он реально менял.
 */

const deal = (over: Partial<ProviderDeal>): ProviderDeal => ({
  provider: 'Меняльня',
  pair: 'RUB→EUR',
  fromMinor: 6_000_000n,
  spreadPct: '1.00',
  lostMinor: 6_000n,
  occurredOn: '2026-07-01',
  ...over,
});

describe('compareProviders', () => {
  it('считает средний спред и потери по каждому провайдеру', () => {
    const result = compareProviders([
      deal({ provider: 'Меняльня', spreadPct: '0.90', lostMinor: 5_400n }),
      deal({ provider: 'Меняльня', spreadPct: '1.10', lostMinor: 6_600n }),
      deal({ provider: 'Банк', spreadPct: '2.60', lostMinor: 15_600n }),
    ]);

    const menyalnya = result.providers.find((p) => p.provider === 'Меняльня')!;
    expect(menyalnya.deals).toBe(2);
    expect(menyalnya.avgSpreadPct).toBeCloseTo(1.0, 6);
    expect(menyalnya.lostMinorByCurrency.get('EUR')).toBe(12_000n);
  });

  it('лучший провайдер — с наименьшим средним спредом, а не с наибольшим числом сделок', () => {
    const result = compareProviders([
      deal({ provider: 'Банк', spreadPct: '2.60', lostMinor: 15_600n }),
      deal({ provider: 'Банк', spreadPct: '2.40', lostMinor: 14_400n }),
      deal({ provider: 'Банк', spreadPct: '2.50', lostMinor: 15_000n }),
      deal({ provider: 'Wise', spreadPct: '1.20', lostMinor: 7_200n }),
    ]);
    expect(result.best?.provider).toBe('Wise');
    expect(result.worst?.provider).toBe('Банк');
  });

  it('выигрыш считается по факту: сколько сэкономил бы тот же объём у лучшего провайдера', () => {
    // 6 000 000 RUB у банка со спредом 2,5% против 1,0% у меняльни → разница 1,5% от объёма.
    const result = compareProviders([
      deal({ provider: 'Меняльня', spreadPct: '1.00', fromMinor: 6_000_000n }),
      deal({ provider: 'Банк', spreadPct: '2.50', fromMinor: 6_000_000n }),
    ]);
    expect(result.savingMinor).toBe(90_000n);
    expect(result.savingCurrency).toBe('RUB');
  });

  it('совет молчит, пока провайдер один: сравнивать не с чем', () => {
    const result = compareProviders([deal({}), deal({ occurredOn: '2026-06-01' })]);
    expect(result.providers).toHaveLength(1);
    // Сравнивать не с чем: один провайдер — это не выбор.
    expect(result.best).toBeNull();
    expect(result.confident).toBe(false);
    expect(result.savingMinor).toBe(0n);
  });

  it('по одной сделке у каждого сравнение есть, но уверенности в совете нет', () => {
    /*
     * Факт и совет — разные вещи. Один поход к меняле и один в банк уже показывают разницу цены,
     * и скрывать её незачем. Но «переходи на меняльню» на основании одного случая — это гадание:
     * поэтому сравнение отдаётся, а признак уверенности выключен, и интерфейс совет не покажет.
     */
    const result = compareProviders([
      deal({ provider: 'Меняльня', spreadPct: '0.90' }),
      deal({ provider: 'Банк', spreadPct: '2.60' }),
    ]);
    expect(result.providers).toHaveLength(2);
    expect(result.best?.provider).toBe('Меняльня');
    expect(result.confident).toBe(false);
  });

  it('уверенность появляется, когда у лучшего провайдера есть повторяемость', () => {
    const result = compareProviders([
      deal({ provider: 'Меняльня', spreadPct: '0.90' }),
      deal({ provider: 'Меняльня', spreadPct: '1.10' }),
      deal({ provider: 'Банк', spreadPct: '2.60' }),
    ]);
    expect(result.best?.provider).toBe('Меняльня');
    expect(result.confident).toBe(true);
  });

  it('операции без известного спреда в сравнение не идут', () => {
    const result = compareProviders([
      deal({ provider: 'Меняльня', spreadPct: null, lostMinor: null }),
      deal({ provider: 'Меняльня', spreadPct: '1.00' }),
      deal({ provider: 'Меняльня', spreadPct: '1.20' }),
    ]);
    const menyalnya = result.providers[0]!;
    expect(menyalnya.deals).toBe(2);
    expect(menyalnya.avgSpreadPct).toBeCloseTo(1.1, 6);
  });

  it('сделки без провайдера собираются в «без метки» и не мешают сравнению', () => {
    const result = compareProviders([
      deal({ provider: null, spreadPct: '3.00' }),
      deal({ provider: 'Wise', spreadPct: '1.00' }),
      deal({ provider: 'Wise', spreadPct: '1.40' }),
    ]);
    expect(result.providers.map((p) => p.provider)).toContain(null);
    // Безымянные не могут быть «лучшим выбором»: перейти на «без метки» нельзя.
    expect(result.best?.provider).toBe('Wise');
  });

  it('выигрыш не считается между разными валютами: складывать их нельзя', () => {
    const result = compareProviders([
      deal({ provider: 'Меняльня', pair: 'RUB→EUR', spreadPct: '1.00', fromMinor: 6_000_000n }),
      deal({ provider: 'Меняльня', pair: 'RUB→EUR', spreadPct: '1.00', fromMinor: 6_000_000n }),
      deal({ provider: 'Банк', pair: 'USD→EUR', spreadPct: '3.00', fromMinor: 500_000n }),
      deal({ provider: 'Банк', pair: 'USD→EUR', spreadPct: '3.00', fromMinor: 500_000n }),
    ]);
    // Объёмы в разных валютах: экономию в одной цифре не выразить, поэтому её нет.
    expect(result.savingMinor).toBe(0n);
    expect(result.savingCurrency).toBeNull();
  });
});
