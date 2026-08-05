import { fromMajor } from '@multa/core';
import { useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useConfirmIncome, type IncomeEventDto } from '../lib/queries.ts';

/**
 * Поступление дохода (issue #48). Открывается чипом «ждём» у выплаты: сколько пришло на самом деле,
 * какого числа и по какому курсу, если валюта не базовая.
 *
 * Курс спрашиваем именно здесь, потому что в день выплаты человек его знает — он смотрит на табло
 * обменника. Зафиксированный курс важнее котировки на ту же дату и не переписывается позже
 * (правило 2), поэтому «к размену» считается по своему курсу, а не по вчерашнему ЦБ.
 */
export function IncomeReceipt({
  event,
  base,
  onClose,
}: {
  event: IncomeEventDto;
  base: string;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const confirm = useConfirmIncome();
  const majorOf = (minor: string, ccy: string) => formatMinor(minor, ccy, 'en').replace(/,/g, '');

  const [amount, setAmount] = useState(majorOf(event.amountMinor, event.currency));
  const [occurredOn, setOccurredOn] = useState(event.date);
  const [rate, setRate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const foreign = event.currency !== base;

  const submit = () => {
    const clean = amount.trim().replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(clean) || Number(clean) <= 0) return setError(t('spend.badAmount'));
    if (rate.trim() !== '' && !/^\d+(\.\d+)?$/.test(rate.trim().replace(',', '.'))) {
      return setError(t('income.badRate'));
    }
    let amountMinor: string;
    try {
      amountMinor = fromMajor(clean, event.currency).minor.toString();
    } catch {
      // Лишние знаки после точки: сообщаем, а не падаем молча после setError(null) (находка аудита).
      return setError(t('spend.badAmount'));
    }
    setError(null);
    confirm.mutate(
      {
        sourceId: event.sourceId,
        amountMinor,
        currency: event.currency,
        occurredOn,
        ...(rate.trim() ? { rate: rate.trim().replace(',', '.') } : {}),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('income.received')}
    >
      <div className="sheet">
        <div className="row row-between">
          <span className="panel-name">{t('income.received')}</span>
          <button type="button" className="act" onClick={onClose} aria-label={t('common.cancel')}>
            ✕
          </button>
        </div>

        <div className="fx-form">
          <span className="sub">
            {event.label} · {t('income.expectedAmount')}{' '}
            {formatMinor(event.amountMinor, event.currency, locale)} {event.currency}
          </span>

          <div className="form-row">
            <span className="micro">{t('income.actualAmount')}</span>
            <input
              className="field num field-sm"
              inputMode="decimal"
              autoFocus
              aria-label={t('income.actualAmount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="sub num">{event.currency}</span>
            <input
              className="field num"
              type="date"
              aria-label={t('spend.date')}
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
          </div>

          {foreign && (
            <div className="form-row">
              <span className="micro">
                {t('income.rateOfDay', { from: event.currency, to: base })}
              </span>
              <input
                className="field num field-sm"
                inputMode="decimal"
                placeholder={t('income.rateOptional')}
                aria-label={t('income.rateOfDay', { from: event.currency, to: base })}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
          )}

          <button type="button" className="btn" disabled={confirm.isPending} onClick={submit}>
            {confirm.isPending ? t('common.loading') : t('income.fix')}
          </button>

          {error && <span className="sub danger">{error}</span>}
          {confirm.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
          {foreign && <span className="sub">{t('income.rateHint')}</span>}
        </div>
      </div>
    </div>
  );
}
