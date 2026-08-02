import type { ReactNode } from 'react';
import { ExchangeEntry } from '../components/ExchangeEntry.tsx';
import { SignalsPanel } from '../components/SignalsPanel.tsx';
import { NoIncomeYet } from '../components/NoIncomeYet.tsx';
import { Bar, Panel, Tag } from '../components/ui/Panel.tsx';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  isOnboardingIncomplete,
  useCategoryAnalytics,
  useDeleteExchange,
  useExchangeOps,
  usePlan,
  useSettings,
  useSpread,
  type CategoryAnalyticsRow,
  type ExchangeOp,
  type PlanAllocation,
  type PlanDto,
  type ProviderStatsDto,
} from '../lib/queries.ts';
import { currencyMix, lockedSplit, planVsFact, spreadAverage } from '../lib/statsView.ts';

/**
 * Статистика (прототип, issue #30) — экран решений, а не графиков. Сверху лента сигналов: у
 * каждого метрика, причина и действие. Дальше метрики периода, структура расходов (сколько денег
 * связано обязательствами, в каких валютах живёт риск), советы по категориям от ядра и размен —
 * ввод, копилка потерь и история.
 *
 * Ни одной цифры экран не досчитывает: сигналы (#50), медиана по периодам (#51) и сравнение
 * провайдеров (#53) приходят готовыми сущностями, здесь только раскладка и подписи.
 */

