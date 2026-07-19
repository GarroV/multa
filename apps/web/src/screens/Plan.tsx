import { useI18n } from '../lib/i18n.tsx';

export function Plan() {
  const { t } = useI18n();
  return (
    <div style={{ padding: 24 }}>
      <h1 className="section-title">{t('nav.plan')}</h1>
      <p className="dim">{t('placeholder.soon')}</p>
    </div>
  );
}
