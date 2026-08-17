/**
 * Сравнение провайдеров размена (issue #53).
 *
 * Планировщик размена — одна из двух заявленных ценностей продукта, и её нельзя подменять
 * обещаниями курса с сайтов. Здесь считается только факт: сколько человек реально отдал каждому
 * провайдеру и во что это обошлось.
 *
 * Три правила, из-за которых совет молчит чаще, чем говорит:
 * 1. Один провайдер — сравнивать не с чем.
 * 2. Одна сделка у провайдера — это случай, а не привычка; на её основе не советуем переходить.
 * 3. Объёмы в разных валютах не складываются, поэтому и экономию одной цифрой не выражаем.
 */

/** Сделка глазами сравнения: провайдер, пара, объём и спред. */
export interface ProviderDeal {
  /** Где меняли. null — метки нет: такие сделки видны, но «перейти на без метки» нельзя. */
  readonly provider: string | null;
  /** Пара вида «RUB→EUR»: объёмы разных пар не складываются. */
  readonly pair: string;
  /** Отданная сумма в minor units валюты, которую отдавали. */
  readonly fromMinor: bigint;
  /** Спред к официальному курсу, проценты строкой. null — курса на дату не было. */
  readonly spreadPct: string | null;
  /** Потеря в валюте получения; отрицательная означает выигрыш. */
  readonly lostMinor?: bigint | null;
  readonly occurredOn: string;
}

export interface ProviderStats {
  provider: string | null;
  deals: number;
  avgSpreadPct: number;
  /** Сколько отдано, по валютам отдачи. */
  volumeMinorByCurrency: Map<string, bigint>;
  /** Сколько потеряно, по валютам получения. */
  lostMinorByCurrency: Map<string, bigint>;
}

export interface ProviderComparison {
  providers: ProviderStats[];
  /** Лучший по среднему спреду среди помеченных. null — сравнивать не с чем (провайдер один). */
  best: ProviderStats | null;
  worst: ProviderStats | null;
  /**
   * Есть ли у лучшего провайдера повторяемость (больше одной сделки). Факт и совет — разные вещи:
   * разницу цены показываем всегда, а «переходи туда» — только когда это не единичный случай.
   */
  confident: boolean;
  /**
   * Сколько сэкономил бы тот же объём у лучшего провайдера. Считается только когда все сделки
   * отдавались в одной валюте: иначе цифра была бы суммой рублей с долларами.
   */
  savingMinor: bigint;
  savingCurrency: string | null;
}

const MIN_DEALS_FOR_ADVICE = 2;

function currencyFrom(pair: string): string {
  return pair.split('→')[0]?.trim() ?? '';
}

function currencyTo(pair: string): string {
  return pair.split('→')[1]?.trim() ?? '';
}

function add(map: Map<string, bigint>, key: string, value: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + value);
}

export function compareProviders(deals: readonly ProviderDeal[]): ProviderComparison {
  // Сделки без известного спреда в сравнение не идут: у них нечего сравнивать.
  const known = deals.filter((d) => d.spreadPct !== null);

  const byProvider = new Map<string | null, ProviderDeal[]>();
  for (const deal of known) {
    const list = byProvider.get(deal.provider) ?? [];
    list.push(deal);
    byProvider.set(deal.provider, list);
  }

  const providers: ProviderStats[] = [...byProvider.entries()].map(([provider, list]) => {
    const volume = new Map<string, bigint>();
    const lost = new Map<string, bigint>();
    for (const deal of list) {
      add(volume, currencyFrom(deal.pair), deal.fromMinor);
      if (deal.lostMinor !== null && deal.lostMinor !== undefined) {
        add(lost, currencyTo(deal.pair), deal.lostMinor);
      }
    }
    const avg = list.reduce((sum, d) => sum + Number(d.spreadPct), 0) / list.length;
    return {
      provider,
      deals: list.length,
      avgSpreadPct: avg,
      volumeMinorByCurrency: volume,
      lostMinorByCurrency: lost,
    };
  });

  providers.sort((a, b) => a.avgSpreadPct - b.avgSpreadPct);

  /*
   * Кандидаты — только помеченные: «перейти на без метки» не совет. Сравнение имеет смысл, когда
   * групп минимум две (вторая может быть и безымянной — важно, что выбор существовал).
   */
  const named = providers.filter((p) => p.provider !== null);
  const comparable = providers.length >= 2 && named.length >= 1;
  const best = comparable ? (named[0] ?? null) : null;
  const worst = comparable ? (named.at(-1) ?? null) : null;
  /*
   * Уверенность требует достаточной выборки У ОБОИХ — и у лучшего, и у того, от кого советуем уйти
   * (найдено осмотром живых данных 17.08.2026).
   *
   * Раньше проверялся только лучший, и совет мог держаться на ОДНОЙ сделке худшего: в демо на ней
   * стояло 87 000 из 107 000 обещанной экономии — четыре пятых из единственной операции. Одна
   * сделка не говорит, что провайдер плох систематически: бывает срочный размен, другой порог
   * суммы, разовая невезуха. «Уходи оттуда» на таком основании — обещание знания, которого нет.
   *
   * Числа при этом не скрываются: разница провайдеров видна и без уверенности, скрывается только
   * сам совет (см. Statistics.tsx — фразу держит именно этот флаг).
   */
  const confident =
    best !== null &&
    best.deals >= MIN_DEALS_FOR_ADVICE &&
    (worst === null || worst === best || worst.deals >= MIN_DEALS_FOR_ADVICE);

  let savingMinor = 0n;
  let savingCurrency: string | null = null;
  if (best) {
    const currencies = new Set(known.map((d) => currencyFrom(d.pair)));
    if (currencies.size === 1) {
      savingCurrency = [...currencies][0] ?? null;
      // Экономия = объём × (спред провайдера − спред лучшего). Считаем в базисных пунктах, чтобы
      // не тащить float в деньги: проценты приходят строкой с двумя знаками.
      for (const stats of providers) {
        if (stats.provider === best.provider) continue;
        const gapBp = Math.round((stats.avgSpreadPct - best.avgSpreadPct) * 100);
        if (gapBp <= 0) continue;
        const volume = stats.volumeMinorByCurrency.get(savingCurrency ?? '') ?? 0n;
        savingMinor += (volume * BigInt(gapBp)) / 10_000n;
      }
    }
  }

  return { providers, best, worst, confident, savingMinor, savingCurrency };
}
