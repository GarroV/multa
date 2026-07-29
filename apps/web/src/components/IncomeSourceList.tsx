import { percentSum, type PayoutForm } from '../lib/income.ts';
import { useI18n } from '../lib/i18n.tsx';

/**
 * Выплаты внутри шага дохода: метка, число, сумма или процент от оклада.
 * Числа предзаполнены ритмом — пользователь вписывает только суммы.
 */
export function IncomeSourceList({
  payouts,
  usePercent,
  gross,
  currency,
  onChange,
  onTogglePercent,
  onGrossChange,
}: {
  payouts: PayoutForm[];
  usePercent: boolean;
  gross: string;
  currency: string;
  onChange: (next: PayoutForm[]) => void;
  onTogglePercent: (next: boolean) => void;
  onGrossChange: (next: string) => void;
}) {
  const { t } = useI18n();
  const patch = (i: number, field: Partial<PayoutForm>) =>
    onChange(payouts.map((p, idx) => (idx === i ? { ...p, ...field } : p)));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
          {t('income.amounts.title')}
        </label>
        <p className="dim micro">{t('income.amounts.hint')}</p>
      </div>

      <div className="row">
        <button
          type="button"
          className="chip"
          aria-pressed={usePercent}
          onClick={() => onTogglePercent(!usePercent)}
        >
          {t('income.amounts.percentToggle')}
        </button>
        {usePercent && (
          <input
            className="field mono"
            style={{ width: 150 }}
            inputMode="decimal"
            aria-label={t('income.amounts.gross')}
            placeholder={`${t('income.amounts.gross')} · ${currency}`}
            value={gross}
            onChange={(e) => onGrossChange(e.target.value.replace(',', '.'))}
          />
        )}
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        {payouts.map((payout, i) => (
          <div className="row" key={i}>
            <input
              className="field"
              style={{ flex: 2, minWidth: 110 }}
              aria-label={t('income.amounts.label')}
              placeholder={t('income.amounts.label')}
              value={payout.label}
              onChange={(e) => patch(i, { label: e.target.value })}
            />
            <input
              className="field mono"
              style={{ width: 64 }}
              inputMode="numeric"
              aria-label={t('income.amounts.day')}
              title={t('income.amounts.day')}
              value={payout.day}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                patch(i, { day: n >= 1 && n <= 31 ? n : payout.day });
              }}
            />
            {usePercent ? (
              <input
                className="field mono"
                style={{ width: 90 }}
                inputMode="decimal"
                aria-label={t('income.amounts.percent')}
                placeholder={t('income.amounts.percent')}
                value={payout.percent}
                onChange={(e) => patch(i, { percent: e.target.value.replace(',', '.') })}
              />
            ) : (
              <input
                className="field mono"
                style={{ flex: 1, minWidth: 100 }}
                inputMode="decimal"
                aria-label={t('income.amounts.amount')}
                placeholder={`${t('income.amounts.amount')} · ${currency}`}
                value={payout.amount}
                onChange={(e) => patch(i, { amount: e.target.value.replace(',', '.') })}
              />
            )}
            {payouts.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={t('common.cancel')}
                onClick={() => onChange(payouts.filter((_, idx) => idx !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange([...payouts, { label: '', day: 15, amount: '', percent: '' }])}
          >
            {t('income.amounts.add')}
          </button>
        </div>
      </div>

      {usePercent && (
        <p className="dim micro">
          {t('income.amounts.percentSum', { sum: percentSum(payouts), gross: gross || '—' })}
        </p>
      )}
    </div>
  );
}
