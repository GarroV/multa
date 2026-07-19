import { fromMajor, money, toMajorString } from '@multa/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { PAYDAY_PRESETS } from '../lib/paydayPresets.ts';
import { useMe } from '../lib/queries.ts';

function matchPreset(anchors: unknown): number {
  const a = anchors as { kind?: string; days?: number[] } | null;
  if (a?.kind === 'monthly-days' && a.days?.length === 1) return 1;
  if (a?.kind === 'every-weeks') return 2;
  return 0;
}

export function Settings() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const ws = me?.workspace;

  const [currency, setCurrency] = useState(ws?.baseCurrency ?? 'RUB');
  const [income, setIncome] = useState(
    ws?.expectedIncomeMinor ? toMajorString(money(BigInt(ws.expectedIncomeMinor), ws.baseCurrency)) : '',
  );
  const [presetIdx, setPresetIdx] = useState(matchPreset(ws?.periodAnchors ?? null));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const cur = currency.toUpperCase().slice(0, 3);
      await api('/v1/workspace', { method: 'PATCH', body: JSON.stringify({ baseCurrency: cur }) });
      const minor = /^\d+(\.\d+)?$/.test(income.trim()) ? fromMajor(income.trim(), cur).minor.toString() : '0';
      await api('/v1/onboarding/payday', {
        method: 'POST',
        body: JSON.stringify({ anchors: PAYDAY_PRESETS[presetIdx]!.anchors(), expectedIncomeMinor: minor }),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      setSaved(true);
    },
  });

  if (!ws) return <div style={{ padding: 24 }} className="dim">{t('common.loading')}</div>;

  return (
    <div style={{ padding: 24, maxWidth: 560, display: 'grid', gap: 20 }}>
      <h1 className="section-title">{t('settings.title')}</h1>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('settings.currency')}</label>
        <input
          className="field mono"
          value={currency}
          maxLength={3}
          onChange={(e) => { setCurrency(e.target.value.toUpperCase()); setSaved(false); }}
        />
      </div>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('settings.anchors')}</label>
        <div className="row">
          {PAYDAY_PRESETS.map((p, i) => (
            <button key={p.key} type="button" className="chip" aria-pressed={presetIdx === i}
              onClick={() => { setPresetIdx(i); setSaved(false); }}>
              {t(p.key)}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('settings.income')} · {currency}</label>
        <input
          className="field mono"
          inputMode="decimal"
          value={income}
          onChange={(e) => { setIncome(e.target.value.replace(',', '.')); setSaved(false); }}
        />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {saved && <span className="dim">{t('common.saved')}</span>}
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</button>
      </div>
    </div>
  );
}
