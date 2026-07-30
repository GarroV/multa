import type { TranslationKey } from '@multa/i18n';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { CategoryEditor } from '../components/CategoryEditor.tsx';
import { NoIncomeYet } from '../components/NoIncomeYet.tsx';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  isOnboardingIncomplete,
  useConfirmExecution,
  usePlan,
  useSkipExecution,
  type PlanAllocation,
  type PlanDto,
  type PlanTargetKind,
} from '../lib/queries.ts';

// Категории редактируются отдельным блоком (CategoryEditor); в read-only лентах — только обязательства.
const GROUP_ORDER: PlanTargetKind[] = ['debt', 'bucket', 'envelope', 'goal'];
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
  const confirm = useConfirmExecution();
  const skip = useSkipExecution();
  const allocated = `${formatMinor(a.allocatedMinor, base, locale)} ${base}`;
  const trimmed = BigInt(a.shortfallMinor) > 0n;
  const done = a.executionStatus === 'confirmed';
  const busy = confirm.isPending || skip.isPending;
  const statusLabel =
    a.executionStatus === 'partial'
      ? t('exec.status.partial', { amount: `${formatMinor(a.remainderMinor, base, locale)} ${base}` })
      : a.executionStatus === 'confirmed'
        ? t('exec.status.confirmed')
        : a.executionStatus === 'skipped'
          ? t('exec.status.skipped')
          : t('exec.status.pending');
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
        <span className={`micro${done ? ' st-ok' : a.executionStatus === 'partial' ? ' st-warn' : ''}`}>
          {statusLabel}
        </span>
        <span className="num" style={done ? { textDecoration: 'line-through', opacity: 0.55 } : undefined}>
          {allocated}
        </span>
        {/* Исполнение — вручную по умолчанию: кредит банку тоже переводят руками. */}
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: '4px 10px' }}
          disabled={busy}
          aria-pressed={done}
          title={t('exec.confirm')}
          onClick={() => confirm.mutate({ targetKind: a.targetKind, targetId: a.targetId })}
        >
          ✓
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: '4px 10px' }}
          disabled={busy}
          aria-pressed={a.executionStatus === 'skipped'}
          title={t('exec.skip')}
          onClick={() => skip.mutate({ targetKind: a.targetKind, targetId: a.targetId })}
        >
          ⤫
        </button>
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
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t('nav.plan')}</h1>
        <span className="micro num">{plan.period.startsOn} → {plan.period.endsOn}</span>
      </div>

      <div className="stats">
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
        {BigInt(plan.extraIncomeMinor) > 0n && (
          <Stat label={t('plan.summary.extraIncome')} value={fmt(plan.extraIncomeMinor)} tone="accent" />
        )}
        {BigInt(plan.spentLivingMinor) > 0n && (
          <>
            <Stat label={t('plan.summary.spent')} value={fmt(plan.spentLivingMinor)} />
            <Stat
              label={t('plan.summary.remaining')}
              value={fmt(plan.remainingLivingMinor)}
              tone={BigInt(plan.remainingLivingMinor) < 0n ? 'warn' : undefined}
            />
          </>
        )}
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
          <div style={{ fontWeight: 600 }}>{t('plan.empty.title')}</div>
          <div className="sub" style={{ marginTop: 4 }}>{t('plan.empty.noPlan')}</div>
          <Link to="/obligations" className="btn" style={{ display: 'inline-block', marginTop: 12 }}>
            {t('nav.obligations')}
          </Link>
        </div>
      )}

      <CategoryEditor allocations={plan.allocations} base={base} locale={locale} />

      {groups.map((g) => {
        const groupTotal = g.rows.reduce((acc, r) => acc + BigInt(r.allocatedMinor), 0n);
        return (
          <section key={g.kind} className="tile tile-wide" aria-label={t(GROUP_LABEL[g.kind])}>
            <div className="tile-head">
              <span className="micro">{t(GROUP_LABEL[g.kind])}</span>
              <span className="num num-dim">{fmt(groupTotal.toString())}</span>
            </div>
            {g.rows.map((a) => (
              <AllocationRow key={a.targetId} a={a} base={base} locale={locale} />
            ))}
          </section>
        );
      })}

      {plan.unresolved.length > 0 && (
        <section className="tile tile-wide" aria-label={t('plan.unresolved.title')}>
          <span className="micro st-warn">{t('plan.unresolved.title')}</span>
          {plan.unresolved.map((u) => (
            <div key={`${u.targetKind}:${u.targetId}`} className="list-item">
              <span>{u.name}</span>
              <span className="num num-dim">{formatMinor(u.sourceMinor, u.sourceCurrency, locale)} {u.sourceCurrency}</span>
            </div>
          ))}
          <div className="sub">{t('plan.unresolved.hint')}</div>
        </section>
      )}
    </div>
  );
}

export function Plan() {
  const { t } = useI18n();
  const { data: plan, isLoading, error, refetch } = usePlan(true);
  if (isLoading) return <Centered>{t('common.loading')}</Centered>;
  // Дохода ещё нет (обучение пропущено) — не ошибка, а пустой лист с дорогой в настройки.
  if (isOnboardingIncomplete(error)) return <NoIncomeYet />;
  if (error) {
    return (
      <Centered>
        <div style={{ display: 'grid', gap: 10, justifyItems: 'center' }}>
          <span className="sub">{t('common.error')}</span>
          <button className="btn" onClick={() => void refetch()}>{t('common.retry')}</button>
        </div>
      </Centered>
    );
  }
  if (!plan) return <Centered><span className="dim">—</span></Centered>;
  return <PlanBody plan={plan} />;
}
