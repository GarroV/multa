import { fromMajor } from '@multa/core';
import { useState } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { useCreateCategory, useCreateEntity } from '../lib/queries.ts';
import { CurrencySelect } from './ui/CurrencySelect.tsx';
import { Select } from './ui/Select.tsx';

/**
 * Заведение строки прямо в мастер-таблице (запрос владельца 16.08.2026: «если я хочу добавить долг
 * то меня перекидывает на окно обязательств. так быть не должно»).
 *
 * Раньше плюс в таблице был ссылкой: он уводил на другой экран, где человек терял из виду ту самую
 * таблицу, ради которой пришёл. Таблица — рабочее место, а не витрина; заводить в ней строки нужно
 * не выходя.
 *
 * Раскладка намеренно та же, что у форм в разделах: первый ряд — название и валюта, второй — то,
 * что отличает раздел, и «Добавить». Одна и та же работа не должна выглядеть по-разному в
 * зависимости от того, откуда её начали.
 */

/** major-строка → minor. Мусор молча в ноль не превращаем: пустое поле и «абв» — разные вещи. */
function parseMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.').replace(/[\s ]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) return null;
  try {
    return fromMajor(s, ccy).minor.toString();
  } catch {
    return null;
  }
}

export function GridAddRow({
  kind,
  base,
  onDone,
}: {
  kind: string;
  base: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [ruleKind, setRuleKind] = useState<'fixed' | 'percent'>('fixed');
  const [invalid, setInvalid] = useState(false);

  const createDebt = useCreateEntity('debts');
  const createEnvelope = useCreateEntity('envelopes');
  const createGoal = useCreateEntity('goals');
  const createBucket = useCreateEntity('buckets');
  const createCategory = useCreateCategory();

  const pending =
    createDebt.isPending ||
    createEnvelope.isPending ||
    createGoal.isPending ||
    createBucket.isPending ||
    createCategory.isPending;

  const done = { onSuccess: () => onDone() };

  const submit = () => {
    const title = name.trim();
    if (!title) {
      setInvalid(true);
      return;
    }
    setInvalid(false);

    switch (kind) {
      case 'debt': {
        // Осталось и платёж — то самое единственное отличие долга от соседей.
        const remaining = parseMinor(first, ccy);
        const payment = parseMinor(second, ccy);
        if (!remaining || !payment) {
          setInvalid(true);
          return;
        }
        createDebt.mutate(
          {
            name: title,
            currency: ccy,
            // Заводим по остатку: сколько было изначально, человек здесь не вспоминает.
            principalMinor: remaining,
            remainingMinor: remaining,
            paymentMinor: payment,
          },
          done,
        );
        return;
      }
      case 'envelope': {
        const value = first.trim().replace(',', '.');
        if (!value || Number(value) <= 0) {
          setInvalid(true);
          return;
        }
        createEnvelope.mutate({ name: title, currency: ccy, ruleKind, ruleValue: value }, done);
        return;
      }
      case 'goal': {
        const target = parseMinor(first, ccy);
        if (!target) {
          setInvalid(true);
          return;
        }
        createGoal.mutate({ name: title, currency: ccy, targetMinor: target }, done);
        return;
      }
      case 'bucket': {
        const amount = parseMinor(first, ccy);
        if (!amount) {
          setInvalid(true);
          return;
        }
        // Корзина копит из базовой валюты в целевую: отдаём базовую, получаем выбранную.
        createBucket.mutate(
          { name: title, fromCurrency: base, toCurrency: ccy, amountMinor: amount },
          done,
        );
        return;
      }
      default:
        createCategory.mutate({ name: title }, done);
    }
  };

  /** Что стоит во втором ряду: у каждого раздела своё, но место одно и то же. */
  const specifics = () => {
    switch (kind) {
      case 'debt':
        return (
          <>
            <input
              className="field num field-sm"
              inputMode="decimal"
              placeholder={t('obl.remaining')}
              aria-label={t('obl.remaining')}
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
            <input
              className="field num field-sm"
              inputMode="decimal"
              placeholder={t('obl.payment')}
              aria-label={t('obl.payment')}
              value={second}
              onChange={(e) => setSecond(e.target.value)}
            />
          </>
        );
      case 'envelope':
        return (
          <>
            <Select
              className="field field-choice"
              label={t('obl.rule.how')}
              value={ruleKind}
              onChange={(next) => setRuleKind(next as 'fixed' | 'percent')}
              options={[
                { value: 'fixed', label: t('obl.rule.fixed') },
                { value: 'percent', label: t('obl.rule.percent') },
              ]}
            />
            <input
              className="field num field-sm"
              inputMode="decimal"
              placeholder={t('common.amount')}
              aria-label={t('common.amount')}
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
          </>
        );
      case 'category':
        // У расхода на этом шаге только имя: бюджет ставится прямо в ячейке периода.
        return null;
      default:
        return (
          <input
            className="field num field-sm"
            inputMode="decimal"
            placeholder={t('common.amount')}
            aria-label={t('common.amount')}
            value={first}
            onChange={(e) => setFirst(e.target.value)}
          />
        );
    }
  };

  return (
    <div className="mgrid-addform">
      <div className="form-row">
        <input
          className="field grow"
          autoFocus
          placeholder={t('common.name')}
          aria-label={t('common.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {kind !== 'category' && (
          <CurrencySelect
            value={ccy}
            onChange={setCcy}
            label={t('common.currency')}
            className="field mono field-ccy-wide"
          />
        )}
      </div>
      <div className="form-row">
        {specifics()}
        <button type="button" className="btn" disabled={pending} onClick={submit}>
          {pending ? t('common.loading') : t('common.add')}
        </button>
        {/*
          Отмена рядом с действием: передумать здесь так же нормально, как завести. Кнопка того же
          роста, что «Добавить», только тише — раньше тут стоял класс ярлыка, и рядом друг с другом
          они читались как разные породы элементов (замечание владельца 16.08.2026).
        */}
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          {t('common.cancel')}
        </button>
        {invalid && <span className="sub danger">{t('spend.badAmount')}</span>}
      </div>
    </div>
  );
}
