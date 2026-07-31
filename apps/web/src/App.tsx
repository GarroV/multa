import { useEffect, useRef } from 'react';
import { AppShell } from './AppShell.tsx';
import { useI18n } from './lib/i18n.tsx';
import { useMe } from './lib/queries.ts';
import { Login } from './screens/Login.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { OnboardingCurrency } from './screens/OnboardingCurrency.tsx';

/** Root-компонент: гейт по состоянию сессии → auth / онбординг / оболочка приложения. */
export function App() {
  const { t, setLocale } = useI18n();
  const { data: me, isLoading } = useMe();
  // Язык интерфейса подхватывается из воркспейса один раз за сессию: демо обязано открываться
  // по-английски (issue #56), а ручной выбор в шапке после этого не перетирается.
  const localeApplied = useRef(false);
  const wsLocale = me?.workspace?.locale;
  useEffect(() => {
    if (localeApplied.current || !wsLocale) return;
    localeApplied.current = true;
    setLocale(wsLocale);
  }, [wsLocale, setLocale]);

  if (isLoading) {
    return (
      <div className="dim" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        {t('common.loading')}
      </div>
    );
  }
  if (!me?.user) return <Login />;
  if (!me.workspace) return <OnboardingCurrency />;
  // Онбординг закрыт, когда есть и ритм, и хотя бы один активный источник дохода —
  // либо когда пользователь осознанно его пропустил (тогда план пустой до ввода дохода).
  if (!me.onboardingComplete && !me.onboardingSkipped) return <Onboarding workspace={me.workspace} />;
  return <AppShell />;
}
