import type { TranslationKey } from '@multa/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { authClient } from './lib/authClient.ts';
import { useI18n } from './lib/i18n.tsx';

const NAV: { to: string; key: TranslationKey }[] = [
  { to: '/today', key: 'nav.today' },
  { to: '/plan', key: 'nav.plan' },
  { to: '/exchange', key: 'nav.exchange' },
  { to: '/obligations', key: 'nav.obligations' },
  { to: '/settings', key: 'nav.settings' },
];

export function AppShell() {
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand" style={{ fontWeight: 600, fontSize: 20, padding: '8px 16px 16px' }}>
          multa
        </div>
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className="nav-item" activeProps={{ className: 'nav-item nav-active' }}>
            {t(n.key)}
          </Link>
        ))}
        <div style={{ marginTop: 'auto', display: 'flex', gap: 8, padding: '12px 16px', alignItems: 'center' }}>
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
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px 10px' }}
            title="logout"
            onClick={async () => {
              await authClient.signOut();
              await qc.invalidateQueries();
            }}
          >
            ⎋
          </button>
        </div>
      </aside>
      <main style={{ minWidth: 0 }}>
        <Outlet />
      </main>
    </div>
  );
}
