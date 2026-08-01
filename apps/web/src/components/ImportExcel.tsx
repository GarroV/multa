import type { TranslationKey } from '@multa/i18n';
import { useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { Panel, Tag } from './ui/Panel.tsx';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  useImportBatches,
  useImportCommit,
  useImportPreview,
  useRollbackImport,
  type ImportPreviewDto,
} from '../lib/queries.ts';

/**
 * Переезд с Excel (issue #76).
 *
 * Порядок жёсткий: выбрал файл → увидел, что получится → перенёс. Предпросмотр обязателен, потому
 * что человек заливает четыре года истории и должен заранее знать сумму, период и какие категории
 * появятся. Отброшенные строки показываются номерами: «не переехало 18» без списка — это потеря
 * данных, о которой человек узнает случайно.
 *
 * Уже перенесённое можно откатить целиком: без этого никто не решится нажать кнопку.
 */

/** Файл читается в base64 на клиенте: таблица за четыре года — меньше мегабайта. */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      // dataURL: «data:...;base64,XXXX» — нужна только часть после запятой.
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Код ошибки api → человеческая формулировка. Незнакомый код — общий текст, а не «internal». */
function errorKey(error: unknown): TranslationKey {
  const code = error instanceof ApiError ? error.code : '';
  if (code === 'not_xlsx') return 'imp.notXlsx';
  if (code === 'sheet_not_found') return 'imp.sheetNotFound';
  if (code === 'journal_header_not_found') return 'imp.noHeader';
  return 'common.error';
}

export function ImportExcel({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const preview = useImportPreview();
  const commit = useImportCommit();
  const rollback = useRollbackImport();
  const { data: batches = [] } = useImportBatches();

  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [sheet, setSheet] = useState('');
  const [dictionarySheet, setDictionarySheet] = useState('');
  const [shown, setShown] = useState<ImportPreviewDto | null>(null);

  const pick = async (input: HTMLInputElement) => {
    const picked = input.files?.[0];
    if (!picked) return;
    setShown(null);
    const base64 = await toBase64(picked);
    setFile({ name: picked.name, base64 });
    // Первый запрос — без листа: он отвечает, что вообще есть в книге. Разбор пойдёт после выбора.
    preview.mutate(
      { fileBase64: base64 },
      {
        onSuccess: (data) => {
          setShown(data);
          const first = data.sheets[0];
          if (first) setSheet(first.name);
        },
        onError: () => undefined,
      },
    );
  };

  const look = () => {
    if (!file || !sheet) return;
    preview.mutate(
      { fileBase64: file.base64, sheet },
      { onSuccess: setShown, onError: () => setShown(null) },
    );
  };

  const move = () => {
    if (!file || !sheet) return;
    commit.mutate(
      {
        fileBase64: file.base64,
        sheet,
        ...(dictionarySheet ? { dictionarySheet } : {}),
        filename: file.name,
      },
      { onSuccess: () => setShown(null) },
    );
  };

  const failed = preview.isError ? preview.error : commit.isError ? commit.error : null;

  return (
    <Panel label={t('imp.title')} accent="lime">
      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <input
            className="field grow"
            type="file"
            accept=".xlsx"
            aria-label={t('imp.pick')}
            onChange={(e) => void pick(e.currentTarget)}
          />
        </span>
        <span className="prow-num">{file && <i>{file.name}</i>}</span>
        <span />
      </div>

      {file && (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <select
              className="field"
              aria-label={t('imp.sheet')}
              value={sheet}
              onChange={(e) => setSheet(e.target.value)}
            >
              {(shown?.sheets ?? []).map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.rows})
                </option>
              ))}
            </select>
            <select
              className="field"
              aria-label={t('imp.dictSheet')}
              value={dictionarySheet}
              onChange={(e) => setDictionarySheet(e.target.value)}
            >
              <option value="">—</option>
              {(shown?.sheets ?? []).map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
          <span className="prow-num" />
          <button type="button" className="act" disabled={preview.isPending} onClick={look}>
            {preview.isPending ? t('imp.reading') : t('imp.preview')}
          </button>
        </div>
      )}

      {shown?.journal && shown.journal.rowsReady > 0 && (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span>
              {t('imp.result', {
                rows: shown.journal.rowsReady,
                from: shown.journal.firstDate ?? '—',
                to: shown.journal.lastDate ?? '—',
                amount: `${formatMinor(shown.journal.totalMinor, base, locale)} ${base}`,
              })}
            </span>
            {shown.journal.rowsSkipped.length > 0 && (
              <Tag tone="amber">
                {t('imp.skipped', { count: shown.journal.rowsSkipped.length })}
              </Tag>
            )}
          </span>
          <span className="prow-num" />
          <button type="button" className="act" disabled={commit.isPending} onClick={move}>
            {t('imp.commit')}
          </button>
          {/* Новые категории называем заранее: перенос меняет структуру бюджета, а не только факт. */}
          {shown.journal.categories.some((c) => !c.existingId) && (
            <span className="prow-note">
              {t('imp.newCats', {
                list: shown.journal.categories
                  .filter((c) => !c.existingId)
                  .map((c) => c.name)
                  .join(', '),
              })}
            </span>
          )}
        </div>
      )}

      {commit.isSuccess && commit.data && (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="st-ok">
              {t('imp.done', {
                rows: commit.data.rowsImported,
                dups: commit.data.rowsDuplicated,
              })}
            </span>
          </span>
          <span className="prow-num" />
          <span />
        </div>
      )}

      {failed !== null && (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="danger">{t(errorKey(failed))}</span>
          </span>
          <span className="prow-num" />
          <span />
        </div>
      )}

      {batches.length > 0 && (
        <>
          <div className="prow">
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              <span className="micro">{t('imp.batches')}</span>
            </span>
            <span className="prow-num" />
            <span />
          </div>
          {batches.map((batch) => (
            <div className="prow" key={batch.id}>
              <span className="prow-day">{batch.createdAt.slice(5, 10)}</span>
              <span className="prow-name">
                <span>{batch.filename}</span>
                {batch.status === 'rolled_back' && <Tag>{t('imp.rolledBack')}</Tag>}
              </span>
              <span className="prow-num">
                <b>{batch.rowsImported}</b>
                {batch.rowsDuplicated > 0 && <i>+{batch.rowsDuplicated}</i>}
              </span>
              {batch.status === 'committed' ? (
                <button
                  type="button"
                  className="act"
                  disabled={rollback.isPending}
                  onClick={() => rollback.mutate(batch.id)}
                >
                  {t('imp.rollback')}
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}
        </>
      )}
    </Panel>
  );
}
