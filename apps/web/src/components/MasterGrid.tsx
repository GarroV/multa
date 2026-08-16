import { useState } from 'react';
import { fromMajor, money, toMajorString } from '@multa/core';
import { formatDate, formatMinor } from '../lib/format.ts';
import { GridAddRow } from './GridAddRow.tsx';
import { useI18n } from '../lib/i18n.tsx';
import {
  useCreateProposal,
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
  /* Свёрнутые закрытые разделы участника: имён нет, суммы есть (issue #84). Подпись та же, что в
     плане, — «Личное»: два разных слова для одного и того же читались бы как две разные вещи. */
  private: 'share.private',
  income: 'plan.groups.income',
  debt: 'plan.groups.debt',
  bucket: 'obl.buckets',
  envelope: 'plan.groups.envelope',
  category: 'plan.groups.category',
  goal: 'plan.groups.goal',
  recurring: 'plan.groups.recurring',
} as const;

export function MasterGrid({ periods = 12 }: { periods?: number }) {
  const { t, locale } = useI18n();
  /* Горизонт — состояние экрана: сколько периодов человек хочет видеть за раз. */
  const [horizon, setHorizon] = useState(periods);
  const { data, isPending, isError, refetch } = usePlanGrid(horizon);
  /* Сложенные разделы: состояние экрана, не домена, поэтому живёт здесь и не уезжает на сервер. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /*
   * Хуки правки — здесь, до ранних return. Первая версия ставила их ниже, после «загружается» и
   * «ошибка», и React падал с «rendered more hooks than during the previous render»: на первом
   * рендере с данными хуков становилось больше, чем на рендере загрузки. Экран уходил в белый лист.
   */
  const [editing, setEditing] = useState<string | null>(null);
  /* Какой раздел сейчас заводит строку: форма раскрывается под его шапкой, по одной за раз. */
  const [adding, setAdding] = useState<string | null>(null);
  const edit = useEditGridCell(horizon);
  const propose = useCreateProposal();
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
    const cell = {
      targetKind: row.targetKind,
      targetId: row.targetId,
      startsOn,
      plannedMinor: minor.toString(),
    };
    /*
     * Участник не пишет в план, а предлагает правку (issue #83): ячейка та же, ручка другая.
     * Так и задумано — правит строку только владелец, но заблокированное поле не объясняет, что
     * делать дальше, а «предложить» объясняет.
     */
    if (isMember) propose.mutate(cell);
    else edit.mutate(cell);
  };

  const fmt = (minor: string) => formatMinor(minor, base, locale);

  /**
   * Значение для правки: то же число, что человек видел, без дорисованной дробной части.
   *
   * `toMajorString` всегда печатает разряды до конца («0» становится «0.00», «133 980» —
   * «133980.00»), и в момент входа в ячейку цифры менялись на глазах, хотя ничего не произошло.
   * Разделители разрядов при вводе не нужны — их и не было, — а вот лишние нули убираем.
   */
  const editableMajor = (minor: string) =>
    toMajorString(money(BigInt(minor), base)).replace(/\.0+$/, '');
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
    if (!startsOn || c.state === 'ended') return cell(c, key);
    const isEditing = editing === key;

    if (isEditing) {
      return (
        <span className="mgrid-cell mgrid-cell-edit" key={key}>
          <input
            className="mgrid-input"
            inputMode="decimal"
            autoFocus
            /*
             * size={1} — не косметика, а единственное, что держит колонку на месте. Дорожка задана
             * `minmax(92px, max-content)`, и `max-content` у поля это его собственная ширина по
             * умолчанию — двадцать символов, то есть 184px. Колонка расширялась ровно вдвое, и поле
             * выезжало на соседнюю. Ширину задаёт CSS (100%), поэтому маленький size ничего не режет.
             */
            size={1}
            aria-label={`${row.name} · ${formatDate(startsOn)}`}
            defaultValue={c.state === 'planned' ? editableMajor(c.minor) : ''}
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
            {/*
              Плюс заводит строку прямо здесь (запрос владельца 16.08.2026: «если я хочу добавить
              долг то меня перекидывает на окно обязательств. так быть не должно»).
              Раньше это была ссылка на другой экран — человек терял из виду ту самую таблицу,
              ради которой пришёл. Плюс есть у любого раздела, не только у пустого: заводить
              вторую строку так же нормально, как первую.
            */}
            {SECTION_HREF[g.kind] && !isMember && (
              <button
                type="button"
                className="act act-icon mgrid-add"
                aria-label={t('plan.master.addRow')}
                title={t('plan.master.addRow')}
                aria-expanded={adding === g.kind}
                onClick={() => setAdding(adding === g.kind ? null : g.kind)}
              >
                <IconPlus />
              </button>
            )}
          </span>
          {g.totals.map((v, i) => (
            <span className="mgrid-cell" key={i}>
              {fmt(v)}
            </span>
          ))}
        </div>
        {/*
          Форма живёт под шапкой раздела, а не в отдельном окне: заведённая строка появляется тут
          же, следующей, и сразу видно, что она сделала с итогами периода.
        */}
        {adding === g.kind && (
          <div className="mgrid-row mgrid-row-add">
            <GridAddRow kind={g.kind} base={base} onDone={() => setAdding(null)} />
          </div>
        )}
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
      <div className="mgrid-note mgrid-hint">
        {/*
          Участнику нужен ответ на его правку (issue #83): предложение план не меняет, и без этой
          строки экран выглядит так, будто ввод не сработал — человек повторит его ещё раз.
        */}
        <span>{propose.isSuccess ? t('prop.sent') : t('plan.master.hint')}</span>
        {/*
          Выбор горизонта (вопрос владельца 16.08.2026: «почему показывает планирование всего на
          3 месяца?»). Длина периода у всех разная, поэтому считаем в периодах, а не в месяцах: при
          выплатах дважды в месяц 12 периодов это полгода, при ежемесячных — год. Сколько именно
          получилось, видно по датам в шапке.
        */}
        <span className="row row-8">
          <span className="micro">{t('plan.master.horizon')}</span>
          {[6, 12, 24].map((n) => (
            <button
              key={n}
              type="button"
              className={n === horizon ? 'act act-on' : 'act'}
              aria-pressed={n === horizon}
              onClick={() => setHorizon(n)}
            >
              {n}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}
