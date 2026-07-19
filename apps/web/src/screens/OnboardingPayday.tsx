import { fromMajor } from '@multa/core';
import type { TranslationKey } from '@multa/i18n';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OnboardingShell } from '../components/OnboardingShell.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import type { WorkspaceDto } from '../lib/queries.ts';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

const PRESETS: { key: TranslationKey; anchors: () => unknown }[] = [
  { key: 'onboarding.payday.preset.twiceMonthly', anchors: () => ({ kind: 'monthly-days', days: [10, 25] }) },
  { key: 'onboarding.payday.preset.monthly', anchors: () => ({ kind: 'monthly-days', days: [1] }) },
  { key: 'onboarding.payday.preset.biweekly', anchors: () => ({ kind: 'every-weeks', weeks: 2, startsOn: todayISO() }) },
];

function toMinor(income: string, currency: string): string {
  const clean = income.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) return '0';
  try {
    return fromMajor(clean, currency).minor.toString();
  } catch {
    return '0';
  }
}

export function OnboardingPayday({ workspace }: { workspace: WorkspaceDto }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [presetIdx, setPresetIdx] = useState(0);
  const [income, setIncome] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      api('/v1/onboarding/payday', {
        method: 'POST',
        body: JSON.stringify({
          anchors: PRESETS[presetIdx]!.anchors(),
          expectedIncomeMinor: toMinor(income, workspace.baseCurrency),
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });

  return (
    <OnboardingShell step={2}>
      <div>
        <h1 style={{ margin: 0, fontSize: 32 }}>{t('onboarding.payday.title')}</h1>
        <p className="dim" style={{ marginTop: 8 }}>
          {t('onboarding.payday.subtitle')}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {PRESETS.map((p, i) => (
          <button key={p.key} type="button" className="chip" aria-pressed={presetIdx === i} onClick={() => setPresetIdx(i)}>
            {t(p.key)}
          </button>
        ))}
      </div>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
          {t('onboarding.payday.expectedAmount')} · {workspace.baseCurrency}
        </label>
        <input
          className="field mono"
          inputMode="decimal"
          placeholder="0"
          value={income}
          onChange={(e) => setIncome(e.target.value.replace(',', '.'))}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          {t('common.done')}
        </button>
      </div>
    </OnboardingShell>
  );
}
