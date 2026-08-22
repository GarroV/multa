import { useState } from 'react';
import { fromMajor, repeatRuleCandidates, toMajorString, money, type Currency } from '@multa/core';
import { useI18n } from '../lib/i18n.tsx';
import { Hint } from './ui/Hint.tsx';
import { repeatRuleLabel, scheduleLabel } from '../lib/repeatLabel.ts';
import { useToday } from '../lib/useToday.ts';
import { CurrencySelect } from './ui/CurrencySelect.tsx';
import { Select } from './ui/Select.tsx';
import { usePatchRecurring, type RecurringItemDto } from '../lib/queries.ts';

/**
 * Срок платежа и смена суммы — за контекстным меню строки (решение владельца 06.08.2026).
 *
 * Оба поля нужны редко, а места в строке занимали бы всегда: «интернет 2 500 до октября, потом
 * 4 000» человек задаёт один раз и больше к этому не возвращается. Поэтому строка остаётся из
 * названия, повтора и суммы, а срок и ступени открываются по «…».
 *
 * «С» и «По» — это срок жизни платежа: до первой даты события нет, после последней оно перестаёт
 * появляться, но остаётся в истории. Ступени — другое: они не создают и не убирают платёж, а
 * меняют его сумму с даты. Разные вещи и выглядят по-разному, иначе их путают.
 *
 * Валюта и повтор правятся здесь же (запрос владельца 22.08.2026). Валюту у обязательств менять
 * нельзя намеренно — там сумма живёт отдельно от формы и молча переозначилась бы, — а тут сумма и
 * валюта стоят рядом и сохраняются вместе: человек видит оба поля и подтверждает их одним «Сохранить».
 *
 * Варианты повтора выводит ядро от даты-якоря (`repeatRuleCandidates`): человек говорит «первый
 * раз 14-го», а «14-го числа / второй вторник / раз в год» предлагает продукт.
 */
