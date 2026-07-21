import type { TranslationKey } from './en.ts';

/** Русский словарь. Ключи обязаны совпадать с en (проверяется типом Record<TranslationKey, string>). */
export const ru: Record<TranslationKey, string> = {
  // Бренд / общее
  'brand.name': 'multa',
  'common.next': 'Дальше',
  'common.back': 'назад',
  'common.skip': 'пропустить',
  'common.done': 'готово',
  'common.cancel': 'Отмена',

  // Онбординг — шаг 1: базовая валюта
  'onboarding.currency.title': 'Где приходят деньги?',
  'onboarding.currency.subtitle': 'Базовая валюта — к ней приводится всё остальное.',
  'onboarding.currency.search': 'Найти валюту…',

  // Онбординг — шаг 2: якоря выплат
  'onboarding.payday.title': 'Когда приходят деньги?',
  'onboarding.payday.subtitle': 'Планируем по датам выплат, а не по календарному месяцу.',
  'onboarding.payday.preset.twiceMonthly': '10-е и 25-е',
  'onboarding.payday.preset.monthly': 'Раз в месяц',
  'onboarding.payday.preset.biweekly': 'Каждые две недели',
  'onboarding.payday.preset.custom': 'Свои даты',
  'onboarding.payday.expectedAmount': 'Примерно сколько каждая выплата?',

  // Дашборд — пустой план периода
  'plan.empty.title': 'План пока чистый лист',
  'plan.empty.subtitle': 'Курс проложим, как добавишь доход и куда он идёт.',
  'plan.hero.canSpend': 'МОЖНО ТРАТИТЬ',
  'plan.hero.perDay': '/день',
  'plan.today.periodLabel': 'ПЕРИОД',
  'plan.today.until': 'до {date} · осталось дней: {days}',
  'plan.today.expected': 'Ожидаемый доход периода',

  // План периода — автосборка каскадом (Спринт 2)
  'plan.groups.debt': 'Долги',
  'plan.groups.bucket': 'К размену',
  'plan.groups.envelope': 'Конверты',
  'plan.groups.category': 'Категории',
  'plan.groups.goal': 'Цели',
  'plan.summary.income': 'Доход периода',
  'plan.summary.committed': 'Расписано',
  'plan.summary.free': 'Свободно к концу периода',
  'plan.summary.perDay': 'На жизнь, в день',
  'plan.summary.toExchange': 'К размену',
  'plan.compressed.note': 'На всё сразу не хватает — срезано {amount} {ccy}. Первыми уступают цели, потом конверты, потом категории; долги и корзины остаются целыми.',
  'plan.row.trimmed': 'срезано {amount}',
  'plan.categories.hint': 'Бюджеты категорий добавим следующим шагом — пока цифра дня это то, что остаётся после обязательств.',
  'plan.unresolved.title': 'Курс недоступен',
  'plan.unresolved.hint': 'Пока курс не подтянется, эти строки вне раскладки.',
  'plan.unresolved.affectsHero': 'У части обязательств нет курса — цифра дня их не учитывает и может быть завышена.',
  'plan.empty.noPlan': 'Пока раскладывать нечего — задай доход и добавь обязательства.',
  'plan.today.viewFull': 'Весь план →',

  // Auth
  'auth.title': 'multa',
  'auth.subtitle': 'Бюджет, который переезжает с тобой.',
  'auth.email': 'Почта',
  'auth.password': 'Пароль',
  'auth.name': 'Имя',
  'auth.signIn': 'Войти',
  'auth.signUp': 'Создать аккаунт',
  'auth.toSignUp': 'Нет аккаунта? Создать',
  'auth.toSignIn': 'Уже есть аккаунт? Войти',

  // Общее (доп.)
  'common.loading': 'Загрузка…',
  'common.save': 'Сохранить',
  'common.add': 'Добавить',
  'common.delete': 'Удалить',
  'common.name': 'Название',
  'common.amount': 'Сумма',
  'common.currency': 'Валюта',
  'common.empty': 'Пока пусто',
  'common.saved': 'Сохранено',
  'common.error': 'Что-то пошло не так',
  'common.retry': 'Повторить',

  // Навигация
  'nav.today': 'Сегодня',
  'nav.plan': 'План',
  'nav.exchange': 'Размен',
  'nav.obligations': 'Обязательства',
  'nav.settings': 'Настройки',

  // Обязательства
  'obl.title': 'Обязательства',
  'obl.debts': 'Долги',
  'obl.envelopes': 'Конверты',
  'obl.goals': 'Цели',
  'obl.buckets': 'Валютные корзины',
  'obl.payment': 'Платёж / период',
  'obl.target': 'Цель',
  'obl.rule.fixed': 'фикс',
  'obl.rule.percent': 'процент',
  'obl.from': 'Из',
  'obl.to': 'В',

  // Настройки
  'settings.title': 'Настройки',
  'settings.currency': 'Базовая валюта',
  'settings.income': 'Ожидаемый доход за период',
  'settings.anchors': 'Даты выплат',

  // Заглушки
  'placeholder.soon': 'Скоро — Спринт 2',
};
