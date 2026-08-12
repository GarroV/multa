import { useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useSheet } from '../lib/useSheet.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useQrScanner } from '../lib/useQrScanner.ts';
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
export function ReceiptEntry({
  base,
  locale,
  onClose,
}: {
  base: string;
  locale: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // Escape закрывает лист, фокус возвращается на кнопку, которой его открыли.
  useSheet(onClose);
  const { data: categories = [] } = useCategories();
  const qr = useParseReceiptQr();
  const photo = useParseReceiptPhoto();
  const confirm = useConfirmReceipt();

  const [payload, setPayload] = useState('');
  const scanner = useQrScanner();
  /** Код не нашёлся в снимке — это ответ, а не молчание: иначе кнопка выглядит сломанной. */
  const [noCode, setNoCode] = useState(false);

  /** Найденный код сразу уходит на разбор: лишнее подтверждение здесь — только шаг между. */
  const useCode = (code: string) => {
    setNoCode(false);
    setPayload(code);
    qr.mutate(code, { onSuccess: setParsed });
  };

  const scanQr = async () => {
    setNoCode(false);
    await scanner.start(useCode);
  };

  const scanFile = async (file: File) => {
    const code = await scanner.fromFile(file);
    if (code) useCode(code);
    else setNoCode(true);
  };
  const [parsed, setParsed] = useState<ReceiptParsed | null>(null);

  const failed = qr.isError || photo.isError;
  const nameOf = (id: string) => categories.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={t('receipt.title')}>
      <div className="sheet">
        <div className="row row-between-top">
          <div className="strong">{t('receipt.title')}</div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            title={t('common.cancel')}
          >
            ✕
          </button>
        </div>

        {!parsed && (
          <>
            <div className="stack-xs">
              <span className="micro">{t('receipt.parseQr')}</span>
              {/*
                Камера — главный путь (#107). Раньше содержимое QR перепечатывали руками с бумажки,
                хотя смысл этого пути ровно в одном движении телефоном. Поле ввода осталось ниже:
                оно нужно, когда код пришёл текстом (чек по почте, скриншот из банка).
              */}
              <video
                ref={scanner.videoRef}
                className={scanner.state === 'scanning' ? 'qr-view' : 'qr-view is-off'}
                muted
                playsInline
              />
              <div className="form-row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => (scanner.state === 'scanning' ? scanner.stop() : void scanQr())}
                >
                  {scanner.state === 'scanning' ? t('receipt.scanStop') : t('receipt.scan')}
                </button>
                <label className="act">
                  {t('receipt.scanFile')}
                  <input
                    type="file"
                    accept="image/*"
                    className="visually-hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void scanFile(file);
                    }}
                  />
                </label>
              </div>
              {scanner.state === 'denied' && (
                <span className="sub danger">{t('receipt.scanDenied')}</span>
              )}
              {scanner.state === 'unsupported' && (
                <span className="sub dim">{t('receipt.scanNo')}</span>
              )}
              {noCode && <span className="sub danger">{t('receipt.scanNoCode')}</span>}
              <input
                className="field mono"
                placeholder={t('receipt.qrPlaceholder')}
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
              />
              <span className="sub">{t('receipt.qrHint')}</span>
              <button
                type="button"
                className="btn"
                disabled={qr.isPending || payload.trim().length < 4}
                onClick={() => qr.mutate(payload.trim(), { onSuccess: setParsed })}
              >
                {qr.isPending ? t('common.loading') : t('receipt.parseQr')}
              </button>
            </div>

            <div className="stack-xs">
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
              <span className="sub">{t('receipt.photoHint')}</span>
              {photo.isPending && <span className="sub">{t('common.loading')}</span>}
            </div>

            {failed && <div className="note-band">{t('receipt.failed')}</div>}
          </>
        )}

        {parsed && (
          <>
            <div className="row row-between">
              <span className="sub">
                {t('receipt.total')}
                {parsed.merchant ? ` · ${parsed.merchant}` : ''}
              </span>
              <span className="num">
                {formatMinor(parsed.totalMinor, parsed.currency, locale)} {parsed.currency}
              </span>
            </div>

            {parsed.confidence === 'low' && (
              <div className="note-band">{t('receipt.lowConfidence')}</div>
            )}

            <section className="tile">
              {parsed.split.map((row) => (
                <div key={row.categoryId} className="list-item">
                  <span>{nameOf(row.categoryId)}</span>
                  <span className="num">
                    {formatMinor(row.amountMinor, parsed.currency, locale)} {parsed.currency}
                  </span>
                </div>
              ))}
            </section>

            <button
              type="button"
              className="btn"
              disabled={confirm.isPending}
              onClick={() =>
                confirm.mutate(
                  { id: parsed.receipt.id, split: parsed.split },
                  { onSuccess: onClose },
                )
              }
            >
              {confirm.isPending ? t('common.loading') : t('receipt.confirm')}
            </button>
            {confirm.isError && <div className="sub danger">⚠ {t('common.error')}</div>}
          </>
        )}
      </div>
    </div>
  );
}
