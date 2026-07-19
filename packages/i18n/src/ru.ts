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
};
