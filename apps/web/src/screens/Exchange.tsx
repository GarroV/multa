import { fromMajor } from '@multa/core';
import { useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useCreateExchange, useDeleteExchange, useExchangeOps, useMe, type ExchangeOp } from '../lib/queries.ts';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** major-строка → minor или null (мусор молча не превращаем в ноль). */
function parseMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.').replace(/[\s  ]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) return null;
  return fromMajor(s, ccy).minor.toString();
}

function OpRow({ op, locale }: { op: ExchangeOp; locale: string }) {
  const { t } = useI18n();
  const del = useDeleteExchange();
  const lost = op.spreadMinor !== null ? BigInt(op.spreadMinor) : null;
  const gain = lost !== null && lost < 0n;

  return (
    <div className="list-item">
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="dim mono" style={{ fontSize: 13 }}>{op.occurredOn.slice(5)}</span>
        <span className="mono">
          {formatMinor(op.fromMinor, op.fromCurrency, locale)} {op.fromCurrency}
          <span className="dim"> → </span>
          {formatMinor(op.toMinor, op.toCurrency, locale)} {op.toCurrency}
        </span>
        <span className="dim mono" style={{ fontSize: 13 }}>
          {t('fx.rate')} {op.actualRate}
          {op.officialRate && ` · ${t('fx.official')} ${Number(op.officialRate).toFixed(4)}`}
        </span>
        {op.note && <span className="dim" style={{ fontSize: 13 }}>· {op.note}</span>}
      </span>
      <span className="row" style={{ gap: 10 }}>
        {lost === null ? (
          <span className="dim" style={{ fontSize: 12 }}>{t('fx.spreadUnknown')}</span>
        ) : (
          <span className="mono" style={{ fontSize: 13, color: gain ? 'var(--neon-lime)' : 'var(--neon-amber)' }}>
            {gain ? '−' : ''}
            {formatMinor((gain ? -lost : lost).toString(), op.toCurrency, locale)} {op.toCurrency}
            {op.spreadPct && ` (${op.spreadPct}%)`}
          </span>
        )}
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: '4px 10px' }}
          disabled={del.isPending}
          title={t('common.delete')}
          onClick={() => del.mutate(op.id)}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/**
 * Экран «Размен» (01-domain-model §ExchangeOperation): вводим обе стороны сделки, система
 * считает фактический курс и спред относительно официального. Смысл экрана — копилка потерь:
 * «сколько я теряю на менялах» видно суммой, а не по памяти.
 */
export function Exchange() {
  const { t, locale } = useI18n();
  const { data: me } = useMe();
  const base = me?.workspace?.baseCurrency ?? 'RUB';
  const { data } = useExchangeOps();
  const create = useCreateExchange();

  const [fromCurrency, setFromCurrency] = useState(base);
  const [toCurrency, setToCurrency] = useState(base === 'RUB' ? 'RSD' : 'RUB');
  const [fromValue, setFromValue] = useState('');
  const [toValue, setToValue] = useState('');
  const [occurredOn, setOccurredOn] = useState(todayISO());
  const [note, setNote] = useState('');
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
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          setFromValue('');
          setToValue('');
          setNote('');
        },
      },
    );
  };

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 24, display: 'grid', gap: 20 }}>
      <h1 className="section-title" style={{ margin: 0 }}>{t('fx.title')}</h1>

      <div className="card" style={{ display: 'grid', gap: 14 }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ display: 'grid', gap: 6 }}>
            <span className="micro">{t('fx.gave')}</span>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="field mono"
                style={{ width: 130, textAlign: 'right' }}
                inputMode="decimal"
                placeholder="0"
                value={fromValue}
                onChange={(e) => setFromValue(e.target.value)}
              />
              <input
                className="field mono"
                style={{ width: 74, textTransform: 'uppercase' }}
                maxLength={3}
                value={fromCurrency}
                onChange={(e) => setFromCurrency(e.target.value.toUpperCase())}
              />
            </div>
          </div>
          <span className="dim" style={{ paddingBottom: 10 }}>→</span>
          <div style={{ display: 'grid', gap: 6 }}>
            <span className="micro">{t('fx.got')}</span>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="field mono"
                style={{ width: 130, textAlign: 'right' }}
                inputMode="decimal"
                placeholder="0"
                value={toValue}
                onChange={(e) => setToValue(e.target.value)}
              />
              <input
                className="field mono"
                style={{ width: 74, textTransform: 'uppercase' }}
                maxLength={3}
                value={toCurrency}
                onChange={(e) => setToCurrency(e.target.value.toUpperCase())}
              />
            </div>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <span className="micro">{t('spend.date')}</span>
            <input
              className="field mono"
              type="date"
              max={todayISO()}
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            className="field"
            style={{ flex: 1, minWidth: 160 }}
            placeholder="—"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button type="button" className="btn" disabled={create.isPending} onClick={submit}>
            {create.isPending ? t('common.loading') : t('fx.add')}
          </button>
        </div>

        {sameCurrency && <span className="danger" style={{ fontSize: 13 }}>{t('fx.sameCurrency')}</span>}
        {invalid && !sameCurrency && <span className="danger" style={{ fontSize: 13 }}>{t('spend.badAmount')}</span>}
        {create.isError && <span className="danger" style={{ fontSize: 13 }}>⚠ {t('common.error')}</span>}
      </div>

      {data && data.totalLost.length > 0 && (
        <div className="plan-summary">
          {data.totalLost.map((l) => {
            const minor = BigInt(l.minor);
            const gain = minor < 0n;
            return (
              <div key={l.currency}>
                <span className="micro">{gain ? t('fx.gain') : t('fx.totalLost')}</span>
                <span className={`stat${gain ? '' : ' warn'}`}>
                  {formatMinor((gain ? -minor : minor).toString(), l.currency, locale)} {l.currency}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="card">
        <div className="plan-group-head">
          <span className="micro">{t('fx.history')}</span>
        </div>
        {data?.ops.length ? (
          data.ops.map((op) => <OpRow key={op.id} op={op} locale={locale} />)
        ) : (
          <div className="dim" style={{ fontSize: 13 }}>{t('fx.empty')}</div>
        )}
      </div>
    </div>
  );
}
