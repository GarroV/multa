import { Panel, Tag } from './ui/Panel.tsx';
import { useI18n } from '../lib/i18n.tsx';
import { usePatchSettings, useSettings } from '../lib/queries.ts';

/**
 * Настройки поведения (issue #49): буфер дневной цифры, порядок сжатия, горизонт медианы, советы,
 * курс и спред по умолчанию.
 *
 * Порядок сжатия показан списком «кто уступает первым» с подписью о том, что долги и валютные
 * корзины автоматика не режет ни при какой настройке: это инвариант продукта, и человек должен
 * видеть, что настройка его не отменяет.
 */

const COMPRESS_PRESETS: ('goal' | 'envelope' | 'category')[][] = [
  ['goal', 'envelope', 'category'],
  ['category', 'envelope', 'goal'],
  ['envelope', 'goal', 'category'],
];

const BUFFERS = [0, 5, 10] as const;

export function BehaviourSettings() {
  const { t } = useI18n();
  const { data } = useSettings();
  const patch = usePatchSettings();
  if (!data) return null;

  const orderLabel = (order: ('goal' | 'envelope' | 'category')[]) =>
    order.map((k) => t(`set.kind.${k}`)).join(' → ');

  return (
    <Panel
      label={t('set.behaviour')}
      accent="amber"
      tools={patch.isError ? <Tag tone="mag">{t('common.error')}</Tag> : undefined}
      foot={<span className="sub">{t('set.compressHint')}</span>}
    >
      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.buffer')}</span>
        </span>
        <span className="prow-num" />
        <span className="seg" role="group" aria-label={t('set.buffer')}>
          {BUFFERS.map((pct) => (
            <button
              key={pct}
              type="button"
              className="seg-btn"
              aria-pressed={data.cascade.bufferPct === pct}
              disabled={patch.isPending}
              onClick={() => patch.mutate({ cascade: { bufferPct: pct } })}
            >
              {pct}%
            </button>
          ))}
        </span>
        <span className="prow-note">{t('set.bufferHint')}</span>
      </div>

      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.compressOrder')}</span>
        </span>
        <span className="prow-num" />
        <span />
        <span className="prow-bar" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          <span className="row" style={{ gap: 6 }}>
            {COMPRESS_PRESETS.map((order) => (
              <button
                key={order.join('-')}
                type="button"
                className="act"
                aria-pressed={data.cascade.compressOrder.join('-') === order.join('-')}
                disabled={patch.isPending}
                onClick={() => patch.mutate({ cascade: { compressOrder: order } })}
              >
                {orderLabel(order)}
              </button>
            ))}
          </span>
        </span>
      </div>

      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.medianPeriods')}</span>
        </span>
        <span className="prow-num">
          <input
            className="field num field-xs"
            inputMode="numeric"
            aria-label={t('set.medianPeriods')}
            value={data.signals.medianPeriods}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ''));
              // Молча подставлять дефолт нельзя, поэтому отправляем только допустимое значение.
              if (n >= 2 && n <= 24) patch.mutate({ signals: { medianPeriods: n } });
            }}
          />
        </span>
        <span />
      </div>

      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.suggestRaises')}</span>
        </span>
        <span className="prow-num" />
        <button
          type="button"
          className="act"
          aria-pressed={data.periods.suggestRaises}
          disabled={patch.isPending}
          onClick={() => patch.mutate({ periods: { suggestRaises: !data.periods.suggestRaises } })}
        >
          {data.periods.suggestRaises ? t('common.on') : t('common.off')}
        </button>
      </div>

      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.defaultProvider')}</span>
        </span>
        <span className="prow-num">
          <input
            className="field field-sm"
            aria-label={t('set.defaultProvider')}
            defaultValue={data.currency.defaultProvider ?? ''}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value === (data.currency.defaultProvider ?? '')) return;
              patch.mutate({ currency: { defaultProvider: value === '' ? null : value } });
            }}
          />
        </span>
        <span />
      </div>

      {/* Явная дорога назад к обучению (issue #28): пропустить тур легко, найти его снова — нет. */}
      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('tour.restart')}</span>
        </span>
        <span className="prow-num" />
        {/*
          Кнопка всегда живая и всегда с одним словом. Первая версия гасила её, пока тур не пройден,
          и подписывала «идёт» — человек видел мёртвую кнопку с непонятным словом вместо действия.
        */}
        <button
          type="button"
          className="act"
          disabled={patch.isPending}
          onClick={() => patch.mutate({ tour: { planDone: false } })}
        >
          {t('tour.restartAction')}
        </button>
      </div>
    </Panel>
  );
}
