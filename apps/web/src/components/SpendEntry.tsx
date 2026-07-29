import { fromMajor } from '@multa/core';
import { useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { ApiError } from '../lib/api.ts';
import {
  useCategories,
  useCreateSpend,
  useDeleteSpend,
  useTransactions,
  type Transaction,
} from '../lib/queries.ts';

/** major-строка → minor; null на мусоре (не подставляем молча 0 — как в CategoryEditor). */
function parseMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) return null;
  return fromMajor(s, ccy).minor.toString();
}

const todayISO = (): string => new Date().toISOString().slice(0, 10);

function SpendRow({ tx, base, locale }: { tx: Transaction; base: string; locale: string }) {
  const { t } = useI18n();
  const { data: categories = [] } = useCategories();
  const del = useDeleteSpend();
  const catName = tx.categoryId ? categories.find((c) => c.id === tx.categoryId)?.name : undefined;
  const converted = tx.currency !== base;

  return (
    <div className="list-item">
      <span className="row" style={{ gap: 8 }}>
        <span className="dim mono" style={{ fontSize: 13 }}>{tx.occurredOn.slice(5)}</span>
        <span>{catName ?? t('spend.noCategory')}</span>
        {tx.note && <span className="dim" style={{ fontSize: 13 }}>· {tx.note}</span>}
        {del.isError && <span className="danger" style={{ fontSize: 13 }}>⚠ {t('common.error')}</span>}
      </span>
      <span className="row" style={{ gap: 10 }}>
        <span className="mono">
          {formatMinor(tx.amountMinor, tx.currency, locale)} {tx.currency}
          {converted && (
            <span className="dim" style={{ fontSize: 13 }}>
              {' '}= {formatMinor(tx.baseAmountMinor, base, locale)} {base}
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: '4px 10px' }}
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

/**
 * Ввод факта (04-web-ux §Ввод): сумма → категория сеткой → готово.
 * Умное текстовое поле и чеки — следующие шаги Спринта 3/5; здесь путь «в 3 клика».
 */
export function SpendEntry({ base, locale, onClose }: { base: string; locale: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data: categories = [] } = useCategories();
  const { data: txs } = useTransactions();
  const create = useCreateSpend();

  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [occurredOn, setOccurredOn] = useState(todayISO());
  const [note, setNote] = useState('');
  const [badAmount, setBadAmount] = useState(false);

  const submit = () => {
    const minor = parseMinor(amount, base);
    if (minor === null) {
      setBadAmount(true);
      return;
    }
    setBadAmount(false);
    create.mutate(
      {
        amountMinor: minor,
        currency: base,
        ...(categoryId ? { categoryId } : {}),
        occurredOn,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          setAmount('');
          setNote('');
        },
      },
    );
  };

  const rateMissing = create.error instanceof ApiError && create.error.code === 'rate_unavailable';

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={t('spend.title')}>
      <div className="sheet">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{t('spend.title')}</div>
            <div className="dim" style={{ marginTop: 4, fontSize: 13 }}>{t('spend.subtitle')}</div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} title={t('common.cancel')}>
            ✕
          </button>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <span className="micro">{t('spend.amount')}</span>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="field mono"
              style={{ flex: 1, fontSize: 20 }}
              inputMode="decimal"
              autoFocus
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <span className="dim mono">{base}</span>
          </div>
          {badAmount && <span className="danger" style={{ fontSize: 13 }}>{t('spend.badAmount')}</span>}
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <span className="micro">{t('spend.category')}</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              className="chip"
              aria-pressed={categoryId === undefined}
              onClick={() => setCategoryId(undefined)}
            >
              {t('spend.noCategory')}
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className="chip"
                aria-pressed={categoryId === cat.id}
                onClick={() => setCategoryId(cat.id)}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </div>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'grid', gap: 8 }}>
            <span className="micro">{t('spend.date')}</span>
            <input
              className="field mono"
              type="date"
              value={occurredOn}
              max={todayISO()}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
          </div>
          <div style={{ display: 'grid', gap: 8, flex: 1, minWidth: 160 }}>
            <span className="micro">{t('common.name')}</span>
            <input
              className="field"
              placeholder="—"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </div>

        <button type="button" className="btn" disabled={create.isPending} onClick={submit}>
          {create.isPending ? t('common.loading') : t('spend.submit')}
        </button>

        {create.isError && (
          <div className="danger" style={{ fontSize: 13 }}>
            ⚠ {rateMissing ? t('spend.rateUnavailable') : t('common.error')}
          </div>
        )}

        <div className="card" style={{ marginTop: 4 }}>
          <div className="plan-group-head">
            <span className="micro">{t('spend.recent')}</span>
            {txs && txs.transactions.length > 0 && (
              <span className="dim mono" style={{ fontSize: 13 }}>
                {formatMinor(
                  txs.transactions.reduce((acc, tx) => acc + BigInt(tx.baseAmountMinor), 0n).toString(),
                  base,
                  locale,
                )}{' '}
                {base}
              </span>
            )}
          </div>
          {txs?.transactions.length
            ? txs.transactions.map((tx) => <SpendRow key={tx.id} tx={tx} base={base} locale={locale} />)
            : <div className="dim" style={{ fontSize: 13 }}>{t('spend.empty')}</div>}
        </div>
      </div>
    </div>
  );
}
