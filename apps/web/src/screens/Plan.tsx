import type { TranslationKey } from '@multa/i18n';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { usePlan, type PlanAllocation, type PlanDto, type PlanTargetKind } from '../lib/queries.ts';

const GROUP_ORDER: PlanTargetKind[] = ['debt', 'bucket', 'envelope', 'category', 'goal'];
const GROUP_LABEL: Record<PlanTargetKind, TranslationKey> = {
  debt: 'plan.groups.debt',
  bucket: 'plan.groups.bucket',
  envelope: 'plan.groups.envelope',
  category: 'plan.groups.category',
  goal: 'plan.groups.goal',
};

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>{children}</div>;
}

function AllocationRow({ a, base, locale }: { a: PlanAllocation; base: string; locale: string }) {
  const { t } = useI18n();
  const allocated = `${formatMinor(a.allocatedMinor, base, locale)} ${base}`;
  const trimmed = BigInt(a.shortfallMinor) > 0n;
  // Вторичная строка: исходная валюта, если отличается от базовой (корзины — всегда, с назначением).
  const secondary =
    a.targetKind === 'bucket'
      ? `${formatMinor(a.sourceMinor, a.sourceCurrency, locale)} ${a.sourceCurrency} → ${a.toCurrency ?? ''}`
      : a.sourceCurrency !== base
        ? `${formatMinor(a.sourceMinor, a.sourceCurrency, locale)} ${a.sourceCurrency}`
        : null;
  return (
    <div className="list-item">
      <span>
        {a.name}
        {secondary && <span className="dim mono" style={{ marginLeft: 8, fontSize: 13 }}>· {secondary}</span>}
      </span>
      <span className="row" style={{ gap: 12 }}>
        {trimmed && (
          <span className="badge-trim">
            {t('plan.row.trimmed', { amount: `${formatMinor(a.shortfallMinor, base, locale)} ${base}` })}
          </span>
        )}
        <span className="mono">{allocated}</span>
      </span>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'accent' | 'warn' }) {
  return (
    <div>
      <span className="micro">{label}</span>
      <span className={`stat${tone ? ` ${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function PlanBody({ plan }: { plan: PlanDto }) {
  const { t, locale } = useI18n();
  const base = plan.baseCurrency;
  const fmt = (m: string) => `${formatMinor(m, base, locale)} ${base}`;
  const hasNothing = plan.allocations.length === 0 && plan.unresolved.length === 0;
  const compressed = BigInt(plan.compressedMinor) > 0n;

  const groups = GROUP_ORDER.map((kind) => ({
    kind,
    rows: plan.allocations.filter((a) => a.targetKind === kind),
  })).filter((g) => g.rows.length > 0);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 24, display: 'grid', gap: 20 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1 className="section-title" style={{ margin: 0 }}>{t('nav.plan')}</h1>
        <span className="micro">{plan.period.startsOn} → {plan.period.endsOn}</span>
      </div>

      <div className="plan-summary">
        <Stat label={t('plan.summary.income')} value={fmt(plan.incomeMinor)} />
        <Stat label={t('plan.summary.committed')} value={fmt(plan.totalAllocatedMinor)} />
        <Stat
          label={t('plan.summary.free')}
          value={fmt(plan.freeMinor)}
          tone={BigInt(plan.freeMinor) < 0n ? 'warn' : undefined}
        />
        <Stat
          label={t('plan.summary.perDay')}
          value={fmt(plan.canSpendPerDayMinor)}
          tone="accent"
        />
      </div>

      {plan.unresolved.length > 0 && (
        <div className="note-band">{t('plan.unresolved.affectsHero')}</div>
      )}

      {compressed && (
        <div className="note-band">
          {t('plan.compressed.note', { amount: formatMinor(plan.compressedMinor, base, locale), ccy: base })}
        </div>
      )}

      {hasNothing && (
        <div className="card">
          <div style={{ fontSize: 16, fontWeight: 600 }}>{t('plan.empty.title')}</div>
          <div className="dim" style={{ marginTop: 8 }}>{t('plan.empty.noPlan')}</div>
          <Link to="/obligations" className="btn" style={{ display: 'inline-block', marginTop: 16 }}>
            {t('nav.obligations')}
          </Link>
        </div>
      )}

      {groups.map((g) => {
        const groupTotal = g.rows.reduce((acc, r) => acc + BigInt(r.allocatedMinor), 0n);
        return (
          <div key={g.kind} className="plan-group card">
            <div className="plan-group-head">
              <span className="micro">{t(GROUP_LABEL[g.kind])}</span>
              <span className="mono dim">{fmt(groupTotal.toString())}</span>
            </div>
            {g.rows.map((a) => (
              <AllocationRow key={a.targetId} a={a} base={base} locale={locale} />
            ))}
          </div>
        );
      })}

      {plan.unresolved.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 10 }}>
          <span className="micro" style={{ color: 'var(--neon-amber)' }}>{t('plan.unresolved.title')}</span>
          {plan.unresolved.map((u) => (
            <div key={`${u.targetKind}:${u.targetId}`} className="list-item">
              <span>{u.name}</span>
              <span className="mono dim">{formatMinor(u.sourceMinor, u.sourceCurrency, locale)} {u.sourceCurrency}</span>
            </div>
          ))}
          <div className="dim" style={{ fontSize: 13 }}>{t('plan.unresolved.hint')}</div>
        </div>
      )}

      <div className="note-band info">{t('plan.categories.hint')}</div>
    </div>
  );
}

export function Plan() {
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
  return <PlanBody plan={plan} />;
}
