import { fromMajor, repeatRuleCandidates } from '@multa/core';
import { Fragment, useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useToday } from '../lib/useToday.ts';
import { RecurringMore } from './RecurringMore.tsx';
import { repeatRuleLabel, scheduleLabel } from '../lib/repeatLabel.ts';
import {
  useCreateRecurring,
  useDeleteRecurring,
  usePatchRecurring,
  useRecurringItems,
  type RecurringItemDto,
} from '../lib/queries.ts';
import { CurrencySelect } from './ui/CurrencySelect.tsx';
import { Panel, Tag } from './ui/Panel.tsx';
import { Select } from './ui/Select.tsx';

/**
 * Регулярные платежи (issues #21, #55) — подписки, аренда, страховка: то, что иначе приходится
 * помнить головой.
 *
 * До этого экрана они существовали только в API: в интерфейсе их было видно косвенно — меткой на
 * карте периода и строкой в «Что впереди». Управлять ими было нельзя вовсе, а значит и новые
 * правила повтора были недостижимы.
 *
 * Правило повтора выбирается не из абстрактного списка, а из первой даты: человек говорит «первый
 * раз 14 июля», и варианты («14-го числа», «каждый второй вторник», «раз в год») выводит ядро
 * (`repeatRuleCandidates`) — это календарная арифметика, ей не место в React (правило 4). Здесь
 * только подписи.
 */

/** major-строка → minor или null. Мусор молча в ноль не превращаем (правило ревью #20). */
function parseMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.').replace(/[\s ]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) return null;
  try {
    return fromMajor(s, ccy).minor.toString();
  } catch {
    return null;
  }
}

export function RecurringPayments({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const today = useToday();
  const { data: items = [], isError, refetch } = useRecurringItems();
  const create = useCreateRecurring();
  const patch = usePatchRecurring();
  const remove = useDeleteRecurring();

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(base);
  const [firstOn, setFirstOn] = useState(today);
  const [ruleIndex, setRuleIndex] = useState(0);
  const [invalid, setInvalid] = useState(false);
  /* Срок и ступени нужны редко — прячем их за «…», чтобы строка осталась из сути. */
  const [openMore, setOpenMore] = useState<string | null>(null);

  const rules = repeatRuleCandidates(firstOn);

  const submit = () => {
    const minor = parseMinor(amount, currency);
    const rule = rules[ruleIndex];
    if (!name.trim() || !minor || !rule) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    create.mutate(
      {
        name: name.trim(),
        amountMinor: minor,
        currency,
        schedule: rule,
        // Первая дата — якорь правила и одновременно начало жизни платежа.
        startsOn: firstOn,
      },
      {
        onSuccess: () => {
          setName('');
          setAmount('');
        },
      },
    );
  };

  if (isError) {
    return (
      <Panel label={t('rec.title')} accent="amber">
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="danger">{t('obl.loadFailed')}</span>
          </span>
          <span className="prow-num" />
          <button type="button" className="act" onClick={() => void refetch()}>
            {t('common.retry')}
          </button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      label={t('rec.title')}
      accent="amber"
      foot={
        /*
         * Раскладка та же, что у разделов обязательств: первый ряд — название и валюта, второй —
         * то, что отличает раздел, и «Добавить» (замечание владельца 16.08.2026: «почему у долгов
         * и регулярных платежей окна по разному идут, хотя по факту они почти одинаковые»).
         *
         * Здесь всё стояло одной строкой из пяти полей — рядом с двухрядными соседями это читалось
         * как другая форма, хотя суть одна: что, в какой валюте, сколько и по какому правилу.
         */
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('rec.name')}
              aria-label={t('rec.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {/*
              Валюта платежа (issue #115). Раньше её молча подставляли базовой, хотя вся остальная
              цепочка валюту поддерживает — и «аренда 500» в Сербии уходила как 500 в базовой, без
              единого признака ошибки на экране. По умолчанию базовая: частый случай не должен
              требовать лишнего клика, но и молчать о выборе нельзя.
            */}
            <CurrencySelect
              value={currency}
              onChange={setCurrency}
              label={t('common.currency')}
              className="field mono field-ccy-wide"
            />
          </div>
          <div className="form-row">
            <input
              className="field num field-sm"
              inputMode="decimal"
              placeholder="0"
              aria-label={t('rec.amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <input
              className="field num"
              type="date"
              aria-label={t('rec.firstOn')}
              value={firstOn}
              onChange={(e) => {
                setFirstOn(e.target.value || today);
                // Варианты повтора зависят от даты: старый выбор к новой дате уже не относится.
                setRuleIndex(0);
              }}
            />
            <Select
              className="field grow"
              label={t('rec.repeat')}
              value={String(ruleIndex)}
              onChange={(next) => setRuleIndex(Number(next))}
              options={rules.map((rule, i) => ({
                value: String(i),
                label: repeatRuleLabel(rule, t),
              }))}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={submit}>
              {create.isPending ? t('common.loading') : t('rec.add')}
            </button>
            {invalid && <span className="sub danger">{t('spend.badAmount')}</span>}
            {create.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
          </div>
        </>
      }
    >
      {items.length === 0 && (
        <div className="prow">
          <span />
          <span className="dim">{t('rec.empty')}</span>
          <span />
          <span />
        </div>
      )}
      {items.map((item) => (
        <Fragment key={item.id}>
          <div className="prow">
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              <span>{item.name}</span>
              <Tag>{scheduleLabel(item.schedule, t)}</Tag>
              {item.endsOn && <Tag tone="quiet">{t('rec.cancelled', { date: item.endsOn })}</Tag>}
              {item.currency !== base && <Tag tone="vio">{item.currency}</Tag>}
            </span>
            <span className="prow-num">
              <b>
                {formatMinor(item.amountMinor, item.currency, locale)} {item.currency}
              </b>
            </span>
            <span className="row row-tight">
              {/* Тумблер прячет метку на карте, но не событие: «что впереди» продолжает о нём знать. */}
              <button
                type="button"
                className="act"
                aria-pressed={item.showOnMap}
                title={t('rec.onMap')}
                onClick={() => patch.mutate({ id: item.id, showOnMap: !item.showOnMap })}
              >
                {item.showOnMap ? '◉' : '○'}
              </button>
              <button
                type="button"
                className="act"
                aria-pressed={openMore === item.id}
                /* Подпись обязана быть в aria-label: у кнопки есть текст «…», и он стал бы её
                   именем для экранного читателя — «многоточие» вместо «срок и смена суммы». */
                aria-label={t('rec.more')}
                title={t('rec.more')}
                onClick={() => setOpenMore(openMore === item.id ? null : item.id)}
              >
                …
              </button>
              <button
                type="button"
                className="act"
                title={t('common.delete')}
                disabled={remove.isPending}
                onClick={() => remove.mutate(item.id)}
              >
                ✕
              </button>
            </span>
          </div>
          {openMore === item.id && <RecurringMore item={item} onClose={() => setOpenMore(null)} />}
        </Fragment>
      ))}
    </Panel>
  );
}
