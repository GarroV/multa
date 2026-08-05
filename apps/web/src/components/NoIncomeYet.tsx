import { useI18n } from '../lib/i18n.tsx';
import { useMe } from '../lib/queries.ts';
import { IncomeEditor } from './IncomeEditor.tsx';

/**
 * Экран «плана ещё нет»: обучение пропущено, дохода нет, собирать нечего.
 *
 * Это не ошибка, поэтому без «что-то пошло не так» и без кнопки «повторить». И не дорога в
 * «Настройки»: раньше отсюда уводило на другой экран, а после заведения источника человек оставался
 * там же и сам догадывался вернуться. Источник дохода заводится здесь же — единственное, чего не
 * хватает плану, стоит прямо под объяснением.
 */
export function NoIncomeYet() {
  const { t, locale } = useI18n();
  const { data: me } = useMe();
  const base = me?.workspace?.baseCurrency;

  return (
    <div style={{ display: 'grid', placeItems: 'center', padding: '48px 16px' }}>
      <div className="card" style={{ maxWidth: 620, width: '100%' }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{t('plan.empty.title')}</div>
        <div className="dim" style={{ marginTop: 6, marginBottom: 14 }}>
          {t('plan.empty.needIncome')}
        </div>
        {base ? (
          <IncomeEditor base={base} locale={locale} />
        ) : (
          <span className="sub dim">{t('common.loading')}</span>
        )}
      </div>
    </div>
  );
}
