/**
 * Потребность в размене — «К размену» (issue #152).
 *
 * Раньше показатель складывался только из аллокаций валютных корзин, потому что корзина и была
 * способом сказать «с этой выплаты 60 000 ₽ уходят в евро». 06.08.2026 корзины убрали из
 * интерфейса как дублирующую сущность — и показатель остался без источника: у человека счёт за
 * квартиру в евро, а в подвале плана нули.
 *
 * Правило теперь такое: потребность выводится из самих валютных строк плана. Платёж в EUR
 * означает, что рубли под него придётся поменять, независимо от того, отложены ли на него деньги
 * отдельной строкой. Это срез по валютам, а НЕ добавка к раздаче: суммы здесь уже роздал каскад,
 * и в свободный остаток эти деньги не считаются второй раз.
 *
 * Суммы приходят в базовой валюте (сколько base-денег надо поменять), а `currency` — валюта, в
 * которой платить, то есть во что менять.
 */

export interface ExchangeNeedLine {
  /** Валюта платежа: во что менять. */
  readonly currency: string;
  /** Сколько базовой валюты (minor) уходит на эту строку. */
  readonly minor: bigint;
  /**
   * Сколько валюты нужно по этой строке — сумма, которую человек сам и задал («аренда 650 EUR»).
   *
   * Берётся из строки, а НЕ считается обратно из базовой по курсу (замечание владельца 22.08.2026:
   * «у тебя заложена строка в евро и в ней есть сумма, в чём проблема её взять?»). Обратный
   * пересчёт давал бы 649,98 там, где в договоре стоит 650, — и цифра, с которой идут в обменник,
   * выглядела бы посчитанной, а не своей.
   */
  readonly amountMinor: bigint;
}

export interface ExchangeNeed {
  /** Всего к размену, base minor. */
  readonly totalMinor: bigint;
  /**
   * Разбивка по валютам получения, по коду валюты. Валюты без потребности сюда не попадают.
   * `minor` — сколько базовой уйдёт, `amountMinor` — сколько валюты нужно купить.
   */
  readonly byCurrency: readonly {
    readonly currency: string;
    readonly minor: bigint;
    readonly amountMinor: bigint;
  }[];
}

/**
 * Складывает валютные строки в потребность размена.
 *
 * Строки в базовой валюте пропускаются: менять под них нечего. Нулевые валютные строки не создают
 * валюту в разбивке — «EUR: 0» читалось бы как «размен нужен, но нулевой», хотя платежа в этом
 * периоде просто нет. Отрицательные отбрасываются: это испорченные данные, а не отрицательный
 * размен, и вычитать их из потребности значило бы поменять меньше, чем нужно на платежи.
 */
export function exchangeNeed(
  lines: readonly ExchangeNeedLine[],
  baseCurrency: string,
): ExchangeNeed {
  const byCurrency = new Map<string, { minor: bigint; amountMinor: bigint }>();
  for (const line of lines) {
    if (line.currency === baseCurrency || line.minor <= 0n) continue;
    const acc = byCurrency.get(line.currency) ?? { minor: 0n, amountMinor: 0n };
    byCurrency.set(line.currency, {
      minor: acc.minor + line.minor,
      amountMinor: acc.amountMinor + line.amountMinor,
    });
  }
  return {
    totalMinor: [...byCurrency.values()].reduce((acc, v) => acc + v.minor, 0n),
    byCurrency: [...byCurrency.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, v]) => ({ currency, minor: v.minor, amountMinor: v.amountMinor })),
  };
}
