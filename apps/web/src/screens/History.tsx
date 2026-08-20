import { useState } from 'react';
import { Panel, Tag } from '../components/ui/Panel.tsx';
import { Select } from '../components/ui/Select.tsx';
import { formatDate, formatMinor } from '../lib/format.ts';
import { groupByDay, historyTotals, matchesQuery } from '../lib/historyView.ts';
import { useI18n } from '../lib/i18n.tsx';
import { periodBounds, shiftPeriod } from '../lib/historyPeriods.ts';
import {
  useCategories,
  useDeleteSpend,
  useHistory,
  useMe,
  usePlan,
  type Transaction,
} from '../lib/queries.ts';

/**
 * История трат (issue #137, вопрос владельца: «где история трат у нас в проекте вообще?»).
 *
 * До этого экрана траты можно было записать, но не найти: последние показывал лист ввода, агрегаты
 * по категориям — «Статистика», а сам список существовал только в CSV-выгрузке. Человек вносил
 * четыре года импортом из Excel и шёл смотреть их обратно в Excel.
 *
 * Экран отвечает на три вопроса, в порядке частоты: «что я тратил в этом периоде», «сколько ушло
 * на еду в марте», «где та покупка, я помню только слово в заметке». Отсюда и устройство: период
 * листается, категория фильтруется на сервере, текст ищется по загруженному срезу.
 *
 * Ни одной суммы экран не считает сам — итоги дня и среза берутся из `historyView`, чтобы
 * арифметику можно было проверить тестом, а не глазами (правило 4).
 */

function Row({
  tx,
  base,
  locale,
  categoryName,
}: {
  tx: Transaction;
  base: string;
  locale: string;
  categoryName: string | undefined;
}) {
  const { t } = useI18n();
  const del = useDeleteSpend();
  const foreign = tx.currency !== base;

  return (
    <div className="prow">
      <span className="prow-day">{tx.occurredOn.slice(8, 10)}</span>
      <span className="prow-name">
        <span>{categoryName ?? t('spend.noCategory')}</span>
        {tx.kind === 'income' && <Tag tone="lime">{t('spend.kind.income')}</Tag>}
        {/*
          Заметка живёт здесь (issue #138): раньше её было видно только в списке внутри листа
          ввода — то есть человек писал комментарий, который потом негде прочитать.
        */}
        {tx.note && <span className="sub">· {tx.note}</span>}
        {del.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
      </span>
      <span className="prow-num">
        <b>
          {formatMinor(tx.amountMinor, tx.currency, locale)} {tx.currency}
        </b>
        {/* Валюта траты и сумма в базовой — рядом: курс дня уже вшит в запись и не пересчитывается. */}
        {foreign && (
          <i>
            = {formatMinor(tx.baseAmountMinor, base, locale)} {base}
          </i>
        )}
      </span>
      <span className="row row-tight">
        <button
          type="button"
          className="act"
          title={t('common.delete')}
          disabled={del.isPending}
          onClick={() => del.mutate(tx.id)}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

export function History() {
  const { t, locale } = useI18n();
  const me = useMe();
  /*
   * План нужен ровно за одним: узнать границы текущего периода, от которых отсчитываются
   * предыдущие. Запрашиваем, только когда воркспейс уже известен — иначе первый рендер шлёт запрос,
   * который заведомо ответит 409 «онбординг не завершён».
   */
  const plan = usePlan(me.data?.workspace != null);
  const { data: categories = [] } = useCategories();

  /*
   * Отсчёт периодов идёт от текущего периода плана, а не от календарного месяца: продукт живёт от
   * выплаты до выплаты, и «прошлый месяц» здесь означал бы не то, что человек видит на «Плане».
   */
  const [offset, setOffset] = useState(0);
  const [categoryId, setCategoryId] = useState<string>('');
  const [query, setQuery] = useState('');

  const base = me.data?.workspace?.baseCurrency ?? 'RUB';
  const current = plan.data?.period;
  const bounds = current ? shiftPeriod(periodBounds(current), offset) : null;

  const history = useHistory({
    ...(bounds ? { from: bounds.startsOn, to: bounds.endsOn } : {}),
    ...(categoryId ? { categoryId } : {}),
  });

  const rows = (history.data?.transactions ?? []).filter((tx) => matchesQuery(tx, query));
  const days = groupByDay(rows);
  const totals = historyTotals(rows);
  const nameOf = (id: string | null): string | undefined =>
    id ? categories.find((c) => c.id === id)?.name : undefined;

  return (
    <div className="dense">
      <Panel
        label={t('history.title')}
        accent="cyan"
        sum={t('history.total', {
          amount: `${formatMinor(totals.spentBaseMinor, base, locale)} ${base}`,
          rows: totals.rows,
        })}
        tools={
          <span className="row row-gap-6">
            {/* Листание периодов: «назад» всегда доступно, «вперёд» — только из прошлого. */}
            <button type="button" className="act" onClick={() => setOffset((n) => n - 1)}>
              ←
            </button>
            <span className="micro">
              {bounds
                ? `${formatDate(bounds.startsOn)} — ${formatDate(bounds.endsOn)}`
                : t('common.loading')}
            </span>
            <button
              type="button"
              className="act"
              disabled={offset >= 0}
              onClick={() => setOffset((n) => Math.min(0, n + 1))}
            >
              →
            </button>
          </span>
        }
      >
        <div className="form-row">
          <Select
            className="field field-choice"
            label={t('history.filter.category')}
            value={categoryId}
            onChange={setCategoryId}
            options={[
              { value: '', label: t('history.filter.all') },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <input
            className="field grow"
            placeholder={t('history.search.placeholder')}
            aria-label={t('history.search.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {history.isPending && <div className="prow-note">{t('common.loading')}</div>}
        {history.isError && (
          <div className="prow-note danger">
            ⚠ {t('common.error')}{' '}
            <button type="button" className="act" onClick={() => void history.refetch()}>
              {t('common.retry')}
            </button>
          </div>
        )}
        {/*
          Пустота объясняется причиной, а не одним словом: «трат нет» и «ничего не нашлось по
          запросу» — разные ответы, и второй подсказывает, что делать (сбросить фильтр).
        */}
        {!history.isPending && !history.isError && rows.length === 0 && (
          <div className="prow-note dim">
            {query.trim() || categoryId ? t('history.empty.filtered') : t('history.empty')}
          </div>
        )}

        {totals.incomeBaseMinor !== '0' && (
          <div className="prow-note dim">
            {t('history.income', {
              amount: `${formatMinor(totals.incomeBaseMinor, base, locale)} ${base}`,
            })}
          </div>
        )}

        {days.map((day) => (
          <div key={day.day}>
            {/* Заголовок дня со своим итогом: «в среду ушло 4 800» отвечает быстрее, чем сумма за период. */}
            <div className="prow mgrid-row-sub">
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span className="micro">{formatDate(day.day, { year: true })}</span>
              </span>
              <span className="prow-num">
                <i>
                  {formatMinor(day.totalBaseMinor, base, locale)} {base}
                </i>
              </span>
              <span />
            </div>
            {day.rows.map((tx) => (
              <Row
                key={tx.id}
                tx={tx}
                base={base}
                locale={locale}
                categoryName={nameOf(tx.categoryId)}
              />
            ))}
          </div>
        ))}
      </Panel>
    </div>
  );
}
