import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OnboardingShell } from '../components/OnboardingShell.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';

const POPULAR = ['RUB', 'EUR', 'USD', 'RSD'];

export function OnboardingCurrency() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [currency, setCurrency] = useState('RUB');
  const [search, setSearch] = useState('');
  const chosen = (search || currency).toUpperCase();

  const mutation = useMutation({
    mutationFn: () =>
      api('/v1/workspace', {
        method: 'POST',
        body: JSON.stringify({ baseCurrency: chosen.slice(0, 3) }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <OnboardingShell step={1}>
      <div>
        <h1 style={{ margin: 0, fontSize: 32 }}>{t('onboarding.currency.title')}</h1>
        <p className="dim" style={{ marginTop: 8 }}>
          {t('onboarding.currency.subtitle')}
        </p>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {POPULAR.map((c) => (
          <button
            key={c}
            type="button"
            className="chip mono"
            aria-pressed={chosen === c}
            onClick={() => {
              setCurrency(c);
              setSearch('');
            }}
            style={{ minWidth: 96 }}
          >
            {c}
          </button>
        ))}
      </div>
      <input
        className="field mono"
        placeholder={t('onboarding.currency.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value.toUpperCase())}
        maxLength={3}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="btn"
          disabled={mutation.isPending || chosen.length !== 3}
          onClick={() => mutation.mutate()}
        >
          {t('common.next')}
        </button>
      </div>
    </OnboardingShell>
  );
}
