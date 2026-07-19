/**
 * Английский словарь — источник правды по набору ключей.
 * Ключи: area.screen.element. Плейсхолдеры интерполяции — {name}.
 * Тон — штурман, не учитель (06-design-system §Тон). Игра со «штрафом» — только на лендинге.
 */
export const en = {
  // Бренд / общее
  'brand.name': 'multa',
  'common.next': 'Next',
  'common.back': 'back',
  'common.skip': 'skip',
  'common.done': 'done',
  'common.cancel': 'Cancel',

  // Онбординг — шаг 1: базовая валюта
  'onboarding.currency.title': 'Where does your income arrive?',
  'onboarding.currency.subtitle': 'Your base currency — everything else converts to it.',
  'onboarding.currency.search': 'Search currency…',

  // Онбординг — шаг 2: якоря выплат
  'onboarding.payday.title': 'When does the money come?',
  'onboarding.payday.subtitle': 'We plan by your real payout dates, not the calendar month.',
  'onboarding.payday.preset.twiceMonthly': '10th and 25th',
  'onboarding.payday.preset.monthly': 'Once a month',
  'onboarding.payday.preset.biweekly': 'Every two weeks',
  'onboarding.payday.preset.custom': 'Custom',
  'onboarding.payday.expectedAmount': 'Roughly how much each payout?',

  // Дашборд — пустой план периода
  'plan.empty.title': 'Your plan is a blank page',
  'plan.empty.subtitle': 'Route set once you add income and where it goes.',
  'plan.hero.canSpend': 'YOU CAN SPEND',
  'plan.hero.perDay': '/day',
} as const;

export type TranslationKey = keyof typeof en;
