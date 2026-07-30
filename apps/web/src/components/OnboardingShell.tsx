import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { useSkipOnboarding } from '../lib/queries.ts';

const TOTAL_STEPS = 4;

export function OnboardingShell({ step, children }: { step: number; children: ReactNode }) {
  const { t } = useI18n();
  const skip = useSkipOnboarding();

  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: 'min(560px, 100%)', display: 'grid', gap: 20 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 8, flex: 1 }}>
            {Array.from({ length: TOTAL_STEPS }, (_, i) => (
              <div
                key={i}
                style={{
                  height: 3,
                  flex: 1,
                  borderRadius: 2,
                  background: i < step ? 'var(--neon-cyan)' : 'var(--line)',
                  boxShadow: i < step ? 'var(--glow-cyan)' : 'none',
                }}
              />
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
