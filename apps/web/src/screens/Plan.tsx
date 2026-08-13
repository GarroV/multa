import type { TranslationKey } from '@multa/i18n';
import { Link, useRouterState } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { CategoryEditor } from '../components/CategoryEditor.tsx';
import { IncomeEditor } from '../components/IncomeEditor.tsx';
import { MasterGrid } from '../components/MasterGrid.tsx';
import { Tour } from '../components/tour/Tour.tsx';
import { PLAN_TOUR } from '../components/tour/steps.ts';
import { IncomeReceipt } from '../components/IncomeReceipt.tsx';
import { NoIncomeYet } from '../components/NoIncomeYet.tsx';
import { Bar, Panel, Tag, type Accent } from '../components/ui/Panel.tsx';
import { CascadeDonut } from '../components/ui/CascadeDonut.tsx';
import { PeriodMap } from '../components/ui/PeriodMap.tsx';
import { formatDate, formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useIsMember } from '../lib/role.ts';
import { isSectionVisible } from '../lib/sections.ts';
import {
  isOnboardingIncomplete,
  useBalances,
  useCancelIncomeReceipt,
  useConfirmExecution,
  useForecast,
  useGoalFreeze,
  useMe,
  usePatchSettings,
  useRevisions,
  usePlan,
  useSettings,
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

/** Подпись раздела для свёрнутых сумм: те же слова, что и в панелях плана. */
function sectionLabel(t: (key: TranslationKey) => string, section: string): string {
  const keys: Record<string, TranslationKey> = {
    income: 'share.sec.income',
    debts: 'plan.groups.debt',
    buckets: 'obl.buckets',
    envelopes: 'plan.groups.envelope',
    categories: 'plan.groups.category',
    goals: 'plan.groups.goal',
  };
  return t(keys[section] ?? 'share.private');
}

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
  // Провал денежной мутации обязан быть виден: иначе он читается как «кнопка не сработала».
  const failed = confirm.isError || skip.isError || freeze.isError;
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
      <span className="row row-tight">
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
      {failed && <span className="prow-note danger">⚠ {t('common.error')}</span>}
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
  // Прогноз научен матрице (issue #84): имена закрытых разделов в него не попадают.
  const { data } = useForecast();
  if (!data) return null;
  /*
   * Пустая лента — тоже ответ (#105). Раньше панель исчезала целиком, и человек не знал ни что
   * раздел есть, ни что впереди действительно чисто: текст `forecast.empty` был написан и лежал
   * мёртвым. Пропадает панель только пока прогноз не загрузился.
   */
  const nothingAhead = data.dueSoon.length === 0 && data.events.length === 0;

  const label = (e: ForecastEvent): string => {
    /*
     * Валюта события, а не базовая (#99): долг в евро печатался как «освободится 200 ₽», а при
     * базовой валюте с другим exponent (JPY) ломался бы и разряд. Конвертировать нечем — курса на
     * будущую дату не существует.
     */
    const amount = e.amountMinor
      ? `${formatMinor(e.amountMinor, e.currency, locale)} ${e.currency}`
      : '';
    if (e.kind === 'debt_closed') return t('forecast.debtClosed', { name: e.name });
    if (e.kind === 'freed_money') return t('forecast.freed', { amount });
    if (e.kind === 'goal_reached') return t('forecast.goalReached', { name: e.name });
    // Регулярный платёж на горизонте: раньше лента знала только текущий период (#103).
    if (e.kind === 'recurring_due') return t('forecast.recurringDue', { name: e.name, amount });
    return t('forecast.goalRisk', { name: e.name, amount });
  };

  return (
    <Panel label={t('forecast.title')} accent="amber">
      {nothingAhead && (
        <div className="prow">
          <span />
          <span className="dim">{t('forecast.empty')}</span>
        </div>
      )}
      {/* Списания периода: они и так учтены в условии показа панели, значит должны быть видны. */}
      {data.dueSoon.slice(0, 4).map((d) => (
        <div className="prow" key={`due:${d.id}:${d.on}`}>
          <span className="prow-day">{d.on.slice(8, 10)}</span>
          <span className="prow-name">
            <span>{d.name}</span>
            <Tag>{t('forecast.dueSoon')}</Tag>
          </span>
          <span className="prow-num">
            <b>
              {formatMinor(d.amountMinor, d.currency, locale)} {d.currency}
            </b>
          </span>
          <span />
        </div>
      ))}
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
  const { data = [] } = useRevisions(!useIsMember());
  const undo = useUndoRevision();
  // Пустая история — «правок не было», а не «раздела нет»: текст для этого написан (#105).
  const noRevisions = data.length === 0;

  return (
    <Panel
      label={t('rev.title')}
      accent="amber"
      foot={undo.isError ? <span className="sub danger">{t('rev.cantUndo')}</span> : undefined}
    >
      {noRevisions && (
        <div className="prow">
          <span />
          <span className="dim">{t('rev.empty')}</span>
        </div>
      )}
      {data.map((rev) => {
        const first = rev.moves[0];
        return (
          <div className="prow" key={rev.id}>
            <span className="prow-day">{formatDate(rev.createdAt)}</span>
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

/**
 * Клетка верхней полосы. `slot` — не украшение, а имя роли: на телефоне полоса перестаёт быть
 * полосой и выстраивается по важности (цифра дня → диаграмма раздачи → остальное), и порядок
 * задаётся в CSS по этим именам, а не переставлением разметки под каждый экран.
 */
function Kpi({
  label,
  tag,
  slot,
  children,
}: {
  label: string;
  tag?: ReactNode;
  slot?: 'hero' | 'cascade' | 'left' | 'money' | 'exchange';
  children: ReactNode;
}) {
  return (
    <div className={slot ? `kpi kpi-${slot}` : 'kpi'}>
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
  // Участник совместного доступа: часть ручек ему закрыта, панели на них не строим (issue #46).
  const isMember = useIsMember();
  const forecast = useForecast();
  // Пересборка живёт в строке категории (там известно, сколько не хватает), поэтому баннер
  // риска не открывает свой модал, а раскрывает редактор категорий — оттуда один шаг до варианта.
  const [editingCats, setEditingCats] = useState(false);
  /* Правка дохода раскрывается на месте, как у категорий: уводить с плана на «Настройки» значило
     терять из виду то самое число, ради которого человек нажал «править». */
  const [editingIncome, setEditingIncome] = useState(false);
  // Подтверждение поступления (issue #48): открывается чипом «ждём» у конкретной выплаты.
  const [receiptFor, setReceiptFor] = useState<IncomeEventDto | null>(null);
  /*
   * Мастер-режим (issue #47) — не отдельный экран, а другой взгляд на тот же план: полгода вперёд
   * таблицей. Сам переключатель стоит в топбаре рядом с прочим управлением, а выбранный вид живёт
   * в адресе: экран его только читает.
   */
  const master = useRouterState({
    select: (s) => (s.location.search as { view?: string }).view === 'table',
  });
  const cancelReceipt = useCancelIncomeReceipt();
  // Остатки по счетам не запрашиваем, пока раздел скрыт: лишний запрос на каждом открытии плана.
  const balances = useBalances(!isMember && isSectionVisible('account'));

  const fmt = (m: string | bigint) => formatMinor(String(m), base, locale);
  const withCcy = (m: string | bigint) => `${fmt(m)} ${base}`;

  const buckets = plan.allocations.filter((a) => a.targetKind === 'bucket');
  const categories = plan.allocations.filter((a) => a.targetKind === 'category');
  const compressed = BigInt(plan.compressedMinor) > 0n;
  const living = BigInt(plan.livingMinor);
  const spentShare =
    living > 0n ? Number((BigInt(plan.spentLivingMinor) * 1000n) / living) / 10 : 0;
  const risky = !plan.burn.willLast && plan.burn.runsOutOn;

  // Что-то скрыто матрицей видимости (issue #46): пустота на экране объясняется этим, а не планом.
  const collapsedForViewer =
    plan.sharing !== undefined &&
    (plan.sharing.sums.length > 0 || BigInt(plan.sharing.hiddenMinor) > 0n);

  /* Скрытые разделы (см. lib/sections.ts) не рисуем и здесь: иначе цель исчезла бы из
     «Обязательств», но осталась панелью на плане — экраны разошлись бы между собой. */
  const obligationGroups = (['debt', 'envelope', 'goal', 'bucket'] as const)
    .filter((kind) => isSectionVisible(kind))
    .map((kind) => ({ kind, rows: plan.allocations.filter((a) => a.targetKind === kind) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className="dense dense-plan">
      {receiptFor && (
        <IncomeReceipt event={receiptFor} base={base} onClose={() => setReceiptFor(null)} />
      )}
      {/* Мастер-режим — другой взгляд на тот же план, а не второй экран рядом: панели уступают ему место. */}
      {master && !isMember && <MasterGrid />}
      {!master && (
        <>
          <div className="kpi-strip">
            {/*
              Счета без остатков раньше просто убирали KPI из полосы (#105): человек не понимал,
              пусто у него или раздел не существует. Текст для этого случая написан, показываем его
              на месте цифры — прочерк вместо суммы честнее пустоты.
            */}
            {isSectionVisible('account') && balances.data && (
              <Kpi label={t('acc.total')} slot="money">
                <span className="kpi-value">
                  {balances.data.totalMinor === null
                    ? '—'
                    : `${formatMinor(balances.data.totalMinor, base, locale)} ${base}`}
                </span>
                <div className="kpi-rows">
                  {balances.data.byCurrency.length === 0 && (
                    <div className="dim">{t('acc.empty')}</div>
                  )}
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
            <Kpi label={t('plan.kpi.left', { days: plan.daysLeft })} slot="left">
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

            <Kpi label={t('plan.kpi.canSpend')} slot="hero">
              <span className="kpi-value accent">
                {fmt(plan.canSpendPerDayMinor)}{' '}
                <span className="kpi-sub">{t('plan.kpi.perDay')}</span>
              </span>
              <span className="kpi-sub">
                {t('plan.today.until', {
                  date: formatDate(plan.period.endsOn),
                  days: plan.daysLeft,
                })}
                {BigInt(plan.bufferMinor) > 0n &&
                  ` · ${t('plan.kpi.buffer', { amount: withCcy(plan.bufferMinor) })}`}
              </span>
            </Kpi>

            <Kpi
              label={t('plan.summary.toExchange')}
              slot="exchange"
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

            <Kpi
              label={t('plan.kpi.cascade', { amount: withCcy(plan.incomeMinor) })}
              slot="cascade"
            >
              <CascadeDonut plan={plan} />
              <span className="kpi-sub">
                {t('plan.kpi.leftToLive')} <b className="mono">{withCcy(plan.livingMinor)}</b>
              </span>
            </Kpi>
          </div>

          {risky && (
            <div className="risk-band">
              <span className="risk-text">
                {t('signal.burn.title', { date: formatDate(plan.burn.runsOutOn!) })} ·{' '}
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

          {/* Карта показывает только помеченные платежи: тумблер убирает шум, «Что впереди» их знает. */}
          <PeriodMap
            plan={plan}
            dueSoon={forecast.data?.dueSoon.filter((d) => d.showOnMap)}
            events={forecast.data?.events}
          />

          <div className="panels">
            <div className="col">
              <Panel
                label={t('plan.panel.income')}
                sum={withCcy(plan.incomeMinor)}
                accent="lime"
                tools={
                  <button
                    type="button"
                    className="act"
                    aria-pressed={editingIncome}
                    onClick={() => setEditingIncome((v) => !v)}
                  >
                    {t('plan.act.edit')}
                  </button>
                }
              >
                {editingIncome && (
                  <div className="panel-inset">
                    <IncomeEditor base={base} locale={locale} />
                  </div>
                )}
                {!editingIncome && plan.income.events.length === 0 && (
                  <div className="prow">
                    <span />
                    <span className="dim">{t('common.empty')}</span>
                  </div>
                )}
                {!editingIncome &&
                  plan.income.events.map((e) => (
                    <div className="prow" key={`${e.sourceId}:${e.date}`}>
                      <span className="prow-day">{e.date.slice(8, 10)}</span>
                      <span className="prow-name">
                        <span>{e.label}</span>
                        {e.currency !== base && <Tag tone="vio">{e.currency}</Tag>}
                        {e.status === 'received' && (
                          <Tag tone="lime">{t('income.chip.received')}</Tag>
                        )}
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
                      {cancelReceipt.isError && (
                        <span className="prow-note danger">⚠ {t('common.error')}</span>
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
                  <div className="panel-inset">
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

              {/*
                Свёрнутое матрицей видимости (issue #46). Показывать обязательно: деньги, ушедшие
                из общего котла, не имеют права исчезнуть из плана — иначе у партнёра доход
                сходится, а раскладка нет, и виноватым выглядит продукт.
              */}
              {plan.sharing &&
                (plan.sharing.sums.length > 0 || BigInt(plan.sharing.hiddenMinor) > 0n) && (
                  <Panel label={t('share.collapsed')} accent="vio">
                    {plan.sharing.sums.map((s) => (
                      <div className="prow" key={s.section}>
                        <span className="prow-day" aria-hidden />
                        <span className="prow-name">
                          <span>{t('share.sumOf', { section: sectionLabel(t, s.section) })}</span>
                        </span>
                        <span className="prow-num">
                          <b>{withCcy(s.minor)}</b>
                        </span>
                        <span />
                      </div>
                    ))}
                    {BigInt(plan.sharing.hiddenMinor) > 0n && (
                      <div className="prow">
                        <span className="prow-day" aria-hidden />
                        <span className="prow-name">
                          <span>{t('share.private')}</span>
                        </span>
                        <span className="prow-num">
                          <b>{withCcy(plan.sharing.hiddenMinor)}</b>
                        </span>
                        <span />
                      </div>
                    )}
                  </Panel>
                )}

              {/*
                «Чистый лист» участнику не показываем: у него план не пустой, а свёрнутый, и
                ссылка «завести обязательство» ведёт туда, где он ничего не может.
              */}
              {obligationGroups.length === 0 && !collapsedForViewer && (
                /*
                 * Кнопка живёт в шапке панели, как у всех остальных: раньше она стояла внутри
                 * строки содержимого и висела не на той высоте, что «править» у соседей.
                 */
                <Panel
                  label={t('plan.empty.title')}
                  accent="amber"
                  tools={
                    <Link className="act" to="/obligations">
                      {t('nav.obligations')}
                    </Link>
                  }
                >
                  <div className="prow">
                    <span />
                    <span className="dim">{t('plan.empty.noPlan')}</span>
                  </div>
                  {/* Вторая строка объясняет, ЧТО сделать: одна только констатация пустоты не ведёт. */}
                  <div className="prow">
                    <span />
                    <span className="sub dim">{t('plan.empty.subtitle')}</span>
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
        </>
      )}
    </div>
  );
}

export function Plan() {
  const { t } = useI18n();
  /*
   * «Глазами участника» (issue #46): владелец проверяет, что именно увидит партнёр при выбранной
   * матрице видимости. Права при этом не меняются — сужается только показанное. Переключатель — в
   * топбаре, состояние — в адресе.
   */
  const asMember = useRouterState({
    select: (s) => (s.location.search as { as?: string }).as === 'member',
  });
  const { data: me } = useMe();
  /*
   * Обучение (issue #28). Показывается один раз владельцу и только когда план уже собран: тур по
   * пустому экрану бессмыслен — подсвечивать нечего. Флаг живёт в настройках воркспейса, чтобы с
   * телефона после ноутбука не начинался заново.
   */
  const { data: settings } = useSettings();
  const patchSettings = usePatchSettings();
  const [tourClosed, setTourClosed] = useState(false);
  const { data: plan, isLoading, error, refetch } = usePlan(true, asMember);
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
  const tourReady =
    !tourClosed &&
    me?.role === 'owner' &&
    settings !== undefined &&
    settings.tour.planDone === false;

  return (
    <>
      {tourReady && (
        <Tour
          steps={PLAN_TOUR}
          onFinish={() => {
            // Закрываем сразу, не дожидаясь сети: повторно показать тур поверх ответа — хамство.
            setTourClosed(true);
            patchSettings.mutate({ tour: { planDone: true } });
          }}
        />
      )}
      {plan.sharing?.previewAsMember && (
        <div className="risk-band info">{t('share.banner.preview')}</div>
      )}
      <PlanBody plan={plan} />
    </>
  );
}
