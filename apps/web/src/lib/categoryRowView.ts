/**
 * Что показывать в строке категории, а что — прочерком (issue #139).
 *
 * Панель расходов рисует все категории воркспейса, включая те, где бюджет ещё не задан. Так и надо:
 * поле ввода бюджета живёт в самой строке, и спрятав строку, мы закрыли бы единственную дорогу к
 * тому, чтобы бюджет появился (этот замкнутый круг уже расшивали дважды — #120 для долгов и
 * категории в мастер-таблице). Но показывать «не задано» как `0 / 0 | 0 RUB` — значит утверждать
 * ноль там, где ничего не утверждали: у владельца так восемь строк из девяти превращались в экран
 * нулей.
 *
 * Решение то же, что в мастер-таблице, где `state: 'none'` рисуется прочерком: ноль и «строки в этом
 * периоде нет» — разные вещи и выглядеть должны по-разному.
 */

export interface CategoryAmountsInput {
  /** Сколько роздано каскадом — ноль и при отсутствии бюджета, и при полном срезе. */
  readonly allocatedMinor: string;
  readonly spentMinor: string;
  readonly remainingMinor: string;
  /**
   * Сколько срезал каскад. Есть только у строк, которым бюджет задавали: именно он отличает
   * настоящий ноль («урезали до нуля при нехватке») от «бюджета никогда не было». Без этого
   * различения прочерк скрыл бы факт среза — то есть спрятал бы решение продукта о деньгах.
   */
  readonly shortfallMinor?: string;
}

export interface CategoryAmountsView {
  readonly hasBudget: boolean;
  readonly showFact: boolean;
  readonly showRemaining: boolean;
}

export function categoryAmounts(input: CategoryAmountsInput): CategoryAmountsView {
  const allocated = BigInt(input.allocatedMinor);
  const spent = BigInt(input.spentMinor);
  const trimmed = BigInt(input.shortfallMinor ?? '0') > 0n;

  const hasBudget = allocated > 0n || trimmed;
  return {
    hasBudget,
    // Трата без бюджета всё равно показывается: деньги ушли, и молчать об этом нельзя.
    showFact: hasBudget || spent > 0n,
    showRemaining: hasBudget,
  };
}
