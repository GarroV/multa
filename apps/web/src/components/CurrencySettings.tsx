import { useI18n } from '../lib/i18n.tsx';
import { usePatchSettings, useSettings } from '../lib/queries.ts';
import { Hint } from './ui/Hint.tsx';
import { Panel, Tag } from './ui/Panel.tsx';
import { Select } from './ui/Select.tsx';

/**
 * Настройки валюты и курса (issue #49).
 *
 * Источник курса и спред по умолчанию хранились на сервере с самого начала и не были выведены на
 * экран ни разу: человек не мог их изменить, а значит их как будто и не существовало. Ровно та же
 * болезнь, что у сорока мёртвых строк словаря, — код есть, пользы нет.
 *
 * Округление суммы к размену добавлено здесь же: никто не идёт в обменник менять 47 813 ₽. Только
 * вверх — вниз означало бы поменять меньше, чем нужно на обязательства периода.
 */

/** Шаги округления в major units: мелкие для валют вроде евро, крупные для рублей и тенге. */
const STEPS = [0, 100, 500, 1000, 5000] as const;

export function CurrencySettings() {
  const { t } = useI18n();
  const { data } = useSettings();
  const patch = usePatchSettings();
  if (!data) return null;

  return (
    <Panel
      label={t('set.currency.title')}
      accent="cyan"
      tools={patch.isError ? <Tag tone="mag">{t('common.error')}</Tag> : undefined}
    >
      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.currency.source')}</span>
        </span>
        <span className="prow-num" />
        <Select
          className="field field-choice"
          label={t('set.currency.source')}
          value={data.currency.rateSource}
          onChange={(next) =>
            patch.mutate({ currency: { rateSource: next as 'cbr' | 'ecb' | 'manual' } })
          }
          options={[
            { value: 'cbr', label: t('set.currency.source.cbr') },
            { value: 'ecb', label: t('set.currency.source.ecb') },
            { value: 'manual', label: t('set.currency.source.manual') },
          ]}
        />
      </div>

      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.currency.rounding')}</span>
          <Hint text={t('set.currency.rounding.hint')} />
        </span>
        <span className="prow-num" />
        <Select
          className="field field-choice"
          label={t('set.currency.rounding')}
          value={String(data.currency.exchangeRoundingMajor)}
          onChange={(next) => patch.mutate({ currency: { exchangeRoundingMajor: Number(next) } })}
          options={STEPS.map((step) => ({
            value: String(step),
            label: step === 0 ? t('set.currency.rounding.off') : String(step),
          }))}
        />
      </div>
    </Panel>
  );
}
