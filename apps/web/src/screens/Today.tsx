import type { ReactNode } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { usePlan } from '../lib/queries.ts';

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>{children}</div>;
}

export function Today() {
  const { t, locale } = useI18n();
  const { data: plan, isLoading, error } = usePlan(true);

  if (isLoading) return <Centered>{t('common.loading')}</Centered>;
  if (error || !plan) return <Centered><span className="dim">—</span></Centered>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24, display: 'grid', gap: 24 }}>
      <div>
        <div className="micro">{t('plan.hero.canSpend')}</div>
        <div className="hero-number">—</div>
        <div className="dim" style={{ marginTop: 8 }}>
          {t('plan.today.until', { date: plan.period.endsOn, days: plan.daysLeft })}
        </div>
      </div>

      <div className="card">
        <div className="micro">
          {t('plan.today.periodLabel')} · {plan.period.startsOn} → {plan.period.endsOn}
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{t('plan.empty.title')}</div>
          <div className="dim" style={{ marginTop: 6 }}>
            {t('plan.empty.subtitle')}
          </div>
        </div>
      </div>

      {plan.expectedIncomeMinor && (
        <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="dim">{t('plan.today.expected')}</span>
          <span className="mono" style={{ fontSize: 20 }}>
            {formatMinor(plan.expectedIncomeMinor, plan.baseCurrency, locale)} {plan.baseCurrency}
          </span>
        </div>
      )}
    </div>
  );
}
