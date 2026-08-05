import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { AppShell } from './AppShell.tsx';
import { hasChosenLocale, useI18n } from './lib/i18n.tsx';
import { useMe } from './lib/queries.ts';
import { Demo } from './screens/Demo.tsx';
import { Login } from './screens/Login.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { OnboardingCurrency } from './screens/OnboardingCurrency.tsx';

/** Root-компонент: гейт по состоянию сессии → auth / онбординг / оболочка приложения. */
export function App() {
  const { t, setLocale } = useI18n();
  const { data: me, isLoading } = useMe();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Язык интерфейса подхватывается из воркспейса один раз за сессию: демо обязано открываться
  // по-английски (issue #56), а ручной выбор в шапке после этого не перетирается.
  const localeApplied = useRef(false);
  const wsLocale = me?.workspace?.locale;
  useEffect(() => {
    if (localeApplied.current || !wsLocale) return;
    localeApplied.current = true;
    /*
     * Локаль воркспейса — стартовое значение, а не приказ: если человек уже переключал язык сам,
     * его выбор сильнее. Иначе перезагрузка возвращала язык воркспейса и «переключил на русский»
     * не выживало (найдено браузерным E2E по следам аудита).
     */
    if (hasChosenLocale()) return;
    setLocale(wsLocale);
  }, [wsLocale, setLocale]);

  if (isLoading) {
    return <div className="dim page-center-full">{t('common.loading')}</div>;
  }
  /*
   * Демо — единственный экран, который живёт до сессии: он её и получает. Без этой ветки гейт
   * показывал смотрящему форму регистрации (найдено браузерным E2E), то есть весь смысл
   * «посмотреть без регистрации» ломался при первом же чистом визите.
   */
  if (!me?.user && pathname === '/demo') return <Demo />;
  if (!me?.user) return <Login />;
  if (!me.workspace) return <OnboardingCurrency />;
  // Онбординг закрыт, когда есть и ритм, и хотя бы один активный источник дохода —
  // либо когда пользователь осознанно его пропустил (тогда план пустой до ввода дохода).
  if (!me.onboardingComplete && !me.onboardingSkipped)
    return <Onboarding workspace={me.workspace} />;
  return <AppShell />;
}