function Centered({ children }: { children: ReactNode }) {
  return <div className="center-screen">{children}</div>;
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'accent' | 'over';
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className={tone ? `kpi-value ${tone}` : 'kpi-value'}>{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

function ExchangeRow({ op, locale }: { op: ExchangeOp; locale: string }) {
  const { t } = useI18n();
  const del = useDeleteExchange();
  const lost = op.spreadMinor !== null ? BigInt(op.spreadMinor) : null;
  const gain = lost !== null && lost < 0n;

  return (
    <div className="prow">
      <span className="prow-day">{op.occurredOn.slice(5)}</span>
      <span className="prow-name">
        <span className="mono">
          {formatMinor(op.fromMinor, op.fromCurrency, locale)} {op.fromCurrency}
          <span className="dim"> → </span>
          {formatMinor(op.toMinor, op.toCurrency, locale)} {op.toCurrency}
        </span>
        {/* Провайдер — метка сделки, заметка — комментарий к ней: разные поля, разные места. */}
        {op.provider && <Tag tone="vio">{op.provider}</Tag>}
      </span>
      <span className="prow-num">
        {lost === null ? (
          <i>{t('fx.spreadUnknown')}</i>
        ) : (
          <>
            <b className={gain ? 'st-ok' : 'st-warn'}>
              {gain ? '−' : ''}
              {formatMinor((gain ? -lost : lost).toString(), op.toCurrency, locale)} {op.toCurrency}
            </b>
            <i>
              {t('fx.rate')} {Number(op.actualRate).toFixed(4)}
              {op.spreadPct !== null && ` · ${op.spreadPct}%`}
            </i>
          </>
        )}
      </span>
      <button
        type="button"
        className="act"
        disabled={del.isPending}
        title={t('common.delete')}
        onClick={() => del.mutate(op.id)}
      >
        ✕
      </button>
      {op.note && <span className="prow-note">{op.note}</span>}
    </div>
  );
}

/** Совет ядра по категории: поднять план до медианы или опустить — с суммой и горизонтом. */
function AdviceRow({ a, base, locale }: { a: PlanAllocation; base: string; locale: string }) {
  const { t } = useI18n();
  if (!a.advice) return null;
  const amount = `${formatMinor(a.advice.suggestedMinor, base, locale)} ${base}`;
  return (
    <div className="prow">
      <span className="prow-day" aria-hidden />
      <span className="prow-name">
        <span>{a.name}</span>
        <Tag tone={a.advice.kind === 'raise' ? 'amber' : 'lime'}>
          {t(a.advice.kind === 'raise' ? 'stats.advice.raise' : 'stats.advice.lower')}
        </Tag>
      </span>
      <span className="prow-num">
        <b>{amount}</b>
        <i>{t('stats.advice.periods', { periods: a.advice.periods })}</i>
      </span>
      <span />
    </div>
  );
}

/** Столбики факта по периодам: значений мало, и каждое читается — линия здесь ничего не добавит. */
function Spark({
  series,
  plannedMinor,
}: {
  series: { spentMinor: string }[];
  plannedMinor: bigint;
}) {
  const values = [...series].reverse().map((p) => BigInt(p.spentMinor));
  const max = values.reduce((m, v) => (v > m ? v : m), plannedMinor > 0n ? plannedMinor : 1n);
  return (
    <span className="spark" aria-hidden>
      {values.map((v, i) => (
        <i
          key={i}
          className={plannedMinor > 0n && v > plannedMinor ? 'over' : undefined}
          style={{ ['--h' as string]: `${Math.max(6, Number((v * 100n) / max))}%` }}
        />
      ))}
    </span>
  );
}

/**
 * Где меняешь (issue #53) — вторая заявленная ценность продукта в её практическом виде: не «ты
 * потерял столько-то», а «у кого дешевле».
 *
 * Порог совета держит сервер (`confident`): при единичных сделках разница показывается, но фраза
 * про экономию не появляется — иначе интерфейс уговаривал бы сменить обменник по одному случаю.
 */
function ProviderPanel({ locale }: { locale: string }) {
  const { t } = useI18n();
  const { data, isError, refetch } = useSpread();

  if (isError) {
    return (
      <Panel label={t('fx.byProvider')} accent="vio">
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="danger">{t('obl.loadFailed')}</span>
          </span>
          <span className="prow-num" />
          <button type="button" className="act" onClick={() => void refetch()}>
            {t('common.retry')}
          </button>
        </div>
      </Panel>
    );
  }
  if (!data || data.providers.length === 0) return null;

  const volume = (stats: ProviderStatsDto) =>
    Object.entries(stats.volumeMinor)
      .map(([ccy, minor]) => `${formatMinor(minor, ccy, locale)} ${ccy}`)
      .join(' · ');

  const saving =
    data.confident && data.best && data.savingCurrency && BigInt(data.savingMinor) > 0n
      ? t('fx.saving', {
          provider: data.best.provider ?? '',
          amount: `${formatMinor(data.savingMinor, data.savingCurrency, locale)} ${data.savingCurrency}`,
        })
      : data.best && !data.confident
        ? t('fx.notEnoughDeals')
        : data.providers.length === 1
          ? t('fx.onlyOneProvider')
          : t('fx.markProvider');

  return (
    <Panel
      label={t('fx.byProvider')}
      slot="providers"
      sum={t('fx.byProvider.sub', { months: data.months })}
      accent="vio"
      foot={<span className="sub">{saving}</span>}
    >
      {data.providers.map((stats) => {
        const isBest = data.best !== null && stats.provider === data.best.provider;
        const isWorst = data.worst !== null && stats.provider === data.worst.provider && !isBest;
        return (
          <div className="prow" key={stats.provider ?? '—'}>
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              {/* Безымянная группа названа прямо: «пусто» читалось бы как сбой. */}
              <span className={stats.provider ? undefined : 'dim'}>
                {stats.provider ?? t('fx.noProvider')}
              </span>
              {isBest && <Tag tone="lime">{t('fx.cheapest')}</Tag>}
              {isWorst && <Tag tone="amber">{t('fx.priciest')}</Tag>}
            </span>
            <span className="prow-num">
              <b>{stats.avgSpreadPct.toFixed(2)}%</b>
              <i>{t('fx.deals', { count: stats.deals })}</i>
            </span>
            <span className="prow-note">{volume(stats)}</span>
          </div>
        );
      })}
    </Panel>
  );
}

/**
 * Категории против медианы факта (issue #51). Сравнение с медианой шести периодов, а не с одним:
 * один месяц с ремонтом не повод переписывать бюджет. Вердикт приходит с сервера — это доменное
 * правило ядра, а не подпись в разметке.
 */
function CategoryAnalyticsPanel({ base, locale }: { base: string; locale: string }) {
  const { t } = useI18n();
  // Горизонт не передаём: сервер берёт его из настроек воркспейса (issue #49). Иначе экран просил
  // бы шесть периодов даже при другой настройке, и вердикт здесь расходился бы с советом в плане.
  const { data = [], isError, refetch } = useCategoryAnalytics();
  const { data: settings } = useSettings();
  const horizon = settings?.signals.medianPeriods ?? 6;
  const withHistory = data.filter((r) => r.series.length > 0);
  // При сбое загрузки панель не исчезает молча: пустота и ошибка — разные сообщения.
  if (isError) {
    return (
      <Panel label={t('stats.byPeriods', { periods: horizon })} accent="cyan">
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="danger">{t('obl.loadFailed')}</span>
          </span>
          <span className="prow-num" />
          <button type="button" className="act" onClick={() => void refetch()}>
            {t('common.retry')}
          </button>
        </div>
      </Panel>
    );
  }
  if (withHistory.length === 0) return null;
  const hasVolatile = withHistory.some((r) => r.verdict === 'volatile');

  const tone = (verdict: CategoryAnalyticsRow['verdict']) =>
    verdict === 'volatile'
      ? 'mag'
      : verdict === 'raise'
        ? 'amber'
        : verdict === 'lower'
          ? 'lime'
          : 'quiet';

  return (
    <Panel
      label={t('stats.byPeriods', { periods: horizon })}
      slot="periods"
      accent="cyan"
      foot={hasVolatile ? <span className="sub">{t('stats.volatileHint')}</span> : undefined}
    >
      {withHistory.map((row) => (
        <div className="prow" key={row.categoryId}>
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span>{row.name}</span>
            <Tag tone={tone(row.verdict)}>{t(`stats.verdict.${row.verdict}`)}</Tag>
          </span>
          <span className="prow-num">
            <b>{formatMinor(row.medianMinor, base, locale)}</b>
            <i>
              {t('stats.plan')} {formatMinor(row.plannedMinor, base, locale)}
              {row.deltaPct !== null &&
                ` · ${row.deltaPct > 0 ? '+' : ''}${row.deltaPct.toFixed(0)}%`}
            </i>
          </span>
          <Spark series={row.series} plannedMinor={BigInt(row.plannedMinor)} />
        </div>
      ))}
    </Panel>
  );
}

function StatsBody({ plan }: { plan: PlanDto }) {
  const { t, locale } = useI18n();
  const base = plan.baseCurrency;
  const fx = useExchangeOps();

  const fmt = (m: string | bigint) => formatMinor(String(m), base, locale);
  const withCcy = (m: string | bigint) => `${fmt(m)} ${base}`;
  const pct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

  const locked = lockedSplit(plan);
  const mix = currencyMix(plan);
  const fact = planVsFact(plan);
  const spread = spreadAverage(fx.data?.ops ?? []);
  const advices = plan.allocations.filter((a) => a.advice);

  return (
    <div className="dense dense-stats">
      <div className="kpi-strip">
        <Metric
          label={t('stats.locked')}
          value={`${locked.lockedPct.toFixed(0)}%`}
          sub={t('stats.locked.sub', { amount: withCcy(locked.lockedMinor) })}
        />
        <Metric
          label={t('stats.planVsFact')}
          value={fact.deltaPct === null ? '—' : pct(fact.deltaPct)}
          sub={t('stats.planVsFact.sub', {
            spent: fmt(fact.spentMinor),
            plan: fmt(fact.plannedMinor),
          })}
          tone={fact.deltaPct !== null && fact.deltaPct > 0 ? 'over' : undefined}
        />
        <Metric
          label={t('stats.spread')}
          value={spread ? `${spread.pct.toFixed(1)}%` : '—'}
          sub={spread ? t('stats.spread.sub', { count: spread.count }) : t('fx.empty')}
        />
        <Metric
          label={t('plan.summary.perDay')}
          value={withCcy(plan.canSpendPerDayMinor)}
          sub={t('stats.burn.sub', { perDay: withCcy(plan.burn.perDayMinor) })}
          tone={plan.burn.willLast ? 'accent' : 'over'}
        />
      </div>

      <div className="panels">
        <div className="col">
          <SignalsPanel base={base} locale={locale} />

          <Panel label={t('stats.structure')} accent="vio" slot="structure">
            <div className="prow">
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span>{t('stats.structure.locked')}</span>
              </span>
              <span className="prow-num">
                <b>{locked.lockedPct.toFixed(0)}%</b>
                <i>{withCcy(locked.lockedMinor)}</i>
              </span>
              <span />
              <span className="prow-bar">
                <Bar share={locked.lockedPct} tone="vio" label={t('stats.structure.locked')} />
                <span className="prow-num">
                  <i>{t('stats.structure.flexible', { amount: withCcy(locked.flexibleMinor) })}</i>
                </span>
              </span>
            </div>
            {mix.map((m) => (
              <div className="prow" key={m.currency}>
                <span className="prow-day" aria-hidden />
                <span className="prow-name">
                  <span>{m.currency}</span>
                  {m.currency !== base && <Tag tone="vio">{t('stats.structure.fxRisk')}</Tag>}
                </span>
                <span className="prow-num">
                  <b>{m.pct.toFixed(0)}%</b>
                  <i>
                    {formatMinor(m.minor.toString(), base, locale)} {base}
                  </i>
                </span>
                <span />
                <span className="prow-bar">
                  <Bar
                    share={m.pct}
                    tone={m.currency === base ? 'cyan' : 'vio'}
                    label={m.currency}
                  />
                  <span />
                </span>
              </div>
            ))}
          </Panel>

          <CategoryAnalyticsPanel base={base} locale={locale} />

          <ProviderPanel locale={locale} />

          {advices.length > 0 && (
            <Panel
              label={t('stats.advice')}
              accent="amber"
              foot={<span className="sub">{t('stats.advice.hint')}</span>}
            >
              {advices.map((a) => (
                <AdviceRow key={a.targetId} a={a} base={base} locale={locale} />
              ))}
            </Panel>
          )}
        </div>

        <div className="col">
          <Panel
            label={t('fx.title')}
            sum={t('fx.totalLost')}
            accent="vio"
            foot={<ExchangeEntry />}
          >
            {(fx.data?.totalLost ?? []).map((l) => {
              const minor = BigInt(l.minor);
              const gain = minor < 0n;
              return (
                <div className="prow" key={l.currency}>
                  <span className="prow-day" aria-hidden />
                  <span className="prow-name">
                    <span>{l.currency}</span>
                    {gain && <Tag tone="lime">{t('fx.gain')}</Tag>}
                  </span>
                  <span className="prow-num">
                    <b className={gain ? 'st-ok' : 'st-warn'}>
                      {formatMinor((gain ? -minor : minor).toString(), l.currency, locale)}{' '}
                      {l.currency}
                    </b>
                  </span>
                  <span />
                </div>
              );
            })}
            {(fx.data?.totalLost ?? []).length === 0 && (
              <div className="prow">
                <span />
                <span className="dim">{t('fx.empty')}</span>
                <span />
                <span />
              </div>
            )}
          </Panel>

          <Panel label={t('fx.history')} accent="cyan">
            {/* Сбой загрузки — не «разменов не было»: иначе копилка потерь молча показывает ноль. */}
            {fx.isError && (
              <div className="prow">
                <span className="prow-day" aria-hidden />
                <span className="prow-name">
                  <span className="danger">{t('obl.loadFailed')}</span>
                </span>
                <span className="prow-num" />
                <button type="button" className="act" onClick={() => void fx.refetch()}>
                  {t('common.retry')}
                </button>
              </div>
            )}
            {!fx.isError && fx.data?.ops.length ? (
              fx.data.ops.map((op) => <ExchangeRow key={op.id} op={op} locale={locale} />)
            ) : !fx.isError ? (
              <div className="prow">
                <span />
                <span className="dim">{t('fx.empty')}</span>
                <span />
                <span />
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}

export function Statistics() {
  const { t } = useI18n();
  const { data: plan, isLoading, error, refetch } = usePlan(true);
  if (isLoading) return <Centered>{t('common.loading')}</Centered>;
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
  return <StatsBody plan={plan} />;
}
