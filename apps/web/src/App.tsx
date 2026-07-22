import { AppShell } from './AppShell.tsx';
import { useI18n } from './lib/i18n.tsx';
import { useMe } from './lib/queries.ts';
import { Login } from './screens/Login.tsx';
import { Onboarding } from './screens/Onboarding.tsx';
import { OnboardingCurrency } from './screens/OnboardingCurrency.tsx';

/** Root-компонент: гейт по состоянию сессии → auth / онбординг / оболочка приложения. */
export function App() {
  const { t } = useI18n();
  const { data: me, isLoading } = useMe();

  if (isLoading) {
    return (
      <div className="dim" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        {t('common.loading')}
      </div>
    );
  }
  if (!me?.user) return <Login />;
  if (!me.workspace) return <OnboardingCurrency />;
  if (!me.workspace.periodAnchors) return <Onboarding workspace={me.workspace} />;
  return <AppShell />;
}
