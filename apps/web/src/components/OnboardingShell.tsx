import type { ReactNode } from 'react';

const TOTAL_STEPS = 2;

export function OnboardingShell({ step, children }: { step: number; children: ReactNode }) {
  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: 'min(560px, 100%)', display: 'grid', gap: 20 }}>
        <div style={{ display: 'flex', gap: 8 }}>
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
        {children}
      </div>
    </div>
  );
}
