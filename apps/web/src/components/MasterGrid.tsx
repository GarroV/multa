import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { fromMajor, money, toMajorString } from '@multa/core';
import { formatDate, formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  useEditGridCell,
  usePlanGrid,
  type GridCellDto,
  type GridGroupDto,
} from '../lib/queries.ts';
import { IconPlus } from './ui/icons.tsx';
import { useIsMember } from '../lib/role.ts';
import { isSectionVisible } from '../lib/sections.ts';

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
 *
 * Разделы разворачиваются (запрос владельца 2026-08-05): итог сверху отвечает «сколько», строки
 * под ним — «из чего». Раскрыты по умолчанию, потому что таблицу открывают ради разбивки; сложить
 * её можно, когда мешает. Доход раньше разбивки не имел вовсе — теперь у него строка на источник.
 */

const GROUP_LABEL = {
  income: 'plan.groups.income',
  debt: 'plan.groups.debt',
  bucket: 'obl.buckets',
  envelope: 'plan.groups.envelope',
  category: 'plan.groups.category',
  goal: 'plan.groups.goal',
  recurring: 'plan.groups.recurring',
} as const;

export function MasterGrid({ periods = 6 }: { periods?: number }) {
  const { t, locale } = useI18n();
  const { data, isPending, isError, refetch } = usePlanGrid(periods);
  /* Сложенные разделы: состояние экрана, не домена, поэтому живёт здесь и не уезжает на сервер. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /*
   * Хуки правки — здесь, до ранних return. Первая версия ставила их ниже, после «загружается» и
   * «ошибка», и React падал с «rendered more hooks than during the previous render»: на первом
   * рендере с данными хуков становилось больше, чем на рендере загрузки. Экран уходил в белый лист.
   */
  const [editing, setEditing] = useState<string | null>(null);
  const edit = useEditGridCell(periods);
  const isMember = useIsMember();

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

  /**
   * Записывает правку. Пустое поле и ноль означают «нет плана» — это не ошибка ввода, а способ
   * убрать строку из периода, поэтому нуль отправляется как есть, а мусор молча не отправляется.
   */
  const commit = (row: { targetKind: string; targetId: string }, startsOn: string, raw: string) => {
    setEditing(null);
    const text = raw.trim().replace(',', '.');
    let minor: bigint;
    if (text === '') {
      minor = 0n;
    } else {
      try {
        minor = fromMajor(text, base).minor;
      } catch {
        // Мусор не отправляем и не ругаемся: человек нажал Esc мимо или начал вводить и передумал.
        return;
      }
    }
    edit.mutate({
      targetKind: row.targetKind,
      targetId: row.targetId,
      startsOn,
      plannedMinor: minor.toString(),
    });
  };

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

  /**
   * Ячейка, которую можно поправить прямо в таблице (запрос владельца 13.08.2026).
   *
   * Правится не всё: доход в сетке — это «сколько придёт», а не план, и правка там означала бы
   * override поступления — отдельное решение. Итоги выводятся из строк и правке не подлежат вовсе.
   *
   * Смысл правки зависит от природы строки, и подпись это говорит прямо: у категории — бюджет
   * этого периода, у долга и накопления — «с этой даты и далее». Молча вести себя по-разному в
   * одинаковых с виду ячейках хуже, чем не давать править совсем.
   */
  const editableCell = (
    c: GridCellDto,
    key: string,
    row: { targetKind: string; targetId: string; name: string },
    index: number,
  ) => {
    const startsOn = data.periods[index]?.startsOn;
    if (!startsOn || c.state === 'ended' || isMember) return cell(c, key);
    const isEditing = editing === key;

    if (isEditing) {
      return (
        <span className="mgrid-cell mgrid-cell-edit" key={key}>
          <input
            className="mgrid-input"
            inputMode="decimal"
            autoFocus
            aria-label={`${row.name} · ${formatDate(startsOn)}`}
            defaultValue={c.state === 'planned' ? toMajorString(money(BigInt(c.minor), base)) : ''}
            onBlur={(e) => commit(row, startsOn, e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(row, startsOn, e.currentTarget.value);
              }
              // Esc возвращает прежнее значение: правка денег должна быть отменяемой одной клавишей.
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(null);
              }
            }}
          />
        </span>
      );
    }

    return (
      <button
        type="button"
        key={key}
        className={
          c.state === 'planned'
            ? 'mgrid-cell mgrid-cell-btn'
            : 'mgrid-cell mgrid-cell-off mgrid-cell-btn'
        }
        title={t(row.targetKind === 'category' ? 'plan.master.editCell' : 'plan.master.editFrom')}
        onClick={() => setEditing(key)}
      >
        {c.state === 'planned' ? fmt(c.minor) : '—'}
      </button>
    );
  };

  /*
   * Куда идти заполнять раздел. Доход и категории правятся на самом «Плане» (панели), остальное —
   * на «Обязательствах». Пустые категории раньше не предлагали ничего: у них не было адреса, и
   * единственный раздел без плюса выглядел как недоделка, а не как правило.
   */
  const SECTION_HREF: Record<string, string> = {
    income: '/plan',
    debt: '/obligations',
    bucket: '/obligations',
    envelope: '/obligations',
    category: '/plan',
    goal: '/obligations',
  };

  const group = (g: GridGroupDto) => {
    const open = collapsed[g.kind] !== true;
    const label = t(GROUP_LABEL[g.kind]);
    return (
      <div className="mgrid-group" key={g.kind}>
        <div className="mgrid-row mgrid-row-head">
          <span className="mgrid-name">
            {g.rows.length > 0 ? (
              <button
                type="button"
                className="mgrid-toggle"
                aria-expanded={open}
                onClick={() => setCollapsed((prev) => ({ ...prev, [g.kind]: open }))}
              >
                {/* Треугольник — общий знак «здесь есть что раскрыть»; смысл несёт aria-expanded. */}
                <span className="mgrid-chev" aria-hidden>
                  {open ? '▾' : '▸'}
                </span>
                <span className="mgrid-label">{label}</span>
                {!open && <span className="dim"> · {g.rows.length}</span>}
              </button>
            ) : (
              <span className="mgrid-label">{label}</span>
            )}
            {/* Группа вне итогов обязана это сказать: иначе таблица врёт молча (issue #80). */}
            {g.informational && (
              <span className="dim mgrid-note-inline">{t('plan.master.notInTotals')}</span>
            )}
            {/* Пустой раздел — не украшение, а приглашение: строку заводят в своём разделе. */}
            {g.rows.length === 0 && SECTION_HREF[g.kind] && (
              <Link
                className="act act-icon mgrid-add"
                to={SECTION_HREF[g.kind]}
                aria-label={t('plan.master.addRow')}
                title={t('plan.master.addRow')}
              >
                <IconPlus />
              </Link>
            )}
          </span>
          {g.totals.map((v, i) => (
            <span className="mgrid-cell" key={i}>
              {fmt(v)}
            </span>
          ))}
        </div>
        {open &&
          g.rows.map((r) => (
            <div className="mgrid-row mgrid-row-item" key={r.targetId}>
              <span className="mgrid-name">
                <span className="mgrid-label">{r.name}</span>
                {r.sourceCurrency !== base && <i className="dim"> {r.sourceCurrency}</i>}
              </span>
              {r.cells.map((c, i) => editableCell(c, `${r.targetId}-${i}`, r, i))}
            </div>
          ))}
      </div>
    );
  };

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

        {/* Скрытые разделы (lib/sections.ts) не выводим: пустая строка «ЦЕЛИ» с плюсом вела бы в
            раздел, которого на экране больше нет. */}
        {data.groups.filter((g) => isSectionVisible(g.kind)).map(group)}

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
