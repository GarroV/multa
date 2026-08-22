import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n.tsx';
import { formatMinor } from '../../lib/format.ts';
import {
  axisMinGapPct,
  clusterMarks,
  markPosition,
  monthStartsWithin,
  todayInPeriod,
  windowEnd,
  type AxisMark,
} from '../../lib/planView.ts';
import type { ForecastEvent, PlanDto, RecurringDue } from '../../lib/queries.ts';

/**
 * Карта: всё, что случится в ближайшие три месяца, на одной оси — «сегодня», дата, на которой при
 * текущем темпе кончатся деньги, платежи по срокам, приходы дохода и границы периодов.
 *
 * Раньше ось была ровно один период, «от выплаты до выплаты» (запрос владельца 22.08.2026: «я чет
 * не вижу тут ближайших трёх месяцев как обсуждали»). Период — правильная единица для раздачи
 * денег, но не для взгляда вперёд: у человека с полумесячным ритмом такая ось кончалась через две
 * недели, и страховка через полтора месяца на ней не существовала. Окно в три месяца отвечает на
 * вопрос «что впереди», не подменяя таблицу с её горизонтом в 6–24 периода.
 *
 * Внутри окна видно, где кончается период: тонкие насечки по границам и подписи месяцев — без них
 * длинная ось превращается в линию с точками без системы координат.
 *
 * Метки, стоящие вплотную, схлопываются (`planView.clusterMarks`): подписи на оси иначе
 * наезжают друг на друга, и карта перестаёт читаться. Приоритет в тесной группе — у риска и
 * «сегодня», потому что именно они меняют решение.
 *
 * Насколько «вплотную» — зависит от ширины оси в пикселях, поэтому ось приходится измерять
 * (issue #87). Проценты сами по себе этого не знают: 9% ноутбука — это 130px, а 9% телефона —
 * 31px, и на телефоне подписи налезали друг на друга при формально том же зазоре.
 */

/** Сколько месяцев вперёд показывает карта (запрос владельца: «ближайшие три месяца»). */
const MONTHS_AHEAD = 3;

interface PeriodMapProps {
  plan: PlanDto;
  dueSoon?: RecurringDue[];
  events?: ForecastEvent[];
  /** Выплаты дальше текущего периода — из прогноза; без них ось за периодом пустая. */
  payouts?: { sourceId: string; label: string; on: string }[];
  /** Границы периодов на горизонте: по ним ставятся насечки. */
  periods?: { startsOn: string; endsOn: string }[];
}

export function PeriodMap({
  plan,
  dueSoon = [],
  events = [],
  payouts = [],
  periods = [],
}: PeriodMapProps) {
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

  /*
   * Окно считается от начала ТЕКУЩЕГО периода, а не от «сегодня»: человек смотрит на карту как на
   * продолжение этой выплаты, и уже прошедшие в периоде события (зарплата пришла, страховку
   * списали) остаются на своих местах, а не исчезают за левым краем.
   */
  const startsOn = plan.period.startsOn;
  const endsOn = windowEnd(startsOn, MONTHS_AHEAD);
  const at = (on: string) => markPosition(startsOn, endsOn, on);
  const inWindow = (on: string) => on >= startsOn && on <= endsOn;
  /* На трёхмесячной оси одного числа мало: «10» без месяца читается как ошибка. */
  const day = (on: string) => `${on.slice(8, 10)}.${on.slice(5, 7)}`;

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

  /*
   * Выплаты: в текущем периоде — из плана (там учтён факт прихода), дальше — из прогноза.
   * Дублирующиеся даты не страшны: ключ метки включает дату и источник, а плотные метки схлопнет
   * кластеризация.
   */
  for (const income of plan.income.events) {
    marks.push({
      key: `in:${income.sourceId}:${income.date}`,
      at: at(income.date),
      tone: 'income',
      label: `${day(income.date)} · ${income.label}`,
    });
  }
  const seenPayout = new Set(plan.income.events.map((e) => `${e.sourceId}:${e.date}`));
  for (const p of payouts) {
    if (!inWindow(p.on) || seenPayout.has(`${p.sourceId}:${p.on}`)) continue;
    marks.push({
      key: `pay:${p.sourceId}:${p.on}`,
      at: at(p.on),
      tone: 'income',
      label: `${day(p.on)} · ${p.label}`,
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

  /*
   * Из прогноза берём всё, что попадает в окно: списания дальше текущего периода (их карта раньше
   * не видела вовсе), закрытие долга и собранную цель. Ради таких предупреждений — «страховка
   * через полтора месяца» — окно и расширяли.
   */
  const seenDue = new Set(dueSoon.map((d) => `${d.id}:${d.on}`));
  for (const ev of events) {
    if (!inWindow(ev.on)) continue;
    if (ev.kind === 'recurring_due') {
      if (seenDue.has(`${ev.targetId}:${ev.on}`)) continue;
      marks.push({
        key: `evdue:${ev.targetId}:${ev.on}`,
        at: at(ev.on),
        tone: 'due',
        label: `${day(ev.on)} · ${ev.name}`,
      });
      continue;
    }
    if (ev.kind !== 'debt_closed' && ev.kind !== 'goal_reached') continue;
    marks.push({
      key: `ev:${ev.kind}:${ev.targetId}:${ev.on}`,
      at: at(ev.on),
      tone: 'fx',
      label: `${day(ev.on)} · ${ev.name}`,
    });
  }

  /* Границы периодов — насечки без подписей: система координат, а не события. */
  const ticks = periods
    .map((p) => p.startsOn)
    .filter((on) => inWindow(on) && on !== startsOn)
    .map((on) => ({ key: `tick:${on}`, at: at(on) }));

  /* Месяцы подписываем: на трёхмесячной оси без них не понять, куда смотришь. */
  const months = monthStartsWithin(startsOn, endsOn).map((on) => ({
    key: `mon:${on}`,
    at: at(on),
    label: new Date(`${on}T00:00:00Z`).toLocaleDateString(locale, {
      month: 'short',
      timeZone: 'UTC',
    }),
  }));

  const clusters = clusterMarks(marks, axisMinGapPct(axisPx));

  return (
    <div className="pmap">
      <span className="kpi-label">{t('plan.map.title')}</span>
      <div className="pmap-line" ref={lineRef}>
        {ticks.map((tick) => (
          <span
            key={tick.key}
            className="pmap-tick"
            style={{ ['--at' as string]: `${tick.at}%` }}
            aria-hidden
          />
        ))}
        {months.map((m) => (
          <span key={m.key} className="pmap-month" style={{ ['--at' as string]: `${m.at}%` }}>
            {m.label}
          </span>
        ))}
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
