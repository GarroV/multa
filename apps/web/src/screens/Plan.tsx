import type { TranslationKey } from '@multa/i18n';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { CategoryEditor } from '../components/CategoryEditor.tsx';
import { IncomeReceipt } from '../components/IncomeReceipt.tsx';
import { NoIncomeYet } from '../components/NoIncomeYet.tsx';
import { Bar, Panel, Tag, type Accent } from '../components/ui/Panel.tsx';
import { CascadeDonut } from '../components/ui/CascadeDonut.tsx';
import { PeriodMap } from '../components/ui/PeriodMap.tsx';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  isOnboardingIncomplete,
  useBalances,
  useCancelIncomeReceipt,
  useConfirmExecution,
  useForecast,
  useGoalFreeze,
  useRevisions,
  usePlan,
  useSkipExecution,
  useUndoRevision,
  type ForecastEvent,
  type IncomeEventDto,
  type PlanAllocation,
  type PlanDto,
  type PlanTargetKind,
} from '../lib/queries.ts';

/**
 * План периода — главный экран (прототип, issue #30). Плотная ведомость вместо набора карточек:
 * сверху четыре ответа («сколько осталось», «сколько в день», «сколько менять», «куда ушла
 * выплата»), под ними ось периода, дальше — панели по группам каскада. Всё числовое приходит из
 * `GET /v1/plan/current`: экран ничего не досчитывает, кроме долей для доната и позиций на оси.
 */

const GROUP_LABEL: Record<PlanTargetKind, TranslationKey> = {
  debt: 'plan.groups.debt',
  bucket: 'obl.buckets',
  envelope: 'plan.groups.envelope',
  category: 'plan.groups.category',
  goal: 'plan.groups.goal',
};

/** Засечка панели = роль раздела: долги — риск, корзины — другая валюта, цели — накопление. */
const GROUP_ACCENT: Record<PlanTargetKind, Accent> = {
  debt: 'mag',
  bucket: 'vio',
  envelope: 'cyan',
  category: 'cyan',
  goal: 'lime',
};

function Centered({ children }: { children: ReactNode }) {
  return <div className="center-screen">{children}</div>;
}

/** Строка обязательства: имя и валюта слева, сумма в колонке, исполнение — вручную. */
function AllocationRow({ a, base, locale }: { a: PlanAllocation; base: string; locale: string }) {
  const { t } = useI18n();
  const confirm = useConfirmExecution();
  const skip = useSkipExecution();
  const freeze = useGoalFreeze();
  const busy = confirm.isPending || skip.isPending;
  const done = a.executionStatus === 'confirmed';
  const skipped = a.executionStatus === 'skipped';
  const trimmed = BigInt(a.shortfallMinor) > 0n;
  const secondary =
    a.targetKind === 'bucket'
      ? `${formatMinor(a.sourceMinor, a.sourceCurrency, locale)} ${a.sourceCurrency} → ${a.toCurrency ?? ''}`
      : a.sourceCurrency !== base
        ? `${formatMinor(a.sourceMinor, a.sourceCurrency, locale)} ${a.sourceCurrency}`
        : null;

  return (
    <div className="prow">
      <span className="prow-day" aria-hidden />
      <span className="prow-name">
        <span>{a.name}</span>
        {a.sourceCurrency !== base && <Tag tone="vio">{a.sourceCurrency}</Tag>}
        {trimmed && (
          <Tag tone="amber">
            {t('plan.row.trimmed', { amount: formatMinor(a.shortfallMinor, base, locale) })}
          </Tag>
        )}
        {a.protectedCategory && <Tag tone="cyan">{t('plan.tag.protected')}</Tag>}
        {a.frozen && <Tag tone="amber">{t('goal.frozen')}</Tag>}
      </span>
      <span className="prow-num">
        <b className={done || skipped ? 'dim' : undefined}>
          {formatMinor(a.allocatedMinor, base, locale)} {base}
        </b>
        {secondary && <i>{secondary}</i>}
      </span>
      <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
        {a.targetKind === 'goal' && (
          <button
            type="button"
            className="act"
            disabled={freeze.isPending}
            aria-pressed={a.frozen === true}
            onClick={() => freeze.mutate({ goalId: a.targetId, frozen: a.frozen !== true })}
          >
            {t(a.frozen ? 'goal.unfreeze' : 'goal.freeze')}
          </button>
        )}
        {/* Исполнение вручную по умолчанию: кредит банку тоже переводят руками. */}
        <button
          type="button"
          className="act"
          disabled={busy}
          aria-pressed={done}
          onClick={() => confirm.mutate({ targetKind: a.targetKind, targetId: a.targetId })}
        >
          {done ? t('exec.status.confirmed') : t('plan.act.pay')}
        </button>
        <button
          type="button"
          className="act"
          disabled={busy}
          aria-pressed={skipped}
          title={t('exec.skip')}
          onClick={() => skip.mutate({ targetKind: a.targetKind, targetId: a.targetId })}
        >
          ⤫
        </button>
      </span>
    </div>
  );
}

