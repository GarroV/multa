import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { draftToSource, type SourceDraft } from '../lib/income.ts';
import { useCreateIncomeSource, useDeleteIncomeSource, useIncomeSources } from '../lib/queries.ts';
import { Tag } from './ui/Panel.tsx';
import { Hint } from './ui/Hint.tsx';

/**
 * Редактор источников дохода (перенесён из «Настроек» по решению владельца 2026-08-05).
 *
 * Причина переноса: доход правят, глядя на план, а не на страницу настроек. Раньше «править» у
 * панели дохода уводило на другой экран, и человек терял из виду то самое число, ради которого
 * пришёл. Теперь панель ведёт себя как категории: правка раскрывается на месте.
 *
 * Ритм выплат остался в «Настройках» и здесь только упоминается ссылкой: он задаёт границы
 * периодов всему плану, а не одному источнику, и править его из панели дохода значило бы менять
 * ось всей таблицы кнопкой в её углу.
 */
export function IncomeEditor({ base, locale }: { base: string; locale: string }) {
  const { t } = useI18n();
  const { data: sources = [], isError, refetch } = useIncomeSources(true);
  const addSource = useCreateIncomeSource();
  const removeSource = useDeleteIncomeSource();

  const [draft, setDraft] = useState<SourceDraft>({
    label: '',
    kind: 'monthly',
    day: 25,
    weekday: 5,
    amount: '',
  });
  const payload = draftToSource(draft, { currency: base, sort: sources.length });

  return (
    <div className="inc-editor">
      {/* Сбой загрузки не выдаём за «пусто»: иначе человек заведёт источник дохода второй раз. */}
      {isError && (
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
      )}

      {sources.map((s) => (
        <div className="prow" key={s.id}>
          <span className="prow-day">{scheduleLabel(s.schedule, locale, t)}</span>
          <span className="prow-name">
            <span>{s.label}</span>
            {s.stability === 'variable' && <Tag tone="amber">{t('income.variable')}</Tag>}
            {s.currency !== base && <Tag tone="vio">{s.currency}</Tag>}
          </span>
          <span className="prow-num">
            <b>
              {amountLabel(s.amount, s.currency, locale)} {s.currency}
            </b>
          </span>
          <button
            type="button"
            className="act"
            aria-label={t('common.delete')}
            disabled={removeSource.isPending}
            onClick={() => removeSource.mutate(s.id)}
          >
            ✕
          </button>
        </div>
      ))}

      <div className="fx-form">
        <div className="form-row">
          <input
            className="field grow"
            aria-label={t('income.amounts.label')}
            placeholder={t('income.amounts.label')}
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
          <select
            className="field field-sm"
            aria-label={t('income.kind.legend')}
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as SourceDraft['kind'] })}
          >
            <option value="monthly">{t('income.kind.monthly')}</option>
            <option value="weekly">{t('income.kind.weekly')}</option>
            <option value="daily">{t('income.kind.daily')}</option>
          </select>
          {/* Ежедневному доходу день не нужен: поле, которое ни на что не влияет, только врёт. */}
          {draft.kind === 'monthly' && (
            <input
              className="field num field-ccy"
              inputMode="numeric"
              aria-label={t('income.amounts.day')}
              value={draft.day}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                setDraft({ ...draft, day: n >= 1 && n <= 31 ? n : draft.day });
              }}
            />
          )}
          {draft.kind === 'weekly' && (
            <select
              className="field field-sm"
              aria-label={t('income.kind.weekday')}
              value={draft.weekday}
              onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <option value={d} key={d}>
                  {weekdayName(d, locale)}
                </option>
              ))}
            </select>
          )}
          <input
            className="field num field-sm"
            inputMode="decimal"
            aria-label={`${t('income.amounts.amount')} · ${base}`}
            placeholder={t('income.amounts.amount')}
            value={draft.amount}
            onChange={(e) => setDraft({ ...draft, amount: e.target.value.replace(',', '.') })}
          />
          <button
            type="button"
            className="btn"
            disabled={addSource.isPending || !payload}
            onClick={() =>
              payload &&
              addSource.mutate(payload, {
                onSuccess: () => setDraft({ ...draft, label: '', amount: '' }),
              })
            }
          >
            {t('common.add')}
          </button>
        </div>
        {/* Ввод, из которого не собирается источник, не должен выглядеть как «кнопка сломалась». */}
        {!payload && (draft.label.trim() !== '' || draft.amount.trim() !== '') && (
          <span className="sub danger">{t('settings.sourceIncomplete')}</span>
        )}
        {addSource.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
        {removeSource.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
        <span className="row row-6">
          <Hint text={t('income.editor.rhythmHint')} />
          <Link className="act" to="/settings">
            {t('settings.rhythm')}
          </Link>
        </span>
      </div>
    </div>
  );
}

/** Короткое имя дня недели в языке интерфейса: 0 — воскресенье, как у `Date.getUTCDay`. */
export function weekdayName(weekday: number, locale: string): string {
  // 2026-08-02 — воскресенье; сдвигом от него получаем любой день недели без таблицы имён.
  const date = new Date(Date.UTC(2026, 7, 2 + weekday));
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(date);
}

/** Читаемое расписание источника: число месяца, день недели, «кажд.» или прочерк. */
export function scheduleLabel(
  schedule: unknown,
  locale: string,
  t: (key: 'income.kind.dailyShort') => string,
): string {
  const s = schedule as {
    kind?: string;
    days?: number[];
    weeks?: number;
    date?: string;
    weekday?: number;
  };
  if (s?.kind === 'monthly-days') return (s.days ?? []).join(', ');
  if (s?.kind === 'every-weeks') return `×${s.weeks}`;
  if (s?.kind === 'one-off') return s.date ?? '—';
  if (s?.kind === 'daily') return t('income.kind.dailyShort');
  if (s?.kind === 'weekly') return weekdayName(s.weekday ?? 1, locale);
  return '—';
}

/**
 * Сумма источника для списка. Формат — как везде в колонке сумм (разряды, локаль): raw-major
 * давал «190000.00» рядом с «190,000» в плане, и глазом это читалось как разные числа.
 */
export function amountLabel(amount: unknown, currency: string, locale: string): string {
  const a = amount as { kind?: string; amountMinor?: string; percent?: string };
  if (a?.kind === 'percent') return `${a.percent}%`;
  if (a?.kind === 'absolute' && a.amountMinor) return formatMinor(a.amountMinor, currency, locale);
  return '—';
}
