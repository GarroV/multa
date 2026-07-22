import { fromMajor } from '@multa/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { OnboardingShell } from '../components/OnboardingShell.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { PAYDAY_PRESETS } from '../lib/paydayPresets.ts';
import { useCreateEntity, useEntities, type Bucket, type Debt, type WorkspaceDto } from '../lib/queries.ts';

/** major → minor или null (не подставляем 0 молча). */
function toMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    return fromMajor(s, ccy).minor.toString();
  } catch {
    return null;
  }
}

// --- Шаг 2: якоря выплат + доход ---

function PaydayStep({ base, onDone }: { base: string; onDone: () => void }) {
  const { t } = useI18n();
  const [presetIdx, setPresetIdx] = useState(0);
  const [income, setIncome] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      api('/v1/onboarding/payday', {
        method: 'POST',
        body: JSON.stringify({
          anchors: PAYDAY_PRESETS[presetIdx]!.anchors(),
          expectedIncomeMinor: toMinor(income, base) ?? '0',
        }),
      }),
    onSuccess: onDone, // НЕ инвалидируем 'me' — иначе гейт откроет приложение до шагов 3-4
  });
  return (
    <OnboardingShell step={2}>
      <div>
        <h1 style={{ margin: 0, fontSize: 32 }}>{t('onboarding.payday.title')}</h1>
        <p className="dim" style={{ marginTop: 8 }}>{t('onboarding.payday.subtitle')}</p>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {PAYDAY_PRESETS.map((p, i) => (
          <button key={p.key} type="button" className="chip" aria-pressed={presetIdx === i} onClick={() => setPresetIdx(i)}>
            {t(p.key)}
          </button>
        ))}
      </div>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
          {t('onboarding.payday.expectedAmount')} · {base}
        </label>
        <input className="field mono" inputMode="decimal" placeholder="0" value={income} onChange={(e) => setIncome(e.target.value.replace(',', '.'))} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{t('common.next')}</button>
      </div>
    </OnboardingShell>
  );
}

// --- Шаг 3: долги (пропускаемо) ---

function DebtsStep({ base, onNext }: { base: string; onNext: () => void }) {
  const { t } = useI18n();
  const { data: debts = [] } = useEntities<Debt>('debts');
  const create = useCreateEntity('debts');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState('');

  const add = () => {
    const remaining = toMinor(amount, base);
    const pay = toMinor(payment || '0', base);
    if (!name.trim() || remaining === null || pay === null) return;
    create.mutate(
      { name: name.trim(), currency: base, principalMinor: remaining, remainingMinor: remaining, paymentMinor: pay },
      { onSuccess: () => { setName(''); setAmount(''); setPayment(''); } },
    );
  };

  return (
    <OnboardingShell step={3}>
      <div>
        <h1 style={{ margin: 0, fontSize: 32 }}>{t('onboarding.debts.title')}</h1>
        <p className="dim" style={{ marginTop: 8 }}>{t('onboarding.debts.subtitle')}</p>
      </div>
      {debts.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 4 }}>
          {debts.map((d) => (
            <div key={d.id} className="list-item">
              <span>{d.name}</span>
              <span className="mono dim">{d.paymentMinor !== '0' ? `${d.currency} · ${t('obl.payment')}` : d.currency}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <input className="field" style={{ flex: 2, minWidth: 120 }} placeholder={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field mono" style={{ flex: 1, minWidth: 90 }} inputMode="decimal" placeholder={t('common.amount')} value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} />
        <input className="field mono" style={{ flex: 1, minWidth: 90 }} inputMode="decimal" placeholder={t('obl.payment')} value={payment} onChange={(e) => setPayment(e.target.value.replace(',', '.'))} />
        <button className="btn" disabled={create.isPending} onClick={add}>{t('common.add')}</button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <button className="btn btn-ghost" onClick={onNext}>{t('common.skip')}</button>
        <button className="btn" onClick={onNext}>{t('common.next')}</button>
      </div>
    </OnboardingShell>
  );
}

// --- Шаг 4: валютные корзины (пропускаемо) ---

function BucketsStep({ base, onFinish, finishing }: { base: string; onFinish: () => void; finishing: boolean }) {
  const { t } = useI18n();
  const { data: buckets = [] } = useEntities<Bucket>('buckets');
  const create = useCreateEntity('buckets');
  const [name, setName] = useState('');
  const [to, setTo] = useState('EUR');
  const [amount, setAmount] = useState('');

  const add = () => {
    const amt = toMinor(amount, base);
    if (!name.trim() || amt === null) return;
    create.mutate(
      { name: name.trim(), fromCurrency: base, toCurrency: to, amountMinor: amt },
      { onSuccess: () => { setName(''); setAmount(''); } },
    );
  };

  return (
    <OnboardingShell step={4}>
      <div>
        <h1 style={{ margin: 0, fontSize: 32 }}>{t('onboarding.buckets.title')}</h1>
        <p className="dim" style={{ marginTop: 8 }}>{t('onboarding.buckets.subtitle')}</p>
      </div>
      {buckets.length > 0 && (
        <div className="card" style={{ display: 'grid', gap: 4 }}>
          {buckets.map((b) => (
            <div key={b.id} className="list-item">
              <span>{b.name} <span className="dim">· {b.fromCurrency} → {b.toCurrency}</span></span>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <input className="field" style={{ flex: 2, minWidth: 120 }} placeholder={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field mono" style={{ width: 62 }} maxLength={3} title={t('obl.to')} value={to} onChange={(e) => setTo(e.target.value.toUpperCase())} />
        <input className="field mono" style={{ flex: 1, minWidth: 90 }} inputMode="decimal" placeholder={`${t('common.amount')} · ${base}`} value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} />
        <button className="btn" disabled={create.isPending} onClick={add}>{t('common.add')}</button>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <button className="btn btn-ghost" disabled={finishing} onClick={onFinish}>{t('common.skip')}</button>
        <button className="btn" disabled={finishing} onClick={onFinish}>{t('onboarding.finish')}</button>
      </div>
    </OnboardingShell>
  );
}

/**
 * Флоу онбординга шаги 2-4 (шаг 1 — валюта — в OnboardingCurrency). Долги/корзины пропускаемы.
 * 'me' инвалидируется только на финише: пока флоу активен, гейт App держит онбординг открытым,
 * хотя periodAnchors уже записаны сервером после шага 2.
 */
export function Onboarding({ workspace }: { workspace: WorkspaceDto }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<2 | 3 | 4>(2);
  const base = workspace.baseCurrency;

  const finish = useMutation({
    mutationFn: async () => {
      await qc.invalidateQueries({ queryKey: ['plan'] });
      await qc.invalidateQueries({ queryKey: ['me'] }); // последним: гейт App → AppShell (ага-план)
    },
  });

  if (step === 2) return <PaydayStep base={base} onDone={() => setStep(3)} />;
  if (step === 3) return <DebtsStep base={base} onNext={() => setStep(4)} />;
  return <BucketsStep base={base} onFinish={() => finish.mutate()} finishing={finish.isPending} />;
}
