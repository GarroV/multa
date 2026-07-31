import { useI18n } from '../../lib/i18n.tsx';
import { formatMinor } from '../../lib/format.ts';
import { clusterMarks, markPosition, todayInPeriod, type AxisMark } from '../../lib/planView.ts';
import type { ForecastEvent, PlanDto, RecurringDue } from '../../lib/queries.ts';

/**
 * Карта периода: всё, что случится между этой выплатой и следующей, на одной оси — «сегодня»,
 * дата, на которой при текущем темпе кончатся деньги, платежи по срокам и приход дохода.
 * Продукт живёт от выплаты до выплаты, поэтому ось — период, а не календарный месяц.
 *
 * Метки, стоящие вплотную, схлопываются (`planView.clusterMarks`): подписи на оси иначе
 * наезжают друг на друга, и карта перестаёт читаться. Приоритет в тесной группе — у риска и
 * «сегодня», потому что именно они меняют решение.
 */

/** Минимальный зазор между подписями, проценты ширины оси. Подобран под подпись ~140px. */
const MIN_GAP_PCT = 9;

interface PeriodMapProps {
  plan: PlanDto;
  dueSoon?: RecurringDue[];
  events?: ForecastEvent[];
}

export function PeriodMap({ plan, dueSoon = [], events = [] }: PeriodMapProps) {
  const { t, locale } = useI18n();
  const { startsOn, endsOn } = plan.period;
  const at = (on: string) => markPosition(startsOn, endsOn, on);
  const day = (on: string) => on.slice(8, 10);

  const marks: AxisMark[] = [
    { key: 'today', at: at(todayInPeriod(plan)), tone: 'today', label: t('plan.map.today') },
  ];

  if (plan.burn.runsOutOn && !plan.burn.willLast) {
    marks.push({
      key: 'runout',
      at: at(plan.burn.runsOutOn),
      tone: 'risk',
      label: t('plan.map.runsOut', { day: day(plan.burn.runsOutOn) }),
    });
  }

  for (const income of plan.income.events) {
    marks.push({
      key: `in:${income.sourceId}:${income.date}`,
      at: at(income.date),
      tone: 'income',
      label: `${day(income.date)} · ${income.label}`,
    });
  }

  for (const due of dueSoon) {
    marks.push({
      key: `due:${due.id}:${due.on}`,
      at: at(due.on),
      tone: 'due',
      label: `${day(due.on)} · ${due.name} ${formatMinor(due.amountMinor, due.currency, locale)} ${due.currency}`,
    });
  }

  // Из прогноза берём только вехи внутри периода — «цель закрыта в октябре» на этой оси не живёт.
  for (const ev of events) {
    if (ev.kind !== 'debt_closed' && ev.kind !== 'goal_reached') continue;
    if (ev.on < startsOn || ev.on > endsOn) continue;
    marks.push({
      key: `ev:${ev.kind}:${ev.targetId}`,
      at: at(ev.on),
      tone: 'fx',
      label: `${day(ev.on)} · ${ev.name}`,
    });
  }

  const clusters = clusterMarks(marks, MIN_GAP_PCT);

  return (
    <div className="pmap">
      <span className="kpi-label">{t('plan.map.title')}</span>
      <div className="pmap-line">
        {clusters.map((c) => (
          <span key={c.lead.key} className="pmap-mark" style={{ ['--at' as string]: `${c.at}%` }}>
            <span
              className={c.lead.tone === 'today' ? 'pmap-dot' : `pmap-dot ${c.lead.tone}`}
              aria-hidden
            />
            <span className={c.lead.tone === 'today' ? 'pmap-cap now' : 'pmap-cap'}>
              {c.lead.label}
              {c.hidden > 0 && <span className="dim"> +{c.hidden}</span>}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
