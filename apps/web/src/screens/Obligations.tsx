import { fromMajor } from '@multa/core';
import { useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  useCreateEntity,
  useDeleteEntity,
  useEntities,
  useMe,
  type Bucket,
  type Debt,
  type Envelope,
  type Goal,
} from '../lib/queries.ts';

function toMinor(v: string, ccy: string): string {
  return /^\d+(\.\d+)?$/.test(v.trim()) ? fromMajor(v.trim(), ccy).minor.toString() : '0';
}

function DelButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button className="btn btn-ghost" style={{ padding: '4px 10px' }} onClick={onClick} title={t('common.delete')}>
      ✕
    </button>
  );
}

function DebtsSection({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const { data = [] } = useEntities<Debt>('debts');
  const create = useCreateEntity('debts');
  const del = useDeleteEntity('debts');
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState('');
  const add = () => {
    if (!name || !amount) return;
    create.mutate(
      {
        name,
        currency: ccy,
        principalMinor: toMinor(amount, ccy),
        remainingMinor: toMinor(amount, ccy),
        paymentMinor: toMinor(payment || '0', ccy),
      },
      { onSuccess: () => { setName(''); setAmount(''); setPayment(''); } },
    );
  };
  return (
    <div className="card">
      <div className="micro">{t('obl.debts')}</div>
      {data.length === 0 && <div className="dim" style={{ marginTop: 12 }}>{t('common.empty')}</div>}
      {data.map((d) => (
        <div key={d.id} className="list-item">
          <span>{d.name} <span className="dim">· {t('obl.payment')} {formatMinor(d.paymentMinor, d.currency, locale)} {d.currency}</span></span>
          <span className="row">
            <span className="mono">{formatMinor(d.remainingMinor, d.currency, locale)} {d.currency}</span>
            <DelButton onClick={() => del.mutate(d.id)} />
          </span>
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <input className="field" style={{ flex: 2, minWidth: 120 }} placeholder={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field mono" style={{ width: 68 }} maxLength={3} value={ccy} onChange={(e) => setCcy(e.target.value.toUpperCase())} />
        <input className="field mono" style={{ flex: 1, minWidth: 90 }} inputMode="decimal" placeholder={t('common.amount')} value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} />
        <input className="field mono" style={{ flex: 1, minWidth: 90 }} inputMode="decimal" placeholder={t('obl.payment')} value={payment} onChange={(e) => setPayment(e.target.value.replace(',', '.'))} />
        <button className="btn" disabled={create.isPending} onClick={add}>{t('common.add')}</button>
      </div>
    </div>
  );
}

function EnvelopesSection({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const { data = [] } = useEntities<Envelope>('envelopes');
  const create = useCreateEntity('envelopes');
  const del = useDeleteEntity('envelopes');
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [ruleKind, setRuleKind] = useState<'fixed' | 'percent'>('fixed');
  const [ruleValue, setRuleValue] = useState('');
  const add = () => {
    if (!name || !ruleValue) return;
    // fixed: rule_value хранится в minor-единицах валюты (02-data-schema); percent — «%» как есть.
    const value = ruleKind === 'fixed' ? toMinor(ruleValue, ccy) : ruleValue;
    create.mutate(
      { name, currency: ccy, ruleKind, ruleValue: value },
      { onSuccess: () => { setName(''); setRuleValue(''); } },
    );
  };
  return (
    <div className="card">
      <div className="micro">{t('obl.envelopes')}</div>
      {data.length === 0 && <div className="dim" style={{ marginTop: 12 }}>{t('common.empty')}</div>}
      {data.map((e) => (
        <div key={e.id} className="list-item">
          <span>{e.name} <span className="dim">· {e.ruleKind === 'percent' ? `${Number(e.ruleValue)}%` : `${formatMinor(e.ruleValue.split('.')[0] ?? '0', e.currency, locale)} ${e.currency}`}</span></span>
          <DelButton onClick={() => del.mutate(e.id)} />
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <input className="field" style={{ flex: 2, minWidth: 120 }} placeholder={t('common.name')} value={name} onChange={(ev) => setName(ev.target.value)} />
        <input className="field mono" style={{ width: 68 }} maxLength={3} value={ccy} onChange={(ev) => setCcy(ev.target.value.toUpperCase())} />
        <select className="field" style={{ width: 120 }} value={ruleKind} onChange={(ev) => setRuleKind(ev.target.value as 'fixed' | 'percent')}>
          <option value="fixed">{t('obl.rule.fixed')}</option>
          <option value="percent">{t('obl.rule.percent')}</option>
        </select>
        <input className="field mono" style={{ flex: 1, minWidth: 90 }} inputMode="decimal" placeholder={t('common.amount')} value={ruleValue} onChange={(ev) => setRuleValue(ev.target.value.replace(',', '.'))} />
        <button className="btn" disabled={create.isPending} onClick={add}>{t('common.add')}</button>
      </div>
    </div>
  );
}

function GoalsSection({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const { data = [] } = useEntities<Goal>('goals');
  const create = useCreateEntity('goals');
  const del = useDeleteEntity('goals');
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [target, setTarget] = useState('');
  const add = () => {
    if (!name || !target) return;
    create.mutate(
      { name, currency: ccy, targetMinor: toMinor(target, ccy) },
      { onSuccess: () => { setName(''); setTarget(''); } },
    );
  };
  return (
    <div className="card">
      <div className="micro">{t('obl.goals')}</div>
      {data.length === 0 && <div className="dim" style={{ marginTop: 12 }}>{t('common.empty')}</div>}
      {data.map((g) => (
        <div key={g.id} className="list-item">
          <span>{g.name}</span>
          <span className="row">
            <span className="mono">{formatMinor(g.savedMinor, g.currency, locale)} / {formatMinor(g.targetMinor, g.currency, locale)} {g.currency}</span>
            <DelButton onClick={() => del.mutate(g.id)} />
          </span>
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <input className="field" style={{ flex: 2, minWidth: 120 }} placeholder={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field mono" style={{ width: 68 }} maxLength={3} value={ccy} onChange={(e) => setCcy(e.target.value.toUpperCase())} />
        <input className="field mono" style={{ flex: 1, minWidth: 90 }} inputMode="decimal" placeholder={t('obl.target')} value={target} onChange={(e) => setTarget(e.target.value.replace(',', '.'))} />
        <button className="btn" disabled={create.isPending} onClick={add}>{t('common.add')}</button>
      </div>
    </div>
  );
}

function BucketsSection({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const { data = [] } = useEntities<Bucket>('buckets');
  const create = useCreateEntity('buckets');
  const del = useDeleteEntity('buckets');
  const [name, setName] = useState('');
  const [from, setFrom] = useState(base);
  const [to, setTo] = useState('EUR');
  const [amount, setAmount] = useState('');
  const add = () => {
    if (!name || !amount) return;
    create.mutate(
      { name, fromCurrency: from, toCurrency: to, amountMinor: toMinor(amount, from) },
      { onSuccess: () => { setName(''); setAmount(''); } },
    );
  };
  return (
    <div className="card">
      <div className="micro">{t('obl.buckets')}</div>
      {data.length === 0 && <div className="dim" style={{ marginTop: 12 }}>{t('common.empty')}</div>}
      {data.map((b) => (
        <div key={b.id} className="list-item">
          <span>{b.name} <span className="dim">· {b.fromCurrency} → {b.toCurrency}</span></span>
          <span className="row">
            <span className="mono">{formatMinor(b.amountMinor, b.fromCurrency, locale)} {b.fromCurrency}</span>
            <DelButton onClick={() => del.mutate(b.id)} />
          </span>
        </div>
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <input className="field" style={{ flex: 2, minWidth: 120 }} placeholder={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field mono" style={{ width: 62 }} maxLength={3} title={t('obl.from')} value={from} onChange={(e) => setFrom(e.target.value.toUpperCase())} />
        <input className="field mono" style={{ width: 62 }} maxLength={3} title={t('obl.to')} value={to} onChange={(e) => setTo(e.target.value.toUpperCase())} />
        <input className="field mono" style={{ flex: 1, minWidth: 90 }} inputMode="decimal" placeholder={t('common.amount')} value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} />
        <button className="btn" disabled={create.isPending} onClick={add}>{t('common.add')}</button>
      </div>
    </div>
  );
}

export function Obligations() {
  const { t } = useI18n();
  const { data: me } = useMe();
  const base = me?.workspace?.baseCurrency ?? 'RUB';
  return (
    <div style={{ padding: 24, maxWidth: 760, display: 'grid', gap: 20 }}>
      <h1 className="section-title">{t('obl.title')}</h1>
      <DebtsSection base={base} />
      <EnvelopesSection base={base} />
      <GoalsSection base={base} />
      <BucketsSection base={base} />
    </div>
  );
}
