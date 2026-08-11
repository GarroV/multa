import { useState } from 'react';
import { fromMajor, toMajorString, money, type Currency } from '@multa/core';
import { useI18n } from '../lib/i18n.tsx';
import { Hint } from './ui/Hint.tsx';
import { usePatchRecurring, type RecurringItemDto } from '../lib/queries.ts';

/**
 * Срок платежа и смена суммы — за контекстным меню строки (решение владельца 06.08.2026).
 *
 * Оба поля нужны редко, а места в строке занимали бы всегда: «интернет 2 500 до октября, потом
 * 4 000» человек задаёт один раз и больше к этому не возвращается. Поэтому строка остаётся из
 * названия, повтора и суммы, а срок и ступени открываются по «…».
 *
 * «С» и «По» — это срок жизни платежа: до первой даты события нет, после последней оно перестаёт
 * появляться, но остаётся в истории. Ступени — другое: они не создают и не убирают платёж, а
 * меняют его сумму с даты. Разные вещи и выглядят по-разному, иначе их путают.
 */
export function RecurringMore({ item, onClose }: { item: RecurringItemDto; onClose: () => void }) {
  const { t } = useI18n();
  const patch = usePatchRecurring();
  const ccy = item.currency as Currency;

  const [from, setFrom] = useState(item.startsOn ?? '');
  const [to, setTo] = useState(item.endsOn ?? '');
  const [steps, setSteps] = useState(() =>
    (item.amountSteps ?? []).map((s) => ({
      from: s.from,
      amount: toMajorString(money(BigInt(s.amountMinor), ccy)),
    })),
  );
  const [reserve, setReserve] = useState(item.reserve);
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const parsed: { from: string; amountMinor: string }[] = [];
    for (const step of steps) {
      // Пустую строку молча выбрасываем: человек мог добавить ступень и передумать.
      if (!step.from && !step.amount.trim()) continue;
      if (!step.from) return setError(t('rec.steps.add'));
      try {
        parsed.push({
          from: step.from,
          amountMinor: fromMajor(step.amount.trim().replace(',', '.'), ccy).minor.toString(),
        });
      } catch {
        return setError(t('spend.badAmount'));
      }
    }
    setError(null);
    patch.mutate(
      {
        id: item.id,
        // null снимает ограничение; пустая строка из поля даты означает именно это.
        startsOn: from || null,
        endsOn: to || null,
        amountSteps: parsed,
        reserve,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="prow">
      <span className="prow-day" aria-hidden />
      <span className="prow-bar prow-bar-full">
        <span className="fx-form">
          <span className="form-row">
            <label className="sub dim" htmlFor={`from-${item.id}`}>
              {t('rec.from')}
            </label>
            <input
              id={`from-${item.id}`}
              className="field"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <label className="sub dim" htmlFor={`to-${item.id}`}>
              {t('rec.to')}
            </label>
            <input
              id={`to-${item.id}`}
              className="field"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </span>

          <label className="row row-check">
            <input
              type="checkbox"
              checked={reserve}
              onChange={(e) => setReserve(e.target.checked)}
            />
            <span className="sub">{t('rec.reserve')}</span>
            {/* Почему не включено сразу — под знаком: иначе деньги посчитались бы дважды. */}
            <Hint text={t('rec.reserve.hint')} />
          </label>

          <span className="row row-6">
            <span className="sub dim">{t('rec.steps')}</span>
            <Hint text={t('rec.steps.hint')} />
          </span>
          {steps.map((step, i) => (
            <span className="form-row" key={i}>
              <input
                className="field"
                type="date"
                aria-label={t('rec.from')}
                value={step.from}
                onChange={(e) =>
                  setSteps(steps.map((s, j) => (i === j ? { ...s, from: e.target.value } : s)))
                }
              />
              <input
                className="field num field-w-lg"
                inputMode="decimal"
                aria-label={t('rec.amount')}
                placeholder={t('rec.amount')}
                value={step.amount}
                onChange={(e) =>
                  setSteps(steps.map((s, j) => (i === j ? { ...s, amount: e.target.value } : s)))
                }
              />
              <button
                type="button"
                className="act"
                aria-label={t('common.delete')}
                onClick={() => setSteps(steps.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </span>
          ))}

          <span className="form-row">
            <button
              type="button"
              className="act"
              onClick={() => setSteps([...steps, { from: '', amount: '' }])}
            >
              + {t('rec.steps.add')}
            </button>
            <button type="button" className="btn" disabled={patch.isPending} onClick={save}>
              {t('common.save')}
            </button>
            <button type="button" className="act" onClick={onClose}>
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
