import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { useSkipOnboarding } from '../lib/queries.ts';

/** Шагов ровно два (issue #28): валюта и доход. Долги и корзины заводятся уже внутри продукта. */
const TOTAL_STEPS = 2;

export function OnboardingShell({ step, children }: { step: number; children: ReactNode }) {
  const { t } = useI18n();
  const skip = useSkipOnboarding();

  return (
    <div className="page-center">
      <div className="shell-body">
        <div className="row row-between">
          <div className="steps-bar">
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              /* Пройденность шага — состояние, а не стиль: класс, чтобы цвет жил в токенах. */
              <div key={i} className={i < step ? 'step-tick step-tick-done' : 'step-tick'} />
            ))}
          </div>
          {/* Скип обучения целиком: в приложение с пустым планом, доход задаётся позже в настройках. */}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={skip.isPending}
            onClick={() => skip.mutate()}
          >
            {t('onboarding.skipAll')}
          </button>
        </div>
        {skip.isError && <div className="note-band">{t('common.error')}</div>}
        {children}
      </div>
    </div>
  );
}
