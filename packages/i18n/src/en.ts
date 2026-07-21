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
  'plan.today.periodLabel': 'THIS PERIOD',
  'plan.today.until': 'until {date} · {days} days left',
  'plan.today.expected': 'Expected this period',

  // План периода — автосборка каскадом (Спринт 2)
  'plan.groups.debt': 'Debts',
  'plan.groups.bucket': 'To exchange',
  'plan.groups.envelope': 'Envelopes',
  'plan.groups.category': 'Categories',
  'plan.groups.goal': 'Goals',
  'plan.summary.income': 'Income this period',
  'plan.summary.committed': 'Committed',
  'plan.summary.free': 'Free at period end',
  'plan.summary.perDay': 'To live on, per day',
  'plan.summary.toExchange': 'To exchange',
  'plan.compressed.note': "Not enough for everything — trimmed {amount} {ccy}. Goals give first, then envelopes, then categories; debts and baskets stay whole.",
  'plan.row.trimmed': 'trimmed {amount}',
  'plan.categories.hint': 'Category budgets arrive next — for now the daily figure is what is left after commitments.',
  'plan.unresolved.title': 'Rate unavailable',
  'plan.unresolved.hint': 'These lines stay out of the split until rates refresh.',
  'plan.unresolved.affectsHero': 'Some obligations have no rate yet — the daily figure leaves them out and may read too high.',
  'plan.empty.noPlan': 'Nothing to route yet — set income and add obligations.',
  'plan.today.viewFull': 'Full plan →',

  // Auth
  'auth.title': 'multa',
  'auth.subtitle': 'Budget across borders.',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.name': 'Name',
  'auth.signIn': 'Sign in',
  'auth.signUp': 'Create account',
  'auth.toSignUp': 'No account? Create one',
  'auth.toSignIn': 'Have an account? Sign in',

  // Общее (доп.)
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.add': 'Add',
  'common.delete': 'Delete',
  'common.name': 'Name',
  'common.amount': 'Amount',
  'common.currency': 'Currency',
  'common.empty': 'Nothing yet',
  'common.saved': 'Saved',
  'common.error': 'Something went wrong',
  'common.retry': 'Retry',

  // Навигация
  'nav.today': 'Today',
  'nav.plan': 'Plan',
  'nav.exchange': 'Exchange',
  'nav.obligations': 'Obligations',
  'nav.settings': 'Settings',

  // Обязательства
  'obl.title': 'Obligations',
  'obl.debts': 'Debts',
  'obl.envelopes': 'Envelopes',
  'obl.goals': 'Goals',
  'obl.buckets': 'Currency baskets',
  'obl.payment': 'Payment / period',
  'obl.target': 'Target',
  'obl.rule.fixed': 'fixed',
  'obl.rule.percent': 'percent',
  'obl.from': 'From',
  'obl.to': 'To',

  // Настройки
  'settings.title': 'Settings',
  'settings.currency': 'Base currency',
  'settings.income': 'Expected income per period',
  'settings.anchors': 'Payout dates',

  // Заглушки
  'placeholder.soon': 'Coming — Sprint 2',
} as const;

export type TranslationKey = keyof typeof en;
