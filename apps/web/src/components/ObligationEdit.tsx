import { useState } from 'react';
import { fromMajor, toMajorString, money, type Currency } from '@multa/core';
import { useI18n } from '../lib/i18n.tsx';
import { usePatchEntity, type EntityName } from '../lib/queries.ts';

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

export function ObligationEdit({
  entity,
  id,
  name,
  currency,
  fields,
  steps: initialSteps,
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
  onDone: () => void;
}) {
  const { t } = useI18n();
  const patch = usePatchEntity(entity);
  const [draftName, setDraftName] = useState(name);
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.key,
        f.kind === 'minor' ? toMajorString(money(BigInt(f.value), currency as Currency)) : f.value,
      ]),
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState(() =>
    (initialSteps ?? []).map((step) => ({
      from: step.from,
      amount: toMajorString(money(BigInt(step.amountMinor), currency as Currency)),
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
          {initialSteps !== undefined && (
            <>
              <span className="sub dim">{t('rec.steps')}</span>
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
              <span className="sub dim">{t('rec.steps.hint')}</span>
            </>
          )}
          {error && <span className="sub danger">{error}</span>}
          {patch.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
        </span>
      </span>
    </div>
  );
}
