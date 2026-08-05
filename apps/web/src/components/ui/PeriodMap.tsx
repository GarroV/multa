import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { formatMinor } from '../../lib/format.ts';
import {
  axisMinGapPct,
  clusterMarks,
  markPosition,
  todayInPeriod,
  type AxisMark,
} from '../../lib/planView.ts';
import type { ForecastEvent, PlanDto, RecurringDue } from '../../lib/queries.ts';

/**
 * Карта периода: всё, что случится между этой выплатой и следующей, на одной оси — «сегодня»,
 * дата, на которой при текущем темпе кончатся деньги, платежи по срокам и приход дохода.
 * Продукт живёт от выплаты до выплаты, поэтому ось — период, а не календарный месяц.
 *
 * Метки, стоящие вплотную, схлопываются (`planView.clusterMarks`): подписи на оси иначе
 * наезжают друг на друга, и карта перестаёт читаться. Приоритет в тесной группе — у риска и
 * «сегодня», потому что именно они меняют решение.
 *
 * Насколько «вплотную» — зависит от ширины оси в пикселях, поэтому ось приходится измерять
 * (issue #87). Проценты сами по себе этого не знают: 9% ноутбука — это 130px, а 9% телефона —
 * 31px, и на телефоне подписи налезали друг на друга при формально том же зазоре.
 */

interface PeriodMapProps {
  plan: PlanDto;
  dueSoon?: RecurringDue[];
  events?: ForecastEvent[];
}

export function PeriodMap({ plan, dueSoon = [], events = [] }: PeriodMapProps) {
  const { t, locale } = useI18n();
  /*
   * Ширина оси — внешняя величина: её задаёт вёрстка, а меняют поворот экрана, боковая панель и
   * смена шрифта. Поэтому измеряем до отрисовки (иначе первый кадр покажет наложение) и слушаем
   * изменения.
   */
  const lineRef = useRef<HTMLDivElement | null>(null);
  const [axisPx, setAxisPx] = useState(0);
  const measure = useCallback(() => {
    const w = lineRef.current?.getBoundingClientRect().width ?? 0;
    setAxisPx((prev) => (Math.abs(prev - w) > 1 ? w : prev));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = lineRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

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

  const clusters = clusterMarks(marks, axisMinGapPct(axisPx));

  return (
    <div className="pmap">
      <span className="kpi-label">{t('plan.map.title')}</span>
      <div className="pmap-line" ref={lineRef}>
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
