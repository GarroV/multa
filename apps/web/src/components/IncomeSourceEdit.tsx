import { useState } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { draftToPatch, sourceToDraft, type SourceDraft } from '../lib/income.ts';
import { usePatchIncomeSource, type IncomeSourceDto } from '../lib/queries.ts';
import { Hint } from './ui/Hint.tsx';
import { Select } from './ui/Select.tsx';
import { weekdayName } from './IncomeEditor.tsx';

/**
 * Правка источника дохода на месте (владелец, 11.08.2026: «а править ты не собираешься?»).
 *
 * Источник можно было только завести и удалить. Опечатка в названии чинилась удалением строки — а
 * вместе с источником уходили подтверждённые поступления, которые на него ссылаются. Ручка PATCH в
 * API была с самого начала; не было формы.
 *
 * Форма ровно та же, что у «добавить»: одни и те же поля в том же порядке. Две разные формы для
 * «завести» и «поправить» неизбежно разъезжаются — в одной появляется поле, в другой нет.
 *
 * Валюта не правится: суммы хранятся в minor units своей валюты, и смена валюты у существующей
 * строки молча переозначила бы записанное число (13 398 000 копеек стали бы центами). Валюту
 * меняют новой строкой, там сумма вводится заново.
 */
export function IncomeSourceEdit({
  source,
  locale,
  onDone,
}: {
  source: IncomeSourceDto;
  locale: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const patch = usePatchIncomeSource();
  const initial = sourceToDraft(source, source.currency);

  const [draft, setDraft] = useState<SourceDraft>(
    () => initial ?? { label: source.label, kind: 'monthly', day: 25, weekday: 5, amount: '' },
  );
  const [error, setError] = useState<string | null>(null);

  /*
   * Источник с процентом от оклада, с двумя числами в одной строке или с ритмом «раз в N недель»
   * эта форма не выражает. Показывать её всё равно значило бы при сохранении переписать человеку
   * модель дохода, поэтому у таких строк правится только название — а почему, говорит подсказка.
   */
  const nameOnly = initial === null;

  const save = () => {
    const label = draft.label.trim();
    if (!label) return setError(t('obl.needName'));
    const body = nameOnly ? { label } : draftToPatch(draft, source.currency);
    if (!body) return setError(t('settings.sourceIncomplete'));
    setError(null);
    patch.mutate({ id: source.id, body }, { onSuccess: onDone });
  };

  return (
    <div className="prow">
      <span className="prow-day" aria-hidden />
      <span className="prow-bar prow-bar-full">
        <span className="fx-form">
          <span className="form-row">
            <input
              className="field grow"
              aria-label={t('income.amounts.label')}
              placeholder={t('income.amounts.label')}
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            {!nameOnly && (
              <>
                <Select
                  className="field field-choice"
                  label={t('income.kind.legend')}
                  value={draft.kind}
                  onChange={(next) => setDraft({ ...draft, kind: next as SourceDraft['kind'] })}
                  options={[
                    { value: 'monthly', label: t('income.kind.monthly') },
                    { value: 'weekly', label: t('income.kind.weekly') },
                    { value: 'daily', label: t('income.kind.daily') },
                  ]}
                />
                {/*
                  Слот под уточнение ритма имеет постоянную ширину (жалоба владельца 13.08.2026:
                  «положение контекстного окна прыгает»). Раньше поле «число» появлялось и исчезало вместе
                  с видом ритма, строка перестраивалась, и выпадашка каждый раз оказывалась в новом месте.
                  Пустой слот в состоянии «каждый день» — не декорация, а обещание, что ряд не поедет.
                */}
                <span className="slot-rhythm">
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
                    <Select
                      className="field field-sm"
                      label={t('income.kind.weekday')}
                      value={String(draft.weekday)}
                      onChange={(next) => setDraft({ ...draft, weekday: Number(next) })}
                      options={[1, 2, 3, 4, 5, 6, 0].map((d) => ({
                        value: String(d),
                        label: weekdayName(d, locale),
                      }))}
                    />
                  )}
                </span>
                <input
                  className="field num field-sm"
                  inputMode="decimal"
                  aria-label={`${t('income.amounts.amount')} · ${source.currency}`}
                  placeholder={t('income.amounts.amount')}
                  value={draft.amount}
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value.replace(',', '.') })}
                />
              </>
            )}
            {nameOnly && <Hint text={t('income.editNameOnly')} />}
            <button type="button" className="btn" disabled={patch.isPending} onClick={save}>
              {t('common.save')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onDone}>
              {t('common.cancel')}
            </button>
          </span>
          {error && <span className="sub danger">{error}</span>}
          {patch.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
        </span>
      </span>
    </div>
  );
}