/** Строка категории: полоса факт/план под именем — перерасход виден без чтения цифр. */
function CategoryRow({ a, base, locale }: { a: PlanAllocation; base: string; locale: string }) {
  const planned = BigInt(a.allocatedMinor);
  const spent = BigInt(a.spentMinor);
  const over = BigInt(a.overspentMinor) > 0n;
  const share = planned > 0n ? Number((spent * 1000n) / planned) / 10 : spent > 0n ? 100 : 0;

  return (
    <div className="prow">
      <span className="prow-day" aria-hidden />
      <span className="prow-name">
        <span>{a.name}</span>
        {a.protectedCategory && <Tag tone="cyan">🔒</Tag>}
      </span>
      <span className="prow-num">
        <b className={over ? 'st-over' : undefined}>
          {formatMinor(a.spentMinor, base, locale)} / {formatMinor(a.allocatedMinor, base, locale)}
        </b>
      </span>
      <span />
      <span className="prow-bar">
        <Bar share={share} tone={over ? 'mag' : share > 85 ? 'amber' : 'cyan'} label={a.name} />
        <span className="prow-num">
          <i>
            {formatMinor(a.remainingMinor, base, locale)} {base}
          </i>
        </span>
      </span>
    </div>
  );
}

/**
 * Что впереди: горизонт за границей периода. Карта периода отвечает «что успеет случиться до
 * выплаты», эта панель — «что дальше»: когда закроется долг, что освободится, где цель не успеет.
 */
function ForecastPanel({ base, locale }: { base: string; locale: string }) {
  const { t } = useI18n();
  const { data } = useForecast();
  if (!data || (data.dueSoon.length === 0 && data.events.length === 0)) return null;

  const label = (e: ForecastEvent): string => {
    const amount = e.amountMinor ? `${formatMinor(e.amountMinor, base, locale)} ${base}` : '';
    if (e.kind === 'debt_closed') return t('forecast.debtClosed', { name: e.name });
    if (e.kind === 'freed_money') return t('forecast.freed', { amount });
    if (e.kind === 'goal_reached') return t('forecast.goalReached', { name: e.name });
    return t('forecast.goalRisk', { name: e.name, amount });
  };

  return (
    <Panel label={t('forecast.title')} accent="amber">
      {data.events.slice(0, 6).map((e) => (
        <div className="prow" key={`${e.kind}:${e.targetId}`}>
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className={e.kind === 'goal_at_risk' ? 'st-warn' : undefined}>{label(e)}</span>
          </span>
          <span className="prow-num">
            <i>{e.on}</i>
          </span>
          <span />
        </div>
      ))}
    </Panel>
  );
}

/**
 * История правок периода (issue #52): что перенесли, откуда и когда. Откат доступен, пока деньги
 * не ушли дальше; если ушли — говорим прямо, а не молча ничего не делаем.
 */
