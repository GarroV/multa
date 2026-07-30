import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { NoIncomeYet } from '../components/NoIncomeYet.tsx';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  isOnboardingIncomplete,
  useForecast,
  usePlan,
  type ForecastEvent,
  type PlanDto,
} from '../lib/queries.ts';

function Centered({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>{children}</div>;
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Полоса периода — сигнатурный элемент обзора. Продукт живёт от выплаты до выплаты, поэтому
 * шкала показывает именно этот отрезок: сколько денег на жизнь уже израсходовано, где «сегодня»
 * и на каком дне при текущем темпе остаток кончится. Одна картинка отвечает на вопрос, ради
 * которого открывают приложение: «дотяну ли до выплаты».
 */
function PeriodBar({ plan }: { plan: PlanDto }) {
  const { t } = useI18n();
  const total = daysBetween(plan.period.startsOn, plan.period.endsOn);
  if (total <= 0) return null;

  const passed = Math.min(Math.max(total - plan.daysLeft, 0), total);
  const living = BigInt(plan.livingMinor);
  const spent = BigInt(plan.spentLivingMinor);
  const spentShare = living > 0n ? Math.min(100, Number((spent * 100n) / living)) : 0;
  const todayShare = (passed / total) * 100;
  const runOutShare =
    plan.burn.runsOutOn && !plan.burn.willLast
      ? Math.min(100, (daysBetween(plan.period.startsOn, plan.burn.runsOutOn) / total) * 100)
      : null;

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="period-bar" style={{ ['--days' as string]: String(total) }}>
        <span className="spent" style={{ width: `${spentShare}%` }} />
        {runOutShare !== null && <span className="runout" style={{ left: `${runOutShare}%` }} />}
        <span className="today" style={{ left: `${todayShare}%` }} />
        <span className="caption">
          <span>{plan.period.startsOn.slice(5)}</span>
          <span>{plan.period.endsOn.slice(5)}</span>
        </span>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'nowrap' }}>
        <span className="micro" style={{ whiteSpace: 'nowrap' }}>
          {t('plan.today.daysLeft', { days: plan.daysLeft })}
        </span>
        <span className="num num-dim">
          {t('spend.spentOfPlan', {
            spent: formatMinor(plan.spentLivingMinor, plan.baseCurrency, 'ru'),
            plan: formatMinor(plan.livingMinor, plan.baseCurrency, 'ru'),
          })}
        </span>
      </div>
    </div>
  );
}

/** Строка ведомости: слева смысл, справа сумма в колонке. */
function Row({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'ok' | 'warn' | 'over';
}) {
  return (
    <div className="list-item">
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
        {hint && <span className="dim" style={{ fontSize: 12 }}> · {hint}</span>}
      </span>
      <span className={`num${tone ? ` st-${tone}` : ''}`}>{value}</span>
    </div>
  );
}

