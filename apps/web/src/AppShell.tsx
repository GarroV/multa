import type { TranslationKey } from '@multa/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { useState } from 'react';
import { ReceiptEntry } from './components/ReceiptEntry.tsx';
import { SpendEntry } from './components/SpendEntry.tsx';
import { authClient } from './lib/authClient.ts';
import { useI18n } from './lib/i18n.tsx';
import { useMe } from './lib/queries.ts';

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
  const { data: me } = useMe();
  const [spendOpen, setSpendOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const base = me?.workspace?.baseCurrency;

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
        {/* Действия живут над содержимым: ввод факта нужен на любом экране (04-web-ux §Ввод). */}
        {base && (
          <div
            className="actions"
            style={{ maxWidth: 960, margin: '0 auto', padding: '16px 24px 0' }}
          >
            <button type="button" className="primary" onClick={() => setSpendOpen(true)}>
              {t('spend.open')}
            </button>
            <button type="button" onClick={() => setReceiptOpen(true)}>
              {t('receipt.open')}
            </button>
          </div>
        )}
        <Outlet />
      </main>
      {spendOpen && base && <SpendEntry base={base} locale={locale} onClose={() => setSpendOpen(false)} />}
      {receiptOpen && base && (
        <ReceiptEntry base={base} locale={locale} onClose={() => setReceiptOpen(false)} />
      )}
    </div>
  );
}
