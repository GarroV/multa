import { useCallback, useRef, useState } from 'react';
import { fromMajor, money, toMajorString } from '@multa/core';
import type { TranslationKey } from '@multa/i18n';
import { ApiError } from '../lib/api.ts';
import { formatDate, formatMinor } from '../lib/format.ts';
import { GridAddRow } from './GridAddRow.tsx';
import { GridRowSettings } from './GridRowSettings.tsx';
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
import { useToday } from '../lib/useToday.ts';
import { isSectionVisible } from '../lib/sections.ts';
import {
  clampNameWidth,
  DEFAULT_NAME_WIDTH,
  MAX_NAME_WIDTH,
  MIN_NAME_WIDTH,
  nameWidthFrom,
  readNameWidth,
  writeNameWidth,
} from '../lib/gridColumnWidth.ts';

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

/**
 * Полосы месяцев над колонками периодов: подряд идущие периоды одного месяца сливаются в одну
 * ячейку шапки.
 *
 * Месяц берётся по дате НАЧАЛА периода. Период может перевалить через границу месяца (с 25.08 по
 * 09.09), и относить его к тому месяцу, в котором он начался, — то же самое, что делает человек,
 * говоря «выплата за август».
 *
 * Чистая функция, а не выкладка внутри разметки: границы месяцев — арифметика, и проверять её надо
 * отдельно от того, как она выглядит.
 */
