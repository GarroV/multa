import { useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  useCategories,
  useConfirmReceipt,
  useParseReceiptPhoto,
  useParseReceiptQr,
  type ReceiptParsed,
} from '../lib/queries.ts';

/** Файл → data URL: фото уходит в модель одним запросом, без своего файлового хранилища. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Чек (04-web-ux §Ввод): сначала QR — он бесплатный и точный, фото только если QR нет.
 * Раскладка всегда показывается до записи: модель может ошибиться, а деньги пользователя — нет.
 */
export function ReceiptEntry({ base, locale, onClose }: { base: string; locale: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data: categories = [] } = useCategories();
  const qr = useParseReceiptQr();
  const photo = useParseReceiptPhoto();
  const confirm = useConfirmReceipt();

  const [payload, setPayload] = useState('');
  const [parsed, setParsed] = useState<ReceiptParsed | null>(null);

  const failed = qr.isError || photo.isError;
  const nameOf = (id: string) => categories.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={t('receipt.title')}>
      <div className="sheet">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'start' }}>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{t('receipt.title')}</div>
          <button type="button" className="btn btn-ghost" onClick={onClose} title={t('common.cancel')}>
            ✕
          </button>
        </div>

        {!parsed && (
          <>
            <div style={{ display: 'grid', gap: 6 }}>
              <span className="micro">{t('receipt.parseQr')}</span>
              <input
                className="field mono"
                placeholder={t('receipt.qrPlaceholder')}
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
              />
              <span className="dim" style={{ fontSize: 12 }}>{t('receipt.qrHint')}</span>
              <button
                type="button"
                className="btn"
                disabled={qr.isPending || payload.trim().length < 4}
                onClick={() => qr.mutate(payload.trim(), { onSuccess: setParsed })}
              >
                {qr.isPending ? t('common.loading') : t('receipt.parseQr')}
              </button>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <span className="micro">{t('receipt.photo')}</span>
              <input
                className="field"
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const dataUrl = await readAsDataUrl(file);
                  photo.mutate(dataUrl, { onSuccess: setParsed });
                }}
              />
              <span className="dim" style={{ fontSize: 12 }}>{t('receipt.photoHint')}</span>
              {photo.isPending && <span className="dim">{t('common.loading')}</span>}
            </div>

            {failed && <div className="note-band">{t('receipt.failed')}</div>}
          </>
        )}

        {parsed && (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="dim">
                {t('receipt.total')}
                {parsed.merchant ? ` · ${parsed.merchant}` : ''}
              </span>
              <span className="mono">
                {formatMinor(parsed.totalMinor, parsed.currency, locale)} {parsed.currency}
              </span>
            </div>

            {parsed.confidence === 'low' && <div className="note-band">{t('receipt.lowConfidence')}</div>}

            <div className="card">
              {parsed.split.map((row) => (
                <div key={row.categoryId} className="list-item">
                  <span>{nameOf(row.categoryId)}</span>
                  <span className="mono">
                    {formatMinor(row.amountMinor, parsed.currency, locale)} {parsed.currency}
                  </span>
                </div>
              ))}
            </div>

            <button
              type="button"
              className="btn"
              disabled={confirm.isPending}
              onClick={() =>
                confirm.mutate({ id: parsed.receipt.id, split: parsed.split }, { onSuccess: onClose })
              }
            >
              {confirm.isPending ? t('common.loading') : t('receipt.confirm')}
            </button>
            {confirm.isError && <div className="danger" style={{ fontSize: 13 }}>⚠ {t('common.error')}</div>}
          </>
        )}
      </div>
    </div>
  );
}
