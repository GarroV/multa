import { useState } from 'react';
import { fromMajor, toMajorString, money, type Currency } from '@multa/core';
import { useI18n } from '../lib/i18n.tsx';
import { useIncomeSources, usePatchEntity, type EntityName } from '../lib/queries.ts';
import { Hint } from './ui/Hint.tsx';

/**
 * Правка строки обязательства на месте (issue #91).
 *
 * До этого долг, конверт, цель и корзину можно было только завести и удалить. Опечатка в названии
 * или неверная сумма чинились удалением строки — а вместе с долгом уходила история платежей и
 * прогноз закрытия. У категорий и источников дохода правка была, то есть однородные сущности вели
 * себя по-разному без всякой причины.
 *
 * Валюта не правится намеренно, и это ограничение продукта, а не недоделка: суммы хранятся в minor
 * units своей валюты, и смена валюты у существующей строки молча переозначила бы записанное число —
 * 50 000 копеек стали бы 50 000 центов. Валюту меняют новой строкой, там сумма вводится заново.
 */

export interface EditField {
  /** Поле сущности, как его ждёт API. */
  readonly key: string;
  readonly label: string;
  /** `minor` — деньги: показываем в major, отправляем в minor. `plain` — число как есть. */
  readonly kind: 'minor' | 'plain';
  readonly value: string;
}

/**
 * Сумма для ввода: то же число, без дорисованной дробной части.
 *
 * `toMajorString` всегда печатает разряды до конца — «20 000» превращается в «20000.00». В таблице
 * это уже правили (владелец заметил, что цифры меняются на глазах при входе в ячейку); в форме
 * лишние нули так же лишние, и продукт не должен показывать одно и то же число двумя способами.
 */
function forInput(minor: string, currency: string): string {
  return toMajorString(money(BigInt(minor), currency as Currency)).replace(/\.0+$/, '');
}