export function monthBandsOf(
  periods: readonly { startsOn: string }[],
  today: string,
): { key: string; month: number; span: number; isCurrent: boolean }[] {
  const bands: { key: string; month: number; span: number; isCurrent: boolean }[] = [];
  const nowKey = today.slice(0, 7);

  for (const period of periods) {
    const key = period.startsOn.slice(0, 7);
    const last = bands.at(-1);
    if (last?.key === key) {
      last.span += 1;
      continue;
    }
    bands.push({
      key,
      month: Number(key.slice(5, 7)),
      span: 1,
      isCurrent: key === nowKey,
    });
  }
  return bands;
}

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
  /* Чью настройку открыли листом: нажатие на название строки (запрос владельца 22.08.2026). */
  const [settingsFor, setSettingsFor] = useState<{
    targetKind: string;
    targetId: string;
    name: string;
  } | null>(null);
  const edit = useEditGridCell(horizon);
  const propose = useCreateProposal();
  const isMember = useIsMember();
  const today = useToday();

  /*
   * Ширина колонки имён (issue #133). Начальное значение читается один раз при монтировании —
   * иначе каждый рендер лез бы в localStorage, а перетаскивание рендерит на каждый шаг курсора.
   */
  const [nameWidth, setNameWidth] = useState(() =>
    typeof window === 'undefined' ? DEFAULT_NAME_WIDTH : readNameWidth(window.localStorage),
  );
  /*
   * Актуальная ширина живёт и в ref. Обработчики читают её оттуда, а не из замыкания рендера: пять
   * нажатий стрелки подряд (зажатая клавиша даёт ~30 в секунду) приходят быстрее, чем React
   * перерисовывает, и каждое считало бы шаг от одного и того же старого значения — вместо плавного
   * роста колонка прыгала к границе. Поймано E2E, который посылает события серией без паузы.
   */
  const widthRef = useRef(nameWidth);
  const applyWidth = useCallback((px: number, persist: boolean) => {
    const clamped = clampNameWidth(px);
    widthRef.current = clamped;
    setNameWidth(clamped);
    // В хранилище пишем по концу жеста, а не на каждом кадре: 60 записей в секунду ему не нужны.
    if (persist && typeof window !== 'undefined') writeNameWidth(window.localStorage, clamped);
  }, []);

  /* Точка отсчёта жеста: дельта считается от неё, иначе за длинный жест копится ошибка округления. */
  const dragFrom = useRef<{ startWidth: number; startX: number } | null>(null);

  const onResizeStart = useCallback((e: React.PointerEvent<HTMLElement>) => {
    // Только основная кнопка: правый клик или тачпад-жест не должны начинать перетаскивание.
    if (e.button !== 0) return;
    e.preventDefault();
    dragFrom.current = { startWidth: widthRef.current, startX: e.clientX };
    /*
     * Захват указателя: без него курсор, ушедший с тонкой полосы хендла (а он уходит сразу — рука не
     * держит 6 пикселей), терял события, и колонка замирала на полпути.
     */
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onResizeMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const from = dragFrom.current;
      if (!from) return;
      applyWidth(nameWidthFrom({ ...from, clientX: e.clientX }), false);
    },
    [applyWidth],
  );

  const onResizeEnd = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!dragFrom.current) return;
      dragFrom.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      applyWidth(widthRef.current, true);
    },
    [applyWidth],
  );

  /* Клавиатура — не догонялка за мышью, а единственный способ для того, кто мышью не пользуется. */
  const onResizeKey = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 8;
      const next =
        e.key === 'ArrowLeft'
          ? widthRef.current - step
          : e.key === 'ArrowRight'
            ? widthRef.current + step
            : e.key === 'Home'
              ? DEFAULT_NAME_WIDTH
              : null;
      if (next === null) return;
      e.preventDefault();
      applyWidth(next, true);
    },
    [applyWidth],
  );

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

  /*
   * Отказ правки обязан быть виден (issue #154). Раньше результат мутации не смотрели вовсе, и
   * любой отказ сервера выглядел как «кнопка не сработала»: владелец правил сумму за интернет,
   * получал 400 (вида строки не было в схеме) и не видел ни числа, ни причины.
   *
   * Причина называется словами там, где она известна: без курса правку валютной строки принять
   * нельзя (#153), прошлый период — история, доход правится на «Плане».
   */
  const editErrorKey = (): TranslationKey | null => {
    if (!edit.isError) return null;
    const code = edit.error instanceof ApiError ? edit.error.code : '';
    if (code === 'rate_unavailable') return 'plan.master.editNoRate';
    if (code === 'cell_not_editable') return 'plan.master.editReadonly';
    if (code === 'period_is_past') return 'plan.master.editPast';
    return 'plan.master.editFailed';
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
  const monthBands = monthBandsOf(data.periods, today);

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
        /*
           Смысл правки у разных строк разный, и подпись говорит это прямо: бюджет периода у
           категории, «с этой даты и далее» у обязательства, «только в этом периоде» у регулярного
           платежа (issue #154). Одинаковые с виду ячейки, ведущие себя по-разному молча, хуже
           запрета на правку.
        */
        title={t(
          row.targetKind === 'category'
            ? 'plan.master.editCell'
            : row.targetKind === 'recurring'
              ? 'plan.master.editOnce'
              : 'plan.master.editFrom',
        )}
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
                {/*
                  Название — вход в настройки строки (валюта, повтор, срок, ступени). До этого за
                  ними приходилось уходить на другой экран и искать там ту же строку глазами, а
                  таблица оставалась «только числами». Участник настройки не правит — у него имя
                  остаётся текстом.
                */}
                {isMember ? (
                  <span className="mgrid-label">{r.name}</span>
                ) : (
                  <button
                    type="button"
                    className="mgrid-label mgrid-label-btn"
                    title={t('grid.row.settings')}
                    onClick={() =>
                      setSettingsFor({
                        targetKind: r.targetKind,
                        targetId: r.targetId,
                        name: r.name,
                      })
                    }
                  >
                    {r.name}
                  </button>
                )}
                {r.sourceCurrency !== base && <i className="dim"> {r.sourceCurrency}</i>}
              </span>
              {r.cells.map((c, i) =>
                /* Доход — «сколько придёт», а не план: правка там означала бы override
                   поступления, отдельное решение. Кнопка без ручки на сервере давала молчаливый
                   отказ (issue #154), поэтому доход рисуем обычной ячейкой. */
                g.kind === 'income'
                  ? cell(c, `${r.targetId}-${i}`)
                  : editableCell(c, `${r.targetId}-${i}`, r, i),
              )}
            </div>
          ))}
      </div>
    );
  };

  return (
    <div className="mgrid-wrap">
      {settingsFor && (
        <GridRowSettings row={settingsFor} locale={locale} onClose={() => setSettingsFor(null)} />
      )}
      <div
        className="mgrid"
        style={{ ['--cols' as string]: columns, ['--mgrid-name-w' as string]: `${nameWidth}px` }}
      >
        {/*
          Полоса месяцев над колонками периодов (запрос владельца 16.08.2026). Периоды короче
          месяца — при выплатах дважды в месяц их два на месяц, — и без этой полосы шесть дат
          подряд читаются как ровный ряд, где не за что зацепиться глазом. Месяц объединяет
          колонки и возвращает календарь, к которому человек привык.

          Текущий месяц подсвечен, и это заменило подпись «сейчас» у даты: свечение говорит то же
          самое, но не занимает место в ячейке и видно с одного взгляда на всю таблицу.
        */}
        <div className="mgrid-row mgrid-row-months">
          <span className="mgrid-name" aria-hidden />
          {monthBands.map((band) => (
            <span
              className={band.isCurrent ? 'mgrid-month mgrid-month-now' : 'mgrid-month'}
              key={band.key}
              style={{ gridColumn: `span ${band.span}` }}
            >
              {t(`month.${band.month}` as 'month.1')}
            </span>
          ))}
        </div>
        <div className="mgrid-row mgrid-row-periods">
          <span className="mgrid-name">
            {t('plan.master.col1')}
            {/*
              Хендл — один, в шапке колонки: он тянет границу на всю таблицу, а не одну строку.
              Роль `separator` с `aria-valuenow` — не украшение: без неё колонку нельзя раздвинуть с
              клавиатуры, а это единственный путь для того, кто мышью не пользуется.
            */}
            <span
              className="mgrid-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('plan.master.resize')}
              aria-valuenow={nameWidth}
              aria-valuemin={MIN_NAME_WIDTH}
              aria-valuemax={MAX_NAME_WIDTH}
              tabIndex={0}
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              onKeyDown={onResizeKey}
            />
          </span>
          {data.periods.map((p) => (
            <span className="mgrid-cell" key={p.startsOn}>
              {formatDate(p.startsOn)}
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
                /*
                  В ячейке два числа (запрос владельца 22.08.2026: «а где мне понять сколько евро мне
                  нужно?»). Сверху — сколько валюты купить: это ответ на вопрос, с которым человек
                  идёт в обменник. Снизу приглушённо — сколько базовой за неё уйдёт; строка «К
                  размену» над разбивкой считает то же в сумме по всем валютам.
                */
                <span className="mgrid-cell mgrid-cell-pair" key={i}>
                  <b className="mgrid-pair-main">
                    {formatMinor(line.amountCells[i] ?? '0', line.currency, locale)}
                  </b>
                  <i className="mgrid-pair-sub">{fmt(v)}</i>
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
        <span className={edit.isError ? 'st-warn' : undefined}>
          {edit.isError
            ? t(editErrorKey()!)
            : propose.isSuccess
              ? t('prop.sent')
              : t('plan.master.hint')}
        </span>
        {/*
          Выбор горизонта (вопрос владельца 16.08.2026: «почему показывает планирование всего на
          3 месяца?»). Длина периода у всех разная, поэтому считаем в периодах, а не в месяцах: при
          выплатах дважды в месяц 12 периодов это полгода, при ежемесячных — год. Сколько именно
          получилось, видно по датам в шапке.
        */}
        {/*
          Сегмент, а не россыпь кнопок: выбор взаимоисключающий, и общий контур говорит об этом
          сам. Компонент в продукте уже был (тема, язык) — переключатель горизонта его сначала
          проигнорировал, и получилась третья порода органов управления на том же экране.
        */}
        <span className="row row-gap-8">
          <span className="micro">{t('plan.master.horizon')}</span>
          <span className="seg" role="group" aria-label={t('plan.master.horizon')}>
            {[6, 12, 24].map((n) => (
              <button
                key={n}
                type="button"
                className="seg-btn"
                aria-pressed={n === horizon}
                onClick={() => setHorizon(n)}
              >
                {n}
              </button>
            ))}
          </span>
        </span>
      </div>
    </div>
  );
}
