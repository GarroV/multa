import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { usePlan, type PlanDto } from '../lib/queries.ts';

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>{children}</div>;
}

function Dashboard({ plan }: { plan: PlanDto }) {
  const { t, locale } = useI18n();
  const base = plan.baseCurrency;
  const fmt = (m: string) => `${formatMinor(m, base, locale)} ${base}`;

  const perDay = plan.canSpendPerDayMinor !== '0' ? formatMinor(plan.canSpendPerDayMinor, base, locale) : null;
  const buckets = plan.allocations.filter((a) => a.targetKind === 'bucket');
  const hasPlan = plan.allocations.length > 0;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24, display: 'grid', gap: 24 }}>
      <div>
        <div className="micro">{t('plan.hero.canSpend')}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 8 }}>
          <span className="hero-number">{perDay ?? '—'}</span>
          {perDay && (
            <span className="mono dim" style={{ fontSize: 24 }}>
              {base} {t('plan.hero.perDay')}
            </span>
          )}
        </div>
        <div className="dim" style={{ marginTop: 8 }}>
          {t('plan.today.until', { date: plan.period.endsOn, days: plan.daysLeft })}
        </div>
      </div>

      {plan.unresolved.length > 0 && (
        <div className="note-band">{t('plan.unresolved.affectsHero')}</div>
      )}

      {!hasPlan && (
        <div className="card">
          <div className="micro">
            {t('plan.today.periodLabel')} · {plan.period.startsOn} → {plan.period.endsOn}
          </div>
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{t('plan.empty.title')}</div>
            <div className="dim" style={{ marginTop: 6 }}>{t('plan.empty.noPlan')}</div>
            <Link to="/obligations" className="btn" style={{ display: 'inline-block', marginTop: 16 }}>
              {t('nav.obligations')}
            </Link>
          </div>
        </div>
      )}

      {buckets.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 4 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="micro">{t('plan.summary.toExchange')}</span>
            <span className="mono dim">{fmt(plan.toExchangeMinor)}</span>
          </div>
          {buckets.map((b) => (
            <div key={b.targetId} className="list-item">
              <span>{b.name}</span>
              <span className="mono">
                {formatMinor(b.sourceMinor, b.sourceCurrency, locale)} {b.sourceCurrency}
                <span className="dim"> → {b.toCurrency}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {hasPlan && (
        <div className="card" style={{ display: 'grid', gap: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="dim">{t('plan.summary.income')}</span>
            <span className="mono">{fmt(plan.incomeMinor)}</span>
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="dim">{t('plan.summary.free')}</span>
            <span className="mono" style={BigInt(plan.freeMinor) < 0n ? { color: 'var(--neon-amber)' } : undefined}>
              {fmt(plan.freeMinor)}
            </span>
          </div>
          <Link to="/plan" style={{ marginTop: 4 }}>{t('plan.today.viewFull')}</Link>
        </div>
      )}
    </div>
  );
}

export function Today() {
  const { t } = useI18n();
  const { data: plan, isLoading, error, refetch } = usePlan(true);
  if (isLoading) return <Centered>{t('common.loading')}</Centered>;
  if (error) {
    return (
      <Centered>
        <div style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
          <span className="dim">{t('common.error')}</span>
          <button className="btn" onClick={() => void refetch()}>{t('common.retry')}</button>
        </div>
      </Centered>
    );
  }
  if (!plan) return <Centered><span className="dim">—</span></Centered>;
  return <Dashboard plan={plan} />;
}