export function ObligationEdit({
  entity,
  id,
  name,
  currency,
  fields,
  steps: initialSteps,
  paymentsBySource,
  onDone,
}: {
  entity: EntityName;
  id: string;
  name: string;
  currency: string;
  fields: readonly EditField[];
  /**
   * Ступени суммы: «с такой-то даты платёж другой». Передаются только там, где имеют смысл — у
   * долга платёж меняется (банк пересчитал, ставка сменилась), у корзины сумма задаётся заново.
   */
  steps?: readonly { from: string; amountMinor: string }[] | null;
  /**
   * Разбивка платежа по выплатам (issue #117): сколько уходит с аванса, сколько с зарплаты.
   * Передаётся только долгам — у корзины и цели одной выплаты не бывает.
   */
  paymentsBySource?: readonly { sourceId: string; amountMinor: string }[] | null;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const patch = usePatchEntity(entity);
  const [draftName, setDraftName] = useState(name);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.key, f.kind === 'minor' ? forInput(f.value, currency) : f.value]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  /*
   * Разбивка по выплатам (issue #117). Открыта сразу, если она уже задана: прятать за кнопкой
   * собственную настройку человека значило бы скрыть от него то, что он сам завёл.
   */
  const [splitOpen, setSplitOpen] = useState((paymentsBySource ?? []).length > 0);
  const sources = useIncomeSources(paymentsBySource !== undefined);
  const [bySource, setBySource] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (paymentsBySource ?? []).map((p) => [p.sourceId, forInput(p.amountMinor, currency)]),
    ),
  );
  const [steps, setSteps] = useState(() =>
    (initialSteps ?? []).map((step) => ({
      from: step.from,
      amount: forInput(step.amountMinor, currency),
    })),
  );

  const save = () => {
    if (!draftName.trim()) return setError(t('obl.needName'));
    const body: Record<string, unknown> = { name: draftName.trim() };
    for (const f of fields) {
      const raw = (draft[f.key] ?? '').trim().replace(',', '.');
      if (f.kind === 'minor') {
        try {
          body[f.key] = fromMajor(raw, currency as Currency).minor.toString();
        } catch {
          return setError(t('spend.badAmount'));
        }
      } else {
        if (!/^\d+(\.\d+)?$/.test(raw)) return setError(t('spend.badAmount'));
        body[f.key] = raw;
      }
    }
    if (initialSteps !== undefined) {
      const parsed: { from: string; amountMinor: string }[] = [];
      for (const step of steps) {
        // Пустую строку молча выбрасываем: человек мог добавить ступень и передумать.
        if (!step.from && !step.amount.trim()) continue;
        if (!step.from) return setError(t('spend.badAmount'));
        try {
          parsed.push({
            from: step.from,
            amountMinor: fromMajor(
              step.amount.trim().replace(',', '.'),
              currency as Currency,
            ).minor.toString(),
          });
        } catch {
          return setError(t('spend.badAmount'));
        }
      }
      body.amountSteps = parsed;
    }

    if (paymentsBySource !== undefined && splitOpen) {
      const split: { sourceId: string; amountMinor: string }[] = [];
      for (const source of sources.data ?? []) {
        const raw = (bySource[source.id] ?? '').trim().replace(',', '.');
        // Пустое поле — «с этой выплаты не платим», а не ноль: это разные вещи.
        if (!raw) continue;
        try {
          split.push({
            sourceId: source.id,
            amountMinor: fromMajor(raw, currency as Currency).minor.toString(),
          });
        } catch {
          return setError(t('spend.badAmount'));
        }
      }
      /*
       * Пустую разбивку не отправляем вовсе: сервер понял бы её как «долг не платится ни с чего»,
       * и платёж молча стал бы нулевым.
       */
      if (split.length > 0) body.paymentsBySource = split;
    }
    setError(null);
    patch.mutate({ id, body }, { onSuccess: onDone });
  };

  return (
    <div className="prow">
      <span className="prow-day" aria-hidden />
      <span className="prow-bar prow-bar-full">
        <span className="fx-form">
          <span className="form-row">
            <input
              className="field grow"
              aria-label={t('obl.name')}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
            />
            {fields.map((f) => (
              <input
                key={f.key}
                className="field num field-w-lg"
                inputMode="decimal"
                aria-label={f.label}
                placeholder={f.label}
                value={draft[f.key] ?? ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            ))}
            <button type="button" className="btn" disabled={patch.isPending} onClick={save}>
              {t('common.save')}
            </button>
            <button type="button" className="act" onClick={onDone}>
              {t('common.cancel')}
            </button>
          </span>
          {/* Валюта показана, но не правится — см. комментарий к компоненту. */}
          <span className="sub dim">{currency}</span>

          {/*
            Разбивка платежа по выплатам (issue #117). За кнопкой, а не всегда на виду: у
            большинства долгов сумма одна на все выплаты, и четыре лишних поля в такой форме —
            шум. Открывший её видит по полю на каждый источник дохода воркспейса.
          */}
          {paymentsBySource !== undefined && !splitOpen && (
            <button type="button" className="act" onClick={() => setSplitOpen(true)}>
              {t('obl.split')}
            </button>
          )}
          {paymentsBySource !== undefined && splitOpen && (
            <>
              <span className="row row-gap-6">
                <span className="sub dim">{t('obl.split')}</span>
                <Hint text={t('obl.split.hint')} />
              </span>
              {(sources.data ?? []).map((source) => (
                <span className="form-row" key={source.id}>
                  <span className="sub grow">{source.label}</span>
                  <input
                    className="field num field-sm"
                    inputMode="decimal"
                    aria-label={source.label}
                    placeholder="—"
                    value={bySource[source.id] ?? ''}
                    onChange={(e) => setBySource({ ...bySource, [source.id]: e.target.value })}
                  />
                </span>
              ))}
            </>
          )}
          {initialSteps !== undefined && (
            <>
              <span className="row row-gap-6">
                <span className="sub dim">{t('rec.steps')}</span>
                <Hint text={t('rec.steps.hint')} />
              </span>
              {steps.map((step, i) => (
                <span className="form-row" key={i}>
                  <input
                    className="field"
                    type="date"
                    aria-label={t('rec.from')}
                    value={step.from}
                    onChange={(e) =>
                      setSteps(steps.map((x, j) => (i === j ? { ...x, from: e.target.value } : x)))
                    }
                  />
                  <input
                    className="field num field-w-lg"
                    inputMode="decimal"
                    aria-label={t('rec.amount')}
                    placeholder={t('rec.amount')}
                    value={step.amount}
                    onChange={(e) =>
                      setSteps(
                        steps.map((x, j) => (i === j ? { ...x, amount: e.target.value } : x)),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="act"
                    aria-label={t('common.delete')}
                    onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="act"
                onClick={() => setSteps([...steps, { from: '', amount: '' }])}
              >
                + {t('rec.steps.add')}
              </button>
            </>
          )}
          {error && <span className="sub danger">{error}</span>}
          {patch.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
        </span>
      </span>
    </div>
  );
}