export function RecurringMore({ item, onClose }: { item: RecurringItemDto; onClose: () => void }) {
  const { t } = useI18n();
  const today = useToday();
  const patch = usePatchRecurring();
  const ccy = item.currency as Currency;

  const [name, setName] = useState(item.name);
  const [currency, setCurrency] = useState(item.currency);
  const [amount, setAmount] = useState(() => toMajorString(money(BigInt(item.amountMinor), ccy)));
  const [from, setFrom] = useState(item.startsOn ?? '');
  const [to, setTo] = useState(item.endsOn ?? '');
  const [steps, setSteps] = useState(() =>
    (item.amountSteps ?? []).map((s) => ({
      from: s.from,
      amount: toMajorString(money(BigInt(s.amountMinor), ccy)),
    })),
  );
  const [reserve, setReserve] = useState(item.reserve);
  const [error, setError] = useState<string | null>(null);
  /*
   * Якорь повтора — дата «с», а если её нет, первая ступень или сегодня: варианты правила считаются
   * от конкретного дня («14-го числа» знает своё 14 только из даты). Пустой якорь оставил бы список
   * без вариантов, и повтор было бы не выбрать вовсе.
   */
  const anchor = from || item.startsOn || item.amountSteps?.[0]?.from || today;
  const rules = repeatRuleCandidates(anchor);
  /*
   * Правило меняется только осознанным выбором: `null` означает «оставить то, что было». Иначе
   * открытая форма молча переписывала бы расписание первым вариантом списка при каждом сохранении.
   */
  const [ruleIndex, setRuleIndex] = useState<string>('');

  const save = () => {
    const ccyNow = currency as Currency;
    const parsed: { from: string; amountMinor: string }[] = [];
    for (const step of steps) {
      // Пустую строку молча выбрасываем: человек мог добавить ступень и передумать.
      if (!step.from && !step.amount.trim()) continue;
      if (!step.from) return setError(t('rec.steps.add'));
      try {
        parsed.push({
          from: step.from,
          amountMinor: fromMajor(step.amount.trim().replace(',', '.'), ccyNow).minor.toString(),
        });
      } catch {
        return setError(t('spend.badAmount'));
      }
    }
    const trimmed = name.trim();
    if (!trimmed) return setError(t('obl.needName'));
    let amountMinor: string;
    try {
      amountMinor = fromMajor(amount.trim().replace(',', '.'), ccyNow).minor.toString();
    } catch {
      return setError(t('spend.badAmount'));
    }
    setError(null);
    patch.mutate(
      {
        id: item.id,
        name: trimmed,
        amountMinor,
        currency,
        // Расписание отправляем только если человек его выбрал: пустой выбор — «не трогать».
        ...(ruleIndex !== '' && rules[Number(ruleIndex)]
          ? { schedule: rules[Number(ruleIndex)]! }
          : {}),
        // null снимает ограничение; пустая строка из поля даты означает именно это.
        startsOn: from || null,
        endsOn: to || null,
        amountSteps: parsed,
        reserve,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="prow">
      <span className="prow-day" aria-hidden />
      <span className="prow-bar prow-bar-full">
        <span className="fx-form">
          {/*
            Название и сумма живут здесь же, а не за отдельной кнопкой: у строки уже есть «…», и
            вторая кнопка «править» рядом с ней означала бы, что правка разложена по двум местам без
            понятной границы. Раньше их нельзя было поправить вовсе — только удалить строку.
          */}
          <span className="form-row">
            <input
              className="field grow"
              aria-label={t('rec.name')}
              placeholder={t('rec.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="field num field-sm"
              inputMode="decimal"
              aria-label={`${t('rec.amount')} · ${currency}`}
              placeholder={t('rec.amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(',', '.'))}
            />
            {/*
              Валюта платежа рядом с суммой: «аренда 500» в Сербии и «аренда 500» в Москве — разные
              деньги, и решать это должен человек, а не подстановка базовой валюты.
            */}
            <CurrencySelect
              value={currency}
              onChange={setCurrency}
              label={t('common.currency')}
              className="field mono field-ccy-wide"
            />
          </span>

          <span className="form-row">
            <Select
              label={t('rec.repeat')}
              className="field grow"
              value={ruleIndex}
              onChange={setRuleIndex}
              options={[
                // Первый вариант — то, что уже стоит: список открывается на текущем состоянии.
                { value: '', label: scheduleLabel(item.schedule, t) },
                ...rules.map((rule, i) => ({ value: String(i), label: repeatRuleLabel(rule, t) })),
              ]}
            />
          </span>

          <span className="form-row">
            <label className="sub dim" htmlFor={`from-${item.id}`}>
              {t('rec.from')}
            </label>
            <input
              id={`from-${item.id}`}
              className="field"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <label className="sub dim" htmlFor={`to-${item.id}`}>
              {t('rec.to')}
            </label>
            <input
              id={`to-${item.id}`}
              className="field"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </span>

          <label className="row row-check">
            <input
              type="checkbox"
              checked={reserve}
              onChange={(e) => setReserve(e.target.checked)}
            />
            <span className="sub">{t('rec.reserve')}</span>
            {/* Почему не включено сразу — под знаком: иначе деньги посчитались бы дважды. */}
            <Hint text={t('rec.reserve.hint')} />
          </label>

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
                  setSteps(steps.map((s, j) => (i === j ? { ...s, from: e.target.value } : s)))
                }
              />
              <input
                className="field num field-w-lg"
                inputMode="decimal"
                aria-label={t('rec.amount')}
                placeholder={t('rec.amount')}
                value={step.amount}
                onChange={(e) =>
                  setSteps(steps.map((s, j) => (i === j ? { ...s, amount: e.target.value } : s)))
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

          <span className="form-row">
            <button
              type="button"
              className="act"
              onClick={() => setSteps([...steps, { from: '', amount: '' }])}
            >
              + {t('rec.steps.add')}
            </button>
            <button type="button" className="btn" disabled={patch.isPending} onClick={save}>
              {t('common.save')}
            </button>
            <button type="button" className="act" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </span>
          {error && <span className="sub danger">{error}</span>}
          {patch.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
        </span>
      </span>
    </div>
  );
}
