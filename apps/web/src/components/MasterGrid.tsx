import { Link } from '@tanstack/react-router';
import { formatDate, formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { usePlanGrid, type GridCellDto, type GridGroupDto } from '../lib/queries.ts';

/**
 * Мастер-режим (issue #47) — та самая таблица, которую основатель вёл в Excel: строки статей
 * против периодов выплат.
 *
 * Два свойства, которые и делают её полезной:
 *
 * 1. **Она ничего не решает.** Все числа приходят из `GET /v1/plan/grid`; экран не делит, не
 *    складывает и не сжимает — иначе матрица и «План» разошлись бы, а спорят они про одни и те же
 *    деньги.
 * 2. **Ноль и «строки больше нет» выглядят по-разному.** Закрывшийся долг рисуется прочерком, а не
 *    нулём: иначе человек продолжит искать в таблице платёж, которого уже не существует, и не
 *    заметит главного — с этого месяца деньги освободились.
 *
 * Правка идёт из разделов («Обязательства», редактор категорий), а не по ячейке: вторая точка
 * ввода тех же сумм означала бы вторую правду о планах.
 */

const GROUP_LABEL = {
  income: 'plan.groups.income',
  debt: 'plan.groups.debt',
  bucket: 'obl.buckets',
  envelope: 'plan.groups.envelope',
  category: 'plan.groups.category',
  goal: 'plan.groups.goal',
} as const;

export function MasterGrid({ periods = 6 }: { periods?: number }) {
  const { t, locale } = useI18n();
  const { data, isPending, isError, refetch } = usePlanGrid(periods);

  if (isPending) return <div className="mgrid-note">{t('common.loading')}</div>;
  if (isError || !data) {
    return (
      <div className="mgrid-note">
        <span className="danger">{t('obl.loadFailed')}</span>{' '}
        <button type="button" className="act" onClick={() => void refetch()}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  const base = data.baseCurrency;
  const fmt = (minor: string) => formatMinor(minor, base, locale);
  const columns = data.periods.length;

  const cell = (c: GridCellDto, key: string) => (
    <span
      key={key}
      className={c.state === 'planned' ? 'mgrid-cell' : 'mgrid-cell mgrid-cell-off'}
      // Прочерк и ноль читаются одинаково глазами, но означают разное — озвучиваем разницу.
      title={c.state === 'ended' ? t('plan.master.ended') : undefined}
    >
      {c.state === 'planned' ? fmt(c.minor) : '—'}
    </span>
  );

  /* Куда идти заполнять раздел: доход — в настройки, остальное — на «Обязательства». */
  const SECTION_HREF: Record<string, string> = {
    income: '/settings',
    debt: '/obligations',
    bucket: '/obligations',
    envelope: '/obligations',
    goal: '/obligations',
  };

  const group = (g: GridGroupDto) => (
    <div className="mgrid-group" key={g.kind}>
      <div className="mgrid-row mgrid-row-head">
        <span className="mgrid-name">
          {t(GROUP_LABEL[g.kind])}
          {/* Пустой раздел — не украшение, а приглашение: строку заводят в своём разделе. */}
          {g.rows.length === 0 && SECTION_HREF[g.kind] && (
            <Link className="act mgrid-add" to={SECTION_HREF[g.kind]}>
              {t('plan.master.addRow')}
            </Link>
          )}
        </span>
        {g.totals.map((v, i) => (
          <span className="mgrid-cell" key={i}>
            {fmt(v)}
          </span>
        ))}
      </div>
      {/* Доход — одна строка на группу: разбивка по источникам живёт на «Плане». */}
      {g.kind !== 'income' &&
        g.rows.map((r) => (
          <div className="mgrid-row" key={r.targetId}>
            <span className="mgrid-name">
              {r.name}
              {r.sourceCurrency !== base && <i className="dim"> {r.sourceCurrency}</i>}
            </span>
            {r.cells.map((c, i) => cell(c, `${r.targetId}-${i}`))}
          </div>
        ))}
    </div>
  );

  return (
    <div className="mgrid-wrap">
      <div className="mgrid" style={{ ['--cols' as string]: columns }}>
        <div className="mgrid-row mgrid-row-periods">
          <span className="mgrid-name">{t('plan.master.col1')}</span>
          {data.periods.map((p) => (
            <span className="mgrid-cell" key={p.startsOn}>
              {formatDate(p.startsOn)}
              {p.materialized && <i className="mgrid-now">{t('plan.master.now')}</i>}
            </span>
          ))}
        </div>

        {data.groups.map(group)}

        <div className="mgrid-group mgrid-foot">
          <div className="mgrid-row">
            <span className="mgrid-name">{t('plan.master.toExchange')}</span>
            {data.footer.toExchangeMinor.map((v, i) => (
              <span className="mgrid-cell" key={i}>
                {fmt(v)}
              </span>
            ))}
          </div>
          {data.footer.toExchangeByCurrency.map((line) => (
            <div className="mgrid-row mgrid-row-sub" key={line.currency}>
              <span className="mgrid-name">→ {line.currency}</span>
              {line.cells.map((v, i) => (
                <span className="mgrid-cell" key={i}>
                  {fmt(v)}
                </span>
              ))}
            </div>
          ))}
          <div className="mgrid-row">
            <span className="mgrid-name">{t('plan.master.free')}</span>
            {data.footer.freeMinor.map((v, i) => (
              <span className={BigInt(v) < 0n ? 'mgrid-cell over' : 'mgrid-cell'} key={i}>
                {fmt(v)}
              </span>
            ))}
          </div>
          <div className="mgrid-row">
            <span className="mgrid-name">{t('plan.master.perDay')}</span>
            {data.footer.perDayMinor.map((v, i) => (
              <span className="mgrid-cell" key={i}>
                {fmt(v)}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Нерешённые строки не прячем: молчаливое исчезновение обязательства опаснее пустой ячейки. */}
      {data.unresolved.length > 0 && (
        <div className="mgrid-note st-warn">
          {t('plan.master.noRate', {
            list: data.unresolved.map((u) => `${u.name} (${u.sourceCurrency})`).join(', '),
          })}
        </div>
      )}
      <div className="mgrid-note">{t('plan.master.hint')}</div>
    </div>
  );
}