function RevisionsPanel({ base, locale }: { base: string; locale: string }) {
  const { t } = useI18n();
  const { data = [] } = useRevisions();
  const undo = useUndoRevision();
  if (data.length === 0) return null;

  return (
    <Panel
      label={t('rev.title')}
      accent="amber"
      foot={undo.isError ? <span className="sub danger">{t('rev.cantUndo')}</span> : undefined}
    >
      {data.map((rev) => {
        const first = rev.moves[0];
        return (
          <div className="prow" key={rev.id}>
            <span className="prow-day">{rev.createdAt.slice(5, 10)}</span>
            <span className="prow-name">
              <span>
                {first
                  ? t(
                      rev.kind === 'freeze'
                        ? 'rev.freeze'
                        : rev.kind === 'unfreeze'
                          ? 'rev.unfreeze'
                          : 'rev.move',
                      {
                        amount: `${formatMinor(first.amountMinor, base, locale)} ${base}`,
                        to: first.toName ?? '—',
                        from: first.fromName ?? '—',
                      },
                    )
                  : rev.reason}
              </span>
              {rev.undone && <Tag>{t('rev.undone')}</Tag>}
            </span>
            <span className="prow-num" />
            {rev.undone || rev.kind !== 'move' ? (
              <span />
            ) : (
              <button
                type="button"
                className="act"
                disabled={undo.isPending}
                onClick={() => undo.mutate(rev.id)}
              >
                {t('rev.undo')}
              </button>
            )}
          </div>
        );
      })}
    </Panel>
  );
}

function Kpi({ label, tag, children }: { label: string; tag?: ReactNode; children: ReactNode }) {
  return (
    <div className="kpi">
      <span className="kpi-label">
        {label}
        {tag}
      </span>
      {children}
    </div>
  );
}

