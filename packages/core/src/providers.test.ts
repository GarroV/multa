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

  it('уверенность требует повторяемости у обеих сторон сравнения', () => {
    /*
     * Ожидание изменено осознанно (17.08.2026), и вот почему. Фраза продукта звучит так: «у {X} тот
     * же объём стоил бы дешевле на {сумма}» — то есть утверждение опирается на объёмы и спреды
     * ОСТАЛЬНЫХ провайдеров, а не только лучшего. Когда у худшего одна сделка, вся «экономия»
     * посчитана по одной операции, которая могла быть срочной или разовой невезухой.
     *
     * Прежняя версия требовала повторяемости только у лучшего и на таких данных ставила
     * «уверенно». У продукта при этом уже есть честная замена — «разница видна, но сделок пока
     * мало, это может быть случайность», — и именно она тут уместна.
     */
    const thin = compareProviders([
      deal({ provider: 'Меняльня', spreadPct: '0.90' }),
      deal({ provider: 'Меняльня', spreadPct: '1.10' }),
      deal({ provider: 'Банк', spreadPct: '2.60' }),
    ]);
    expect(thin.best?.provider).toBe('Меняльня');
    expect(thin.confident, 'у Банка одна сделка — уверенности нет').toBe(false);

    const enough = compareProviders([
      deal({ provider: 'Меняльня', spreadPct: '0.90' }),
      deal({ provider: 'Меняльня', spreadPct: '1.10' }),
      deal({ provider: 'Банк', spreadPct: '2.60' }),
      deal({ provider: 'Банк', spreadPct: '2.40' }),
    ]);
    expect(enough.confident).toBe(true);
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

/*
 * Уверенность в совете должна опираться и на того, ОТ КОГО советуем уйти.
 *
 * Найдено осмотром живых данных 17.08.2026: у худшего провайдера была одна сделка, и на ней держалось
 * 87 000 из 107 000 обещанной экономии — четыре пятых совета из единственной операции. При этом
 * флаг «уверенно» стоял, потому что проверял только лучшего.
 *
 * Одна сделка не говорит, что банк плохой систематически: это мог быть срочный размен, другой
 * порог суммы, разовая невезуха. Совет «уходи оттуда» на таком основании — превышение того, что мы
 * знаем, а продукт обещает быть штурманом, а не гадателем.
 */
describe('уверенность совета по размену', () => {
  it('одна сделка у худшего — совет не уверенный', () => {
    const result = compareProviders([
      deal({ provider: 'Wise', spreadPct: '1.00', occurredOn: '2026-07-01' }),
      deal({ provider: 'Wise', spreadPct: '1.10', occurredOn: '2026-07-15' }),
      // Единственная сделка, и самая дорогая: именно она задаёт весь размер «экономии».
      deal({ provider: 'Банк', spreadPct: '3.00', occurredOn: '2026-07-20' }),
    ]);
    expect(result.best?.provider).toBe('Wise');
    expect(result.worst?.provider).toBe('Банк');
    expect(result.confident, 'нельзя быть уверенным по одной сделке худшего').toBe(false);
  });

  it('по две сделки у обоих — совет уверенный', () => {
    const result = compareProviders([
      deal({ provider: 'Wise', spreadPct: '1.00', occurredOn: '2026-07-01' }),
      deal({ provider: 'Wise', spreadPct: '1.10', occurredOn: '2026-07-15' }),
      deal({ provider: 'Банк', spreadPct: '3.00', occurredOn: '2026-07-20' }),
      deal({ provider: 'Банк', spreadPct: '2.80', occurredOn: '2026-07-25' }),
    ]);
    expect(result.confident).toBe(true);
  });

  it('сама разница остаётся видна и без уверенности', () => {
    // Не уверены в совете — не значит скрыли числа: человек вправе видеть, что размены разные.
    const result = compareProviders([
      deal({ provider: 'Wise', spreadPct: '1.00' }),
      deal({ provider: 'Банк', spreadPct: '3.00' }),
    ]);
    expect(result.confident).toBe(false);
    expect(result.providers.length).toBe(2);
    expect(result.savingMinor > 0n).toBe(true);
  });
});
