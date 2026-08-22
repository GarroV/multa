/**
 * Потребность в размене (issue #152).
 *
 * До этого «К размену» считалось только из валютных корзин, а раздел корзин 06.08.2026 убрали из
 * интерфейса — показатель стал структурно нулевым при живых платежах в евро. Теперь потребность
 * выводится из самих валютных строк, и эти тесты держат именно это правило.
 */

import { describe, expect, it } from 'vitest';
import { exchangeNeed } from './exchangeNeed.ts';

describe('exchangeNeed — сколько нужно поменять', () => {
  it('валютные строки складываются по валюте платежа, базовые не участвуют', () => {
    const need = exchangeNeed(
      [
        { currency: 'EUR', minor: 53_273_06n },
        { currency: 'EUR', minor: 1_937_20n },
        { currency: 'RSD', minor: 40_000_00n },
        { currency: 'RUB', minor: 30_000_00n },
      ],
      'RUB',
    );
    expect(need.totalMinor).toBe(53_273_06n + 1_937_20n + 40_000_00n);
    expect(need.byCurrency).toEqual([
      { currency: 'EUR', minor: 55_210_26n },
      { currency: 'RSD', minor: 40_000_00n },
    ]);
  });

  it('нет валютных строк — ноль и пустая разбивка (менять действительно нечего)', () => {
    const need = exchangeNeed([{ currency: 'RUB', minor: 100_00n }], 'RUB');
    expect(need.totalMinor).toBe(0n);
    expect(need.byCurrency).toEqual([]);
  });

  it('нулевая валютная строка не создаёт валюту в разбивке', () => {
    // Платёж в этом периоде не наступает — «EUR: 0» читалось бы как «размен нужен, но нулевой».
    const need = exchangeNeed(
      [
        { currency: 'EUR', minor: 0n },
        { currency: 'RSD', minor: 500_00n },
      ],
      'RUB',
    );
    expect(need.byCurrency).toEqual([{ currency: 'RSD', minor: 500_00n }]);
  });

  it('разбивка отсортирована по коду валюты: порядок строк плана не должен её трясти', () => {
    const need = exchangeNeed(
      [
        { currency: 'RSD', minor: 100n },
        { currency: 'EUR', minor: 100n },
        { currency: 'AMD', minor: 100n },
      ],
      'RUB',
    );
    expect(need.byCurrency.map((x) => x.currency)).toEqual(['AMD', 'EUR', 'RSD']);
  });

  it('отрицательная строка не уменьшает потребность: это испорченные данные, а не скидка', () => {
    const need = exchangeNeed(
      [
        { currency: 'EUR', minor: 1_000_00n },
        { currency: 'EUR', minor: -400_00n },
      ],
      'RUB',
    );
    expect(need.totalMinor).toBe(1_000_00n);
  });
});
