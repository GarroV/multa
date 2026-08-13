import { fromMajor } from '@multa/core';
import { CurrencySelect } from './ui/CurrencySelect.tsx';
import { useState } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { useToday } from '../lib/useToday.ts';
import { useCreateExchange, useMe, useSettings } from '../lib/queries.ts';

/**
 * Ввод размена: обе стороны сделки руками, курс и спред считает сервер. Смысл — копилка потерь:
 * «сколько я теряю на менялах» должно быть суммой, а не ощущением. Форма живёт отдельно от
 * экрана, потому что размен вводят из статистики, а раньше — с собственного экрана.
 */

/** major-строка → minor или null (мусор молча не превращаем в ноль). */
function parseMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.').replace(/[\s ]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) return null;
  try {
    return fromMajor(s, ccy).minor.toString();
  } catch {
    // Лишние знаки после точки для валюты (RSD и JPY — целые): показываем ошибку, а не молчим.
    return null;
  }
}

export function ExchangeEntry() {
  const { t } = useI18n();
  const today = useToday();
  const { data: me } = useMe();
  const base = me?.workspace?.baseCurrency ?? 'RUB';
  const create = useCreateExchange();
  // Провайдер из настроек: его набирают каждый раз один и тот же (issue #49).
  const { data: settings } = useSettings();

  const [fromCurrency, setFromCurrency] = useState(base);
  const [toCurrency, setToCurrency] = useState(base === 'RUB' ? 'RSD' : 'RUB');
  const [fromValue, setFromValue] = useState('');
  const [toValue, setToValue] = useState('');
  const [occurredOn, setOccurredOn] = useState(today);
  const [provider, setProvider] = useState('');
  const providerHint = settings?.currency.defaultProvider ?? '';
  const [invalid, setInvalid] = useState(false);

  const sameCurrency = fromCurrency.toUpperCase() === toCurrency.toUpperCase();

  const submit = () => {
    const fromMinor = parseMinor(fromValue, fromCurrency);
    const toMinor = parseMinor(toValue, toCurrency);
    if (!fromMinor || !toMinor || sameCurrency) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(
      {
        fromCurrency,
        toCurrency,
        fromMinor,
        toMinor,
        occurredOn,
        // Пустое поле означает «как обычно»: провайдера из настроек подставит сервер (issue #53).
        ...(provider.trim() ? { provider: provider.trim() } : {}),
      },
      {
        onSuccess: () => {
          setFromValue('');
          setToValue('');
          setProvider('');
        },
      },
    );
  };

  return (
    <div className="fx-form">
      <div className="form-row">
        <span className="micro">{t('fx.gave')}</span>
        <input
          className="field num field-sm"
          inputMode="decimal"
          placeholder="0"
          aria-label={t('fx.gave')}
          value={fromValue}
          onChange={(e) => setFromValue(e.target.value)}
        />
        <CurrencySelect
          value={fromCurrency}
          onChange={setFromCurrency}
          label={t('common.currency')}
          className="field num field-ccy-wide"
        />
        <span className="dim">→</span>
        <span className="micro">{t('fx.got')}</span>
        <input
          className="field num field-sm"
          inputMode="decimal"
          placeholder="0"
          aria-label={t('fx.got')}
          value={toValue}
          onChange={(e) => setToValue(e.target.value)}
        />
        <CurrencySelect
          value={toCurrency}
          onChange={setToCurrency}
          label={t('common.currency')}
          className="field num field-ccy-wide"
        />
      </div>
      <div className="form-row">
        <input
          className="field num"
          type="date"
          max={today}
          aria-label={t('spend.date')}
          value={occurredOn}
          onChange={(e) => setOccurredOn(e.target.value)}
        />
        <input
          className="field grow"
          placeholder={providerHint || '—'}
          aria-label={t('fx.provider')}
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button type="button" className="btn" disabled={create.isPending} onClick={submit}>
          {create.isPending ? t('common.loading') : t('fx.add')}
        </button>
      </div>
      {sameCurrency && <span className="sub danger">{t('fx.sameCurrency')}</span>}
      {invalid && !sameCurrency && <span className="sub danger">{t('spend.badAmount')}</span>}
      {create.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
    </div>
  );
}
