import type { TranslationKey } from '@multa/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet } from '@tanstack/react-router';
import { useState } from 'react';
import { ReceiptEntry } from './components/ReceiptEntry.tsx';
import { SpendEntry } from './components/SpendEntry.tsx';
import { authClient } from './lib/authClient.ts';
import { useI18n } from './lib/i18n.tsx';
import { useMe } from './lib/queries.ts';
import { useTheme } from './lib/theme.ts';

/**
 * Оболочка по прототипу (issue #30): навигация сверху, а не сайдбаром. Причина не в моде —
 * сайдбар забирал 216px ширины у ведомости, а плотный экран живёт шириной колонок. Табы, ввод
 * факта, тема и язык стоят в одной строке: всё управление в 48px высоты.
 */

const NAV: { to: string; key: TranslationKey }[] = [
  { to: '/plan', key: 'nav.plan' },
  { to: '/statistics', key: 'nav.statistics' },
  { to: '/obligations', key: 'nav.obligations' },
  { to: '/settings', key: 'nav.settings' },
];

export function AppShell() {
  const { t, locale, setLocale } = useI18n();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { theme, setTheme } = useTheme();
  const [spendOpen, setSpendOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const base = me?.workspace?.baseCurrency;

  return (
    <div className="app-frame">
      <header className="topbar">
        <span className="topbar-brand">multa</span>
        <nav className="tabs" aria-label={t('nav.plan')}>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className="tab" activeProps={{ className: 'tab tab-active' }}>
              {t(n.key)}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          {/* Ввод факта доступен с любого экрана: трату записывают на ходу (04-web-ux §Ввод). */}
          {base && (
            <>
              <button type="button" className="act" onClick={() => setSpendOpen(true)}>
                {t('spend.open')}
              </button>
              <button type="button" className="act" onClick={() => setReceiptOpen(true)}>
                {t('receipt.open')}
              </button>
            </>
          )}
          <span className="seg" role="group" aria-label={t('settings.theme')}>
            {(['dark', 'light'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className="seg-btn"
                aria-pressed={theme === v}
                onClick={() => setTheme(v)}
              >
                {t(v === 'dark' ? 'settings.theme.dark' : 'settings.theme.light')}
              </button>
            ))}
          </span>
          <span className="seg" role="group" aria-label={t('settings.language')}>
            {(['en', 'ru'] as const).map((l) => (
              <button
                key={l}
                type="button"
                className="seg-btn"
                aria-pressed={locale === l}
                onClick={() => setLocale(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </span>
          <button
            type="button"
            className="act"
            title={t('settings.signOut')}
            onClick={async () => {
              await authClient.signOut();
              await qc.invalidateQueries();
            }}
          >
            ⎋
          </button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      {spendOpen && base && <SpendEntry base={base} locale={locale} onClose={() => setSpendOpen(false)} />}
      {receiptOpen && base && (
        <ReceiptEntry base={base} locale={locale} onClose={() => setReceiptOpen(false)} />
      )}
    </div>
  );
}
