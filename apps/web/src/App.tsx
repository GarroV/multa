import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { authClient } from './lib/authClient.ts';
import { useI18n } from './lib/i18n.tsx';
import { useMe } from './lib/queries.ts';
import { Login } from './screens/Login.tsx';
import { OnboardingCurrency } from './screens/OnboardingCurrency.tsx';
import { OnboardingPayday } from './screens/OnboardingPayday.tsx';
import { Today } from './screens/Today.tsx';

function TopBar({ authed }: { authed: boolean }) {
  const { locale, setLocale } = useI18n();
  const qc = useQueryClient();
  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '14px 24px',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <span className="brand" style={{ fontWeight: 600, fontSize: 18 }}>
        multa
      </span>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['en', 'ru'] as const).map((l) => (
            <button
              key={l}
              type="button"
              className="chip"
              aria-pressed={locale === l}
              style={{ padding: '4px 10px', fontSize: 12 }}
              onClick={() => setLocale(l)}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        {authed && (
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px 12px' }}
            onClick={async () => {
              await authClient.signOut();
              await qc.invalidateQueries();
            }}
          >
            ⎋
          </button>
        )}
      </div>
    </header>
  );
}

export function App() {
  const { t } = useI18n();
  const { data: me, isLoading } = useMe();

  let screen: ReactNode;
  if (isLoading) {
    screen = (
      <div className="dim" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        {t('common.loading')}
      </div>
    );
  } else if (!me?.user) {
    screen = <Login />;
  } else if (!me.workspace) {
    screen = <OnboardingCurrency />;
  } else if (!me.workspace.periodAnchors) {
    screen = <OnboardingPayday workspace={me.workspace} />;
  } else {
    screen = <Today />;
  }

  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <TopBar authed={Boolean(me?.user)} />
      <main style={{ flex: 1 }}>{screen}</main>
    </div>
  );
}