function Dashboard({ plan }: { plan: PlanDto }) {
  const { t, locale } = useI18n();
  const base = plan.baseCurrency;
  const fmt = (m: string) => `${formatMinor(m, base, locale)} ${base}`;
  const { data: forecast } = useForecast();

  const perDay = plan.canSpendPerDayMinor !== '0' ? formatMinor(plan.canSpendPerDayMinor, base, locale) : '—';
  const overspent = BigInt(plan.overspentMinor) > 0n;
  const buckets = plan.allocations.filter((a) => a.targetKind === 'bucket');
  const obligations = plan.allocations.filter((a) => a.targetKind !== 'category' && a.targetKind !== 'bucket');
  const categories = plan.allocations
    .filter((a) => a.targetKind === 'category')
    .sort((a, b) => Number(BigInt(b.spentMinor) - BigInt(a.spentMinor)));
  const hasPlan = plan.allocations.length > 0;

  const eventLabel = (e: ForecastEvent): string => {
    const amount = e.amountMinor ? `${formatMinor(e.amountMinor, base, locale)} ${base}` : '';
    if (e.kind === 'debt_closed') return t('forecast.debtClosed', { name: e.name });
    if (e.kind === 'freed_money') return t('forecast.freed', { amount });
    if (e.kind === 'goal_reached') return t('forecast.goalReached', { name: e.name });
    return t('forecast.goalRisk', { name: e.name, amount });
  };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '12px 24px 40px', display: 'grid', gap: 12 }}>
      <div className="bento">
        {/* Ведущая клетка: одна цифра + полоса периода. Всё прочее — вокруг, тише. */}
        <section className="tile" style={{ gridColumn: 'span 2', gap: 12 }} aria-label={t('plan.hero.canSpend')}>
          <div className="tile-head">
            <span className="micro">{t('plan.hero.canSpend')}</span>
            {overspent && <span className="micro st-over">{fmt(plan.overspentMinor)}</span>}
          </div>
          <div className="row" style={{ alignItems: 'baseline', gap: 8 }}>
            <span className="hero-number num">{perDay}</span>
            <span className="dim" style={{ fontSize: 13 }}>
              {base} {t('plan.hero.perDay')}
            </span>
          </div>
          <PeriodBar plan={plan} />
        </section>

        {/* Деньги периода: план, факт, остаток — три строки, ни одной лишней. */}
        <section className="tile" aria-label={t('plan.money')}>
          <span className="micro">{t('plan.money')}</span>
          <Row label={t('plan.summary.income')} value={fmt(plan.incomeMinor)} />
          {BigInt(plan.extraIncomeMinor) > 0n && (
            <Row label={t('plan.summary.extraIncome')} value={`+${fmt(plan.extraIncomeMinor)}`} tone="ok" />
          )}
          <Row label={t('plan.summary.spent')} value={fmt(plan.spentLivingMinor)} />
          <Row
            label={t('plan.summary.remaining')}
            value={fmt(plan.remainingLivingMinor)}
            tone={overspent ? 'over' : undefined}
          />
        </section>

        {/* Обязательства: что уже внесено, а что ещё нет. */}
        {obligations.length > 0 && (
          <section className="tile" aria-label={t('plan.groups.debt')}>
            <div className="tile-head">
              <span className="micro">{t('plan.summary.committed')}</span>
              <Link to="/plan" className="micro">
                {t('plan.today.viewFull')}
              </Link>
            </div>
            {obligations.slice(0, 5).map((a) => (
              <Row
                key={a.targetId}
                label={a.name}
                value={fmt(a.allocatedMinor)}
                hint={
                  a.executionStatus === 'confirmed'
                    ? t('exec.status.confirmed')
                    : a.executionStatus === 'partial'
                      ? t('exec.status.partial', { amount: fmt(a.remainderMinor) })
                      : a.executionStatus === 'skipped'
                        ? t('exec.status.skipped')
                        : t('exec.status.pending')
                }
                tone={
                  a.executionStatus === 'confirmed' ? 'ok' : a.executionStatus === 'partial' ? 'warn' : undefined
                }
              />
            ))}
          </section>
        )}

        {/* Валютные корзины: пара «из чего → во что» — язык продукта, а не абстрактный «перевод». */}
        {buckets.length > 0 && (
          <section className="tile" aria-label={t('plan.summary.toExchange')}>
            <div className="tile-head">
              <span className="micro">{t('plan.summary.toExchange')}</span>
              <span className="num num-dim">{fmt(plan.toExchangeMinor)}</span>
            </div>
            {buckets.map((b) => (
              <Row
                key={b.targetId}
                label={b.name}
                hint={`${b.sourceCurrency} → ${b.toCurrency ?? ''}`}
                value={`${formatMinor(b.sourceMinor, b.sourceCurrency, locale)} ${b.sourceCurrency}`}
              />
            ))}
          </section>
        )}

        {/* Категории: таблица — правда. Сортировка по факту: наверху то, что реально жрёт деньги. */}
        {categories.length > 0 && (
          <section className="tile tile-wide" aria-label={t('plan.groups.category')}>
            <div className="tile-head">
              <span className="micro">{t('plan.groups.category')}</span>
              <Link to="/plan" className="micro">
                {t('plan.today.viewFull')}
              </Link>
            </div>
            {categories.slice(0, 8).map((c) => {
              const over = BigInt(c.overspentMinor) > 0n;
              return (
                <Row
                  key={c.targetId}
                  label={c.name}
                  hint={`${formatMinor(c.spentMinor, base, locale)} / ${formatMinor(c.allocatedMinor, base, locale)}`}
                  value={over ? `−${fmt(c.overspentMinor)}` : fmt(c.remainingMinor)}
                  tone={over ? 'over' : undefined}
                />
              );
            })}
          </section>
        )}

        {/* Что впереди: списания периода и события горизонта. */}
        {forecast && (forecast.dueSoon.length > 0 || forecast.events.length > 0) && (
          <section className="tile tile-wide" aria-label={t('forecast.title')}>
            <span className="micro">{t('forecast.title')}</span>
            {forecast.dueSoon.slice(0, 4).map((d) => (
              <Row
                key={d.id}
                label={d.name}
                hint={d.on.slice(5)}
                value={`${formatMinor(d.amountMinor, d.currency, locale)} ${d.currency}`}
              />
            ))}
            {forecast.events.slice(0, 4).map((e) => (
              <Row
                key={`${e.kind}:${e.targetId}`}
                label={eventLabel(e)}
                value={e.on}
                tone={e.kind === 'goal_at_risk' ? 'warn' : undefined}
              />
            ))}
          </section>
        )}
      </div>

      {plan.unresolved.length > 0 && <div className="note-band">{t('plan.unresolved.affectsHero')}</div>}

      {/* Сигнал приходит до того, как деньги кончились: тон штурмана, без вины. */}
      {!plan.burn.willLast && plan.burn.runsOutOn && (
        <div className="note-band">
          <div style={{ color: 'var(--text-hi)', fontWeight: 500 }}>
            {t('signal.burn.title', { date: plan.burn.runsOutOn })}
          </div>
          <div style={{ marginTop: 2 }}>
            {t('signal.burn.body', {
              perDay: fmt(plan.burn.perDayMinor),
              perDayPlan: fmt(plan.canSpendPerDayMinor),
            })}
          </div>
        </div>
      )}

      {!hasPlan && (
        <div className="card">
          <div style={{ fontWeight: 600 }}>{t('plan.empty.title')}</div>
          <div className="dim" style={{ marginTop: 4, fontSize: 13 }}>{t('plan.empty.noPlan')}</div>
          <Link to="/obligations" className="btn" style={{ display: 'inline-block', marginTop: 12 }}>
            {t('nav.obligations')}
          </Link>
        </div>
      )}
    </div>
  );
}

export function Today() {
  const { t } = useI18n();
  const { data: plan, isLoading, error, refetch } = usePlan(true);
  if (isLoading) return <Centered>{t('common.loading')}</Centered>;
  if (isOnboardingIncomplete(error)) return <NoIncomeYet />;
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
