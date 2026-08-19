/**
 * Смысл `ruleValue` конверта зависит от вида правила (issue #127): у «фикс» это деньги в minor
 * units, у «процент» — число процента, не деньги. Одно поле API несёт две разные величины, и
 * решение «как её показывать/редактировать» должно быть в одном месте, а не рассыпано по JSX —
 * ровно там оно однажды разошлось между списком и формой правки.
 */

export type EnvelopeRuleKind = 'fixed' | 'percent';

/** Вид поля правки: `minor` конвертирует major↔minor, `plain` — число как есть. */
export function envelopeEditFieldKind(ruleKind: EnvelopeRuleKind): 'minor' | 'plain' {
  return ruleKind === 'fixed' ? 'minor' : 'plain';
}

/**
 * Значение для поля правки: то, что реально пришло из API, приведённое к тому, что поле готово
 * принять.
 *
 * `envelopes.rule_value` — колонка `numeric(12, scale: 4)`, и API отдаёт её строкой как есть, с
 * дробной частью («5000.0000»). Для «фикс» это minor units, а `BigInt()` (им конвертирует поле типа
 * `minor`) десятичные строки не принимает вовсе — не округляя, а бросая исключение. Список эту же
 * строку уже обрезает до целого; форма правки обязана делать то же самое, а не изобретать вторую
 * трактовку одного числа.
 *
 * Для «процент» дробная часть законная (12,5%) — обрезать её значило бы исказить ввод.
 */
export function envelopeEditFieldValue(ruleKind: EnvelopeRuleKind, ruleValue: string): string {
  return ruleKind === 'fixed' ? (ruleValue.split('.')[0] ?? '0') : ruleValue;
}
