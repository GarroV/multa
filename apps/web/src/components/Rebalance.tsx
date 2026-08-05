import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useApplyRebalance, useRebalanceOptions } from '../lib/queries.ts';

/**
 * Пересборка плана (04-web-ux §Пересборка): заголовок без драмы, варианты по истории решений.
 * Порядок и бейдж «как обычно» приходят с сервера — считать их в компоненте было бы доменной
 * логикой в UI. Здесь только выбор и отправка.
 */
export function Rebalance({
  categoryId,
  categoryName,
  needMinor,
  base,
  locale,
  onClose,
}: {
  categoryId: string;
  categoryName: string;
  needMinor: string;
  base: string;
  locale: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { data: options = [], isLoading } = useRebalanceOptions(categoryId, needMinor);
  const apply = useApplyRebalance();

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('rebalance.open')}
    >
      <div className="sheet">
        <div className="row row-between-top">
          <div>
            <div className="title-md">{t('rebalance.title', { category: categoryName })}</div>
            <div className="dim mono note-tight text-sm">
              {t('rebalance.need')} {formatMinor(needMinor, base, locale)} {base}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            title={t('common.cancel')}
          >
            ✕
          </button>
        </div>

        {isLoading && <span className="dim">{t('common.loading')}</span>}

        {!isLoading && options.length === 0 && (
          <div className="note-band">{t('rebalance.empty')}</div>
        )}

        {options.map((o) => (
          <div key={`${o.targetKind}:${o.targetId}`} className="list-item">
            <span className="row row-8">
              <span>{o.name}</span>
              {o.usual && <span className="chip chip-xs">{t('rebalance.usual')}</span>}
              <span className="dim mono text-sm">
                {formatMinor(o.availableMinor, base, locale)} {base}
              </span>
            </span>
            <button
              type="button"
              className="btn"
              disabled={apply.isPending}
              onClick={() =>
                apply.mutate(
                  {
                    fromKind: o.targetKind,
                    fromId: o.targetId,
                    toId: categoryId,
                    amountMinor: o.takeMinor,
                  },
                  { onSuccess: onClose },
                )
              }
            >
              {t('rebalance.take', { amount: `${formatMinor(o.takeMinor, base, locale)} ${base}` })}
            </button>
          </div>
        ))}

        {apply.isError && <div className="sub danger">⚠ {t('common.error')}</div>}
      </div>
    </div>
  );
}
