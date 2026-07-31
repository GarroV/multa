import { fromMajor } from '@multa/core';
import { useState, type ReactNode } from 'react';
import { Bar, Panel, Tag } from '../components/ui/Panel.tsx';
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

/**
 * Обязательства: долги, конверты, цели, валютные корзины. Экран редактора, а не витрины —
 * поэтому у каждой панели своя форма добавления в подвале, а строки показывают прогресс.
 *
 * Два правила, вынесенные из ревью (issue #20):
 * 1. Ошибка загрузки не притворяется пустотой. `data = []` при сбое рисовало «пока пусто», и
 *    человек заводил дубликаты долгов, думая, что их нет.
 * 2. Невалидная сумма не превращается в ноль. `'1 000'` или `'12.3.4'` раньше создавали
 *    обязательство на 0 без единого слова — теперь форма не отправляется и говорит, что не так.
 */

/** major-строка → minor или null. Null означает «не смогли понять», а не «ноль». */
function toMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    return fromMajor(s, ccy).minor.toString();
  } catch {
    // fromMajor бросает на превышении разрядности валюты — это тоже «не смогли понять».
    return null;
  }
}

/** Валюта: три латинские буквы, иначе сервер откажет, а форма промолчит. */
function isCurrency(ccy: string): boolean {
  return /^[A-Z]{3}$/.test(ccy);
}

interface SectionProps {
  base: string;
}

/** Обёртка панели раздела: состояние загрузки, ошибка и форма в подвале — одинаково у всех. */
function Section({
  label,
  accent,
  sum,
  isError,
  onRetry,
  rows,
  form,
  formError,
  mutationError,
}: {
  label: string;
  accent: 'mag' | 'cyan' | 'lime' | 'vio';
  sum?: string;
  isError: boolean;
  onRetry: () => void;
  rows: ReactNode;
  form: ReactNode;
  formError: string | null;
  mutationError: boolean;
}) {
  const { t } = useI18n();
  return (
    <Panel
      label={label}
      accent={accent}
      sum={sum}
      foot={
        <div className="fx-form">
          {form}
          {formError && <span className="sub danger">{formError}</span>}
          {mutationError && <span className="sub danger">⚠ {t('common.error')}</span>}
        </div>
      }
    >
      {isError ? (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="danger">{t('obl.loadFailed')}</span>
          </span>
          <span className="prow-num" />
          <button type="button" className="act" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        rows
      )}
    </Panel>
  );
}

function DebtsSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data = [], isError, refetch } = useEntities<Debt>('debts');
  const create = useCreateEntity('debts');
  const del = useDeleteEntity('debts');
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const principal = toMinor(amount, ccy);
    const pay = payment.trim() === '' ? '0' : toMinor(payment, ccy);
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(ccy)) return setError(t('obl.badCurrency'));
    if (principal === null || pay === null) return setError(t('spend.badAmount'));
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        currency: ccy,
        principalMinor: principal,
        remainingMinor: principal,
        paymentMinor: pay,
      },
      {
        onSuccess: () => {
          setName('');
          setAmount('');
          setPayment('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.debts')}
      accent="mag"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((d) => {
            const principal = BigInt(d.principalMinor);
            const remaining = BigInt(d.remainingMinor);
            const paid = principal - remaining;
            const share = principal > 0n ? Number((paid * 1000n) / principal) / 10 : 0;
            return (
              <div className="prow" key={d.id}>
                <span className="prow-day" aria-hidden />
                <span className="prow-name">
                  <span>{d.name}</span>
                  {d.currency !== base && <Tag tone="vio">{d.currency}</Tag>}
                </span>
                <span className="prow-num">
                  <b>
                    {formatMinor(d.paymentMinor, d.currency, locale)} {d.currency}
                  </b>
                  <i>{t('obl.payment')}</i>
                </span>
                <button
                  type="button"
                  className="act"
                  title={t('common.delete')}
                  onClick={() => del.mutate(d.id)}
                >
                  ✕
                </button>
                <span className="prow-bar">
                  <Bar share={share} tone="lime" label={d.name} />
                  <span className="prow-num">
                    <i>
                      {formatMinor(paid.toString(), d.currency, locale)} /{' '}
                      {formatMinor(d.principalMinor, d.currency, locale)}
                    </i>
                  </span>
                </span>
              </div>
            );
          })
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="field mono field-ccy"
              maxLength={3}
              aria-label={t('common.currency')}
              value={ccy}
              onChange={(e) => setCcy(e.target.value.toUpperCase())}
            />
          </div>
          <div className="form-row">
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('common.amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('obl.payment')}
              value={payment}
              onChange={(e) => setPayment(e.target.value)}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

function EnvelopesSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data = [], isError, refetch } = useEntities<Envelope>('envelopes');
  const create = useCreateEntity('envelopes');
  const del = useDeleteEntity('envelopes');
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [ruleKind, setRuleKind] = useState<'fixed' | 'percent'>('fixed');
  const [ruleValue, setRuleValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(ccy)) return setError(t('obl.badCurrency'));
    // fixed: rule_value хранится в minor-единицах валюты (02-data-schema); percent — «%» как есть.
    const value =
      ruleKind === 'fixed'
        ? toMinor(ruleValue, ccy)
        : /^\d+(\.\d+)?$/.test(ruleValue.trim().replace(',', '.'))
          ? ruleValue.trim().replace(',', '.')
          : null;
    if (value === null) return setError(t('spend.badAmount'));
    if (ruleKind === 'percent' && Number(value) > 100) return setError(t('obl.badPercent'));
    setError(null);
    create.mutate(
      { name: name.trim(), currency: ccy, ruleKind, ruleValue: value },
      {
        onSuccess: () => {
          setName('');
          setRuleValue('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.envelopes')}
      accent="cyan"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((e) => (
            <div className="prow" key={e.id}>
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span>{e.name}</span>
                <Tag tone={e.ruleKind === 'percent' ? 'cyan' : 'quiet'}>
                  {e.ruleKind === 'percent' ? t('obl.rule.percent') : t('obl.rule.fixed')}
                </Tag>
              </span>
              <span className="prow-num">
                <b>
                  {e.ruleKind === 'percent'
                    ? `${Number(e.ruleValue)}%`
                    : `${formatMinor(e.ruleValue.split('.')[0] ?? '0', e.currency, locale)} ${e.currency}`}
                </b>
              </span>
              <button
                type="button"
                className="act"
                title={t('common.delete')}
                onClick={() => del.mutate(e.id)}
              >
                ✕
              </button>
            </div>
          ))
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(ev) => setName(ev.target.value)}
            />
            <input
              className="field mono field-ccy"
              maxLength={3}
              aria-label={t('common.currency')}
              value={ccy}
              onChange={(ev) => setCcy(ev.target.value.toUpperCase())}
            />
          </div>
          <div className="form-row">
            <select
              className="field"
              aria-label={t('obl.rule.fixed')}
              value={ruleKind}
              onChange={(ev) => setRuleKind(ev.target.value as 'fixed' | 'percent')}
            >
              <option value="fixed">{t('obl.rule.fixed')}</option>
              <option value="percent">{t('obl.rule.percent')}</option>
            </select>
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('common.amount')}
              value={ruleValue}
              onChange={(ev) => setRuleValue(ev.target.value)}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

function GoalsSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data = [], isError, refetch } = useEntities<Goal>('goals');
  const create = useCreateEntity('goals');
  const del = useDeleteEntity('goals');
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const targetMinor = toMinor(target, ccy);
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(ccy)) return setError(t('obl.badCurrency'));
    if (targetMinor === null) return setError(t('spend.badAmount'));
    setError(null);
    create.mutate(
      { name: name.trim(), currency: ccy, targetMinor },
      {
        onSuccess: () => {
          setName('');
          setTarget('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.goals')}
      accent="lime"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((g) => {
            const target = BigInt(g.targetMinor);
            const saved = BigInt(g.savedMinor);
            const share = target > 0n ? Number((saved * 1000n) / target) / 10 : 0;
            return (
              <div className="prow" key={g.id}>
                <span className="prow-day" aria-hidden />
                <span className="prow-name">
                  <span>{g.name}</span>
                  {g.currency !== base && <Tag tone="vio">{g.currency}</Tag>}
                </span>
                <span className="prow-num">
                  <b>
                    {formatMinor(g.savedMinor, g.currency, locale)} /{' '}
                    {formatMinor(g.targetMinor, g.currency, locale)}
                  </b>
                </span>
                <button
                  type="button"
                  className="act"
                  title={t('common.delete')}
                  onClick={() => del.mutate(g.id)}
                >
                  ✕
                </button>
                <span className="prow-bar">
                  <Bar share={share} tone="lime" label={g.name} />
                  <span className="prow-num">
                    <i>{share.toFixed(0)}%</i>
                  </span>
                </span>
              </div>
            );
          })
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="field mono field-ccy"
              maxLength={3}
              aria-label={t('common.currency')}
              value={ccy}
              onChange={(e) => setCcy(e.target.value.toUpperCase())}
            />
          </div>
          <div className="form-row">
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('obl.target')}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

function BucketsSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data = [], isError, refetch } = useEntities<Bucket>('buckets');
  const create = useCreateEntity('buckets');
  const del = useDeleteEntity('buckets');
  const [name, setName] = useState('');
  const [from, setFrom] = useState(base);
  const [to, setTo] = useState('EUR');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const amountMinor = toMinor(amount, from);
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(from) || !isCurrency(to)) return setError(t('obl.badCurrency'));
    if (from === to) return setError(t('fx.sameCurrency'));
    if (amountMinor === null) return setError(t('spend.badAmount'));
    setError(null);
    create.mutate(
      { name: name.trim(), fromCurrency: from, toCurrency: to, amountMinor },
      {
        onSuccess: () => {
          setName('');
          setAmount('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.buckets')}
      accent="vio"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((b) => (
            <div className="prow" key={b.id}>
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span>{b.name}</span>
                <Tag tone="vio">
                  {b.fromCurrency} → {b.toCurrency}
                </Tag>
              </span>
              <span className="prow-num">
                <b>
                  {formatMinor(b.amountMinor, b.fromCurrency, locale)} {b.fromCurrency}
                </b>
              </span>
              <button
                type="button"
                className="act"
                title={t('common.delete')}
                onClick={() => del.mutate(b.id)}
              >
                ✕
              </button>
            </div>
          ))
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="field mono field-ccy"
              maxLength={3}
              aria-label={t('obl.from')}
              value={from}
              onChange={(e) => setFrom(e.target.value.toUpperCase())}
            />
            <span className="dim">→</span>
            <input
              className="field mono field-ccy"
              maxLength={3}
              aria-label={t('obl.to')}
              value={to}
              onChange={(e) => setTo(e.target.value.toUpperCase())}
            />
          </div>
          <div className="form-row">
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('common.amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

export function Obligations() {
  const { data: me } = useMe();
  const base = me?.workspace?.baseCurrency ?? 'RUB';
  return (
    <div className="dense">
      {/* Четыре вида обязательств равнозначны: две колонки, ни один не главнее. */}
      <div className="panels">
        <div className="col">
          <DebtsSection base={base} />
          <GoalsSection base={base} />
        </div>
        <div className="col">
          <EnvelopesSection base={base} />
          <BucketsSection base={base} />
        </div>
      </div>
    </div>
  );
}
