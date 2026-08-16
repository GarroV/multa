import { describe, expect, it } from 'vitest';
import { debtPaymentForPeriod } from './debtPayment.ts';

/**
 * Платёж по долгу, разный для разных выплат (запрос владельца 16.08.2026: «плачу я и с аванса и с
 * зарплаты… разные суммы»).
 *
 * До этого у долга было одно число на период, и «5 000 с аванса, 15 000 с зарплаты» выразить было
 * нечем: ступени суммы (`amountSteps`) меняют её с даты и навсегда, а не чередуют.
 *
 * Сумма привязывается к ИСТОЧНИКУ дохода, а не к порядковому номеру периода: рано или поздно ритм
 * меняется, появляется третий источник или выплата съезжает — и всё, что считало «через одну»,
 * начинает врать молча.
 */
const ADVANCE = 'src-advance';
const SALARY = 'src-salary';

describe('платёж по долгу за период', () => {
  it('без разбивки берётся общая сумма, как раньше', () => {
    const payment = debtPaymentForPeriod(
      { paymentMinor: 1000000n, steps: [], bySource: [] },
      [ADVANCE],
      '2026-08-10',
    );
    expect(payment).toBe(1000000n);
  });

  it('с разбивкой берётся сумма того источника, что платит в этом периоде', () => {
    const debt = {
      paymentMinor: 1000000n,
      steps: [],
      bySource: [
        { sourceId: ADVANCE, amountMinor: 500000n },
        { sourceId: SALARY, amountMinor: 1500000n },
      ],
    };
    expect(debtPaymentForPeriod(debt, [ADVANCE], '2026-08-10')).toBe(500000n);
    expect(debtPaymentForPeriod(debt, [SALARY], '2026-08-25')).toBe(1500000n);
  });

  it('два источника в одном периоде складываются', () => {
    /*
     * При месячном ритме обе выплаты попадают в один период. Взять только первую значило бы молча
     * недоплатить половину — и человек увидел бы это лишь когда банк списал больше плана.
     */
    const payment = debtPaymentForPeriod(
      {
        paymentMinor: 0n,
        steps: [],
        bySource: [
          { sourceId: ADVANCE, amountMinor: 500000n },
          { sourceId: SALARY, amountMinor: 1500000n },
        ],
      },
      [ADVANCE, SALARY],
      '2026-08-10',
    );
    expect(payment).toBe(2000000n);
  });

  it('источник без своей суммы ничего не добавляет', () => {
    // Появился новый источник дохода — долг с него не платится, пока это не задано явно.
    const payment = debtPaymentForPeriod(
      { paymentMinor: 999n, steps: [], bySource: [{ sourceId: SALARY, amountMinor: 1500000n }] },
      ['src-freelance'],
      '2026-08-10',
    );
    expect(payment).toBe(0n);
  });

  it('период без дохода не платит ничего', () => {
    const payment = debtPaymentForPeriod(
      { paymentMinor: 999n, steps: [], bySource: [{ sourceId: SALARY, amountMinor: 1500000n }] },
      [],
      '2026-08-10',
    );
    expect(payment).toBe(0n);
  });

  it('ступени суммы продолжают работать, когда разбивки нет', () => {
    const payment = debtPaymentForPeriod(
      {
        paymentMinor: 1000000n,
        steps: [{ from: '2026-09-01', amountMinor: 2000000n }],
        bySource: [],
      },
      [SALARY],
      '2026-09-10',
    );
    expect(payment).toBe(2000000n);
  });

  it('разбивка сильнее ступеней: заданы обе — побеждает разбивка', () => {
    /*
     * Ступени и разбивка отвечают на разные вопросы («сколько с какого-то момента» против «сколько
     * с какой выплаты»), и складывать их значило бы платить дважды. Приоритет отдан разбивке: она
     * задана явно и подробнее.
     */
    const payment = debtPaymentForPeriod(
      {
        paymentMinor: 1000000n,
        steps: [{ from: '2026-09-01', amountMinor: 2000000n }],
        bySource: [{ sourceId: SALARY, amountMinor: 700000n }],
      },
      [SALARY],
      '2026-09-10',
    );
    expect(payment).toBe(700000n);
  });
});
