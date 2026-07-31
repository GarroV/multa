import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';

/**
 * Вход в демо без регистрации (issue #56).
 *
 * Экран ничего не спрашивает: он просит у сервера демо-сессию и уходит на дашборд. Смотрящий
 * попадает в наполненный продукт за один переход — в этом весь смысл демо. Текст здесь только на
 * случай, если сервер не ответил.
 */
export function Demo() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  // Вход просим один раз: StrictMode вызывает эффект дважды, а второй вход перезапишет cookie.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void api<{ ok: boolean }>('/v1/demo/enter', { method: 'POST' })
      .then(() => {
        // Полная перезагрузка, а не router-переход: клиенту нужно перечитать сессию с нуля.
        window.location.replace('/today');
      })
      .catch(() => setFailed(true));
  }, [navigate]);

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ display: 'grid', gap: 10, justifyItems: 'center', textAlign: 'center' }}>
        <span className="brand" style={{ padding: 0 }}>
          multa
        </span>
        <span className="dim">{failed ? t('demo.failed') : t('demo.entering')}</span>
        {failed && (
          <button className="btn" onClick={() => window.location.reload()}>
            {t('common.retry')}
          </button>
        )}
      </div>
    </div>
  );
}
