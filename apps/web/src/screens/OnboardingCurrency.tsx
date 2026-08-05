import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OnboardingShell } from '../components/OnboardingShell.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useAcceptInvite } from '../lib/queries.ts';

const POPULAR = ['RUB', 'EUR', 'USD', 'RSD'];

export function OnboardingCurrency() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [currency, setCurrency] = useState('RUB');
  const [search, setSearch] = useState('');
  /*
   * Вход по приглашению (issue #46). Место именно здесь: приглашённому не нужен свой бюджет, и
   * прогонять его через выбор валюты и ритм ради чужого плана — впустую потраченные две минуты.
   */
  const [joining, setJoining] = useState(false);
  const [code, setCode] = useState('');
  const join = useAcceptInvite();
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
        <h1 className="screen-title">{t('onboarding.currency.title')}</h1>
        <p className="dim screen-sub">{t('onboarding.currency.subtitle')}</p>
      </div>
      <div className="row-wrap">
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
      <div className="row-end">
        <button
          className="btn"
          disabled={mutation.isPending || chosen.length !== 3}
          onClick={() => mutation.mutate()}
        >
          {t('common.next')}
        </button>
      </div>

      {joining ? (
        <div className="form-row">
          <input
            className="field mono grow"
            placeholder={t('share.joinCode')}
            aria-label={t('share.joinCode')}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button
            type="button"
            className="btn"
            disabled={join.isPending || code.trim().length < 8}
            onClick={() => join.mutate(code.trim())}
          >
            {join.isPending ? t('common.loading') : t('share.joinAction')}
          </button>
          {/* Неверный код — понятная причина, а не общий сбой: код часто просто устарел. */}
          {join.isError && <span className="sub danger">{t('share.joinFailed')}</span>}
        </div>
      ) : (
        <button type="button" className="btn btn-ghost" onClick={() => setJoining(true)}>
          {t('share.join')}
        </button>
      )}
    </OnboardingShell>
  );
}
