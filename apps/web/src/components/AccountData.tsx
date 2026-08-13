import { useState } from 'react';
import { API_ORIGIN } from '../lib/apiUrl.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useDeleteAccount } from '../lib/queries.ts';
import { Hint } from './ui/Hint.tsx';

/**
 * Выгрузка данных и удаление аккаунта (Спринт 6).
 *
 * Два условия, без которых нельзя звать посторонних. Человек, отдавший продукту свои деньги,
 * обязан уметь забрать их файлом и уйти кнопкой — не письмом основателю и не «напишите в
 * поддержку». Ручки для этого появились вместе с этим экраном; до того каскады в схеме были, а
 * запустить их было нечем.
 *
 * Подтверждение удаления — собственная почта, как у GitHub с именем репозитория. Сессия уже
 * доказала, КТО пришёл; ввод подтверждает, что человек понимает, ЧТО сейчас произойдёт. Кнопка без
 * подтверждения выключена, а не молча ничего не делает.
 */
export function AccountData({ email }: { email: string | null }) {
  const { t } = useI18n();
  const remove = useDeleteAccount();
  const [confirm, setConfirm] = useState('');
  const [armed, setArmed] = useState(false);

  const matches = email !== null && confirm.trim().toLowerCase() === email.trim().toLowerCase();

  return (
    <>
      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('account.export')}</span>
          <Hint text={t('account.export.hint')} />
        </span>
        <span className="prow-num" />
        {/*
          Обычная ссылка, а не fetch: файл должен сохраняться браузером с именем из заголовка, а
          выкачивать его в память приложения ради того же результата незачем.
        */}
        <a className="act" href={`${API_ORIGIN}/v1/export/transactions.csv`} download>
          {t('account.export.action')}
        </a>
      </div>

      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span className="danger">{t('account.delete')}</span>
          <Hint text={t('account.delete.hint')} />
        </span>
        <span className="prow-num" />
        {!armed && (
          <button type="button" className="act" onClick={() => setArmed(true)}>
            {t('account.delete.action')}
          </button>
        )}
      </div>

      {armed && (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-bar prow-bar-full">
            <span className="fx-form">
              <span className="sub">{t('account.delete.confirm', { email: email ?? '' })}</span>
              <span className="form-row">
                <input
                  className="field grow"
                  aria-label={t('account.delete.confirm', { email: email ?? '' })}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={!matches || remove.isPending}
                  onClick={() => remove.mutate(confirm.trim())}
                >
                  {t('account.delete.action')}
                </button>
                <button
                  type="button"
                  className="act"
                  onClick={() => {
                    setArmed(false);
                    setConfirm('');
                  }}
                >
                  {t('common.cancel')}
                </button>
              </span>
              {remove.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
            </span>
          </span>
        </div>
      )}
    </>
  );
}