function PlanBody({ plan }: { plan: PlanDto }) {
  const { t, locale } = useI18n();
  const base = plan.baseCurrency;
  const forecast = useForecast();
  // Пересборка живёт в строке категории (там известно, сколько не хватает), поэтому баннер
  // риска не открывает свой модал, а раскрывает редактор категорий — оттуда один шаг до варианта.
  const [editingCats, setEditingCats] = useState(false);
  // Подтверждение поступления (issue #48): открывается чипом «ждём» у конкретной выплаты.
  const [receiptFor, setReceiptFor] = useState<IncomeEventDto | null>(null);
  const cancelReceipt = useCancelIncomeReceipt();
  const balances = useBalances();

  const fmt = (m: string | bigint) => formatMinor(String(m), base, locale);
  const withCcy = (m: string | bigint) => `${fmt(m)} ${base}`;

  const buckets = plan.allocations.filter((a) => a.targetKind === 'bucket');
  const categories = plan.allocations.filter((a) => a.targetKind === 'category');
  const compressed = BigInt(plan.compressedMinor) > 0n;
  const living = BigInt(plan.livingMinor);
  const spentShare =
    living > 0n ? Number((BigInt(plan.spentLivingMinor) * 1000n) / living) / 10 : 0;
  const risky = !plan.burn.willLast && plan.burn.runsOutOn;

  const obligationGroups = (['debt', 'envelope', 'goal', 'bucket'] as const)
    .map((kind) => ({ kind, rows: plan.allocations.filter((a) => a.targetKind === kind) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="dense">
      {receiptFor && (
        <IncomeReceipt event={receiptFor} base={base} onClose={() => setReceiptFor(null)} />
      )}
      <div className="kpi-strip">
        {balances.data && balances.data.byCurrency.length > 0 && (
          <Kpi label={t('acc.total')}>
            <span className="kpi-value">
              {balances.data.totalMinor === null
                ? '—'
                : `${formatMinor(balances.data.totalMinor, base, locale)} ${base}`}
            </span>
            <div className="kpi-rows">
              {balances.data.byCurrency.map((b) => (
                <div key={b.currency}>
                  <span>
                    {formatMinor(b.minor, b.currency, locale)} {b.currency}
                  </span>
                  {b.baseMinor === null ? (
                    <span className="st-warn">—</span>
                  ) : (
                    b.currency !== base && (
                      <span className="dim">≈ {formatMinor(b.baseMinor, base, locale)}</span>
                    )
                  )}
                </div>
              ))}
            </div>
            {balances.data.unresolved.length > 0 && (
              <span className="kpi-sub st-warn">
                {t('acc.noRate', { list: balances.data.unresolved.join(', ') })}
              </span>
            )}
          </Kpi>
        )}
        <Kpi label={t('plan.kpi.left', { days: plan.daysLeft })}>
          <span className={`kpi-value${BigInt(plan.remainingLivingMinor) < 0n ? ' over' : ''}`}>
            {withCcy(plan.remainingLivingMinor)}
          </span>
          <Bar share={spentShare} tone={BigInt(plan.overspentMinor) > 0n ? 'mag' : 'cyan'} />
          <span className="kpi-sub">
            {t('spend.spentOfPlan', {
              spent: fmt(plan.spentLivingMinor),
              plan: fmt(plan.livingMinor),
            })}
          </span>
        </Kpi>

        <Kpi label={t('plan.kpi.canSpend')}>
          <span className="kpi-value accent">
            {fmt(plan.canSpendPerDayMinor)} <span className="kpi-sub">{t('plan.kpi.perDay')}</span>
          </span>
          <span className="kpi-sub">
            {t('plan.today.until', { date: plan.period.endsOn.slice(5), days: plan.daysLeft })}
          </span>
        </Kpi>

        <Kpi
          label={t('plan.summary.toExchange')}
          tag={<Tag tone="vio">{t('plan.kpi.calculated')}</Tag>}
        >
          {buckets.length === 0 && <span className="kpi-sub">{t('plan.kpi.noExchange')}</span>}
          <div className="kpi-rows">
            {buckets.map((b) => (
              <div key={b.targetId}>
                <span>
                  {withCcy(b.allocatedMinor)} → {b.toCurrency ?? b.sourceCurrency}
                </span>
                <span className="dim">{b.name}</span>
              </div>
            ))}
          </div>
        </Kpi>

        <Kpi label={t('plan.kpi.cascade', { amount: withCcy(plan.incomeMinor) })}>
          <CascadeDonut plan={plan} />
          <span className="kpi-sub">
            {t('plan.kpi.leftToLive')} <b className="mono">{withCcy(plan.livingMinor)}</b>
          </span>
        </Kpi>
      </div>

      {risky && (
        <div className="risk-band">
          <span className="risk-text">
            {t('signal.burn.title', { date: plan.burn.runsOutOn!.slice(5) })} ·{' '}
            {t('signal.burn.body', {
              perDay: withCcy(plan.burn.perDayMinor),
              perDayPlan: withCcy(plan.canSpendPerDayMinor),
            })}
          </span>
          <button type="button" className="act" onClick={() => setEditingCats(true)}>
            {t('signal.burn.action')}
          </button>
        </div>
      )}

      {compressed && !risky && (
        <div className="risk-band info">
          <span className="risk-text">
            {t('plan.compressed.note', { amount: fmt(plan.compressedMinor), ccy: base })}
          </span>
        </div>
      )}

      {plan.unresolved.length > 0 && (
        <div className="risk-band info">
          <span className="risk-text">{t('plan.unresolved.affectsHero')}</span>
          <span className="panel-sum">{plan.unresolved.map((u) => u.name).join(' · ')}</span>
        </div>
      )}

      <PeriodMap plan={plan} dueSoon={forecast.data?.dueSoon} events={forecast.data?.events} />

      <div className="panels">
        <div className="col">
          <Panel
            label={t('plan.panel.income')}
            sum={withCcy(plan.incomeMinor)}
            accent="lime"
            tools={
              <Link className="act" to="/settings">
                {t('plan.act.edit')}
              </Link>
            }
          >
            {plan.income.events.length === 0 && (
              <div className="prow">
                <span />
                <span className="dim">{t('common.empty')}</span>
              </div>
            )}
            {plan.income.events.map((e) => (
              <div className="prow" key={`${e.sourceId}:${e.date}`}>
                <span className="prow-day">{e.date.slice(8, 10)}</span>
                <span className="prow-name">
                  <span>{e.label}</span>
                  {e.currency !== base && <Tag tone="vio">{e.currency}</Tag>}
                  {e.status === 'received' && <Tag tone="lime">{t('income.chip.received')}</Tag>}
                </span>
                <span className="prow-num">
                  <b>
                    {formatMinor(e.amountMinor, e.currency, locale)} {e.currency}
                  </b>
                  {e.baseAmountMinor && e.currency !== base && (
                    <i>
                      ≈ {formatMinor(e.baseAmountMinor, base, locale)} {base}
                    </i>
                  )}
                </span>
                {/* Пока «ждём» — чип открывает подтверждение факта; после — даёт его отменить. */}
                {e.status === 'expected' ? (
                  <button type="button" className="act" onClick={() => setReceiptFor(e)}>
                    {t('income.chip.expected')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="act"
                    disabled={cancelReceipt.isPending}
                    onClick={() => e.receiptId && cancelReceipt.mutate(e.receiptId)}
                  >
                    {t('income.cancelReceipt')}
                  </button>
                )}
              </div>
            ))}
            {BigInt(plan.extraIncomeMinor) > 0n && (
              <div className="prow">
                <span className="prow-day" aria-hidden />
                <span className="prow-name">
                  <span>{t('plan.summary.extraIncome')}</span>
                </span>
                <span className="prow-num">
                  <b className="st-ok">{withCcy(plan.extraIncomeMinor)}</b>
                </span>
                <span />
              </div>
            )}
          </Panel>

          <Panel
            label={t('plan.groups.category')}
            sum={t('plan.panel.perPeriod', {
              amount: withCcy(categories.reduce((s, c) => s + BigInt(c.allocatedMinor), 0n)),
            })}
            tools={
              <button
                type="button"
                className="act"
                aria-pressed={editingCats}
                onClick={() => setEditingCats((v) => !v)}
              >
                {t('plan.act.edit')}
              </button>
            }
          >
            {categories.length === 0 && !editingCats && (
              <div className="prow">
                <span />
                <span className="dim">{t('common.empty')}</span>
              </div>
            )}
            {!editingCats &&
              categories.map((a) => (
                <CategoryRow key={a.targetId} a={a} base={base} locale={locale} />
              ))}
            {editingCats && (
              <div style={{ padding: '10px 14px' }}>
                <CategoryEditor allocations={plan.allocations} base={base} locale={locale} />
              </div>
            )}
          </Panel>
        </div>

        <div className="col">
          {obligationGroups.map((g) => (
            <Panel
              key={g.kind}
              label={t(GROUP_LABEL[g.kind])}
              accent={GROUP_ACCENT[g.kind]}
              sum={t('plan.panel.perPeriod', {
                amount: withCcy(g.rows.reduce((s, r) => s + BigInt(r.allocatedMinor), 0n)),
              })}
              tools={
                <Link className="act" to="/obligations">
                  {t('plan.act.edit')}
                </Link>
              }
            >
              {g.rows.map((a) => (
                <AllocationRow key={a.targetId} a={a} base={base} locale={locale} />
              ))}
            </Panel>
          ))}

          {obligationGroups.length === 0 && (
            <Panel label={t('plan.empty.title')} accent="amber">
              <div className="prow">
                <span />
                <span className="dim">{t('plan.empty.noPlan')}</span>
                <Link className="act" to="/obligations">
                  {t('nav.obligations')}
                </Link>
                <span />
              </div>
            </Panel>
          )}

          <RevisionsPanel base={base} locale={locale} />

          <ForecastPanel base={base} locale={locale} />

          {plan.unresolved.length > 0 && (
            <Panel
              label={t('plan.unresolved.title')}
              accent="amber"
              foot={<span className="sub">{t('plan.unresolved.hint')}</span>}
            >
              {plan.unresolved.map((u) => (
                <div className="prow" key={`${u.targetKind}:${u.targetId}`}>
                  <span className="prow-day" aria-hidden />
                  <span className="prow-name">
                    <span>{u.name}</span>
                  </span>
                  <span className="prow-num">
                    <b>
                      {formatMinor(u.sourceMinor, u.sourceCurrency, locale)} {u.sourceCurrency}
                    </b>
                  </span>
                  <span />
                </div>
              ))}
            </Panel>
          )}
        </div>
      </div>
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
        <div className="center-stack">
          <span className="sub">{t('common.error')}</span>
          <button className="btn" onClick={() => void refetch()}>
            {t('common.retry')}
          </button>
        </div>
      </Centered>
    );
  }
  if (!plan)
    return (
      <Centered>
        <span className="dim">—</span>
      </Centered>
    );
  return <PlanBody plan={plan} />;
}
