import { Link } from '@tanstack/react-router';
import { useI18n } from '../lib/i18n.tsx';

/**
 * Экран «плана ещё нет»: обучение пропущено, дохода нет, собирать нечего.
 * Это не ошибка, поэтому без «что-то пошло не так» и без кнопки «повторить» —
 * вместо них дорога в настройки, где задаётся источник дохода.
 */
export function NoIncomeYet() {
  const { t } = useI18n();
  return (
    <div style={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>
      <div className="card" style={{ maxWidth: 420 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{t('plan.empty.title')}</div>
        <div className="dim" style={{ marginTop: 6 }}>
          {t('plan.empty.needIncome')}
        </div>
        <Link to="/settings" className="btn" style={{ display: 'inline-block', marginTop: 16 }}>
          {t('settings.sources')}
        </Link>
      </div>
    </div>
  );
}
