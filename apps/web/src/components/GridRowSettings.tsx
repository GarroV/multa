import { useState } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { useSheet } from '../lib/useSheet.ts';
import { envelopeEditFieldKind, envelopeEditFieldValue } from '../lib/envelopeView.ts';
import { ObligationEdit } from './ObligationEdit.tsx';
import { RecurringMore } from './RecurringMore.tsx';
import { IncomeSourceEdit } from './IncomeSourceEdit.tsx';
import { Hint } from './ui/Hint.tsx';
import {
  useCategories,
  useEntities,
  useIncomeSources,
  usePatchCategory,
  useRecurringItems,
  type Bucket,
  type Debt,
  type Envelope,
  type Goal,
} from '../lib/queries.ts';

/**
 * Настройки строки мастер-сетки: открываются нажатием на её название (запрос владельца 22.08.2026 —
 * «при нажатии на наименование строки затрат всплывало контекстное окно настройки, где можно
 * выбрать валюту, периодичность и прочие настройки, что у нас лежат в админке обязательств»).
 *
 * Своих форм здесь нет и быть не должно: лист показывает те же редакторы, что живут в разделах
 * («Обязательства», панель регулярных платежей, категории, доход). Вторая форма про ту же сущность
 * разошлась бы с первой — у одной появилось бы поле, у другой нет, — и человек перестал бы понимать,
 * какая из них настоящая.
 *
 * Смысл листа именно в дороге: из таблицы к настройке строки, не покидая таблицу. Раньше за валютой
 * или повтором приходилось уходить на другой экран и искать там ту же строку глазами.
 */
export function GridRowSettings({
  row,
  locale,
  onClose,
}: {
  row: { targetKind: string; targetId: string; name: string };
  locale: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  useSheet(onClose);

  return (
    <div
      className="sheet-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`${t('grid.row.settings')} · ${row.name}`}
    >
      <div className="sheet">
        <div className="row row-between-top">
          <div>
            <div className="strong">{row.name}</div>
            <div className="sub mt-xs">{t('grid.row.settings')}</div>
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

        <Body row={row} locale={locale} onClose={onClose} />
      </div>
    </div>
  );
}

/** Что показать внутри листа — решает вид строки: у каждой свой редактор, свой набор настроек. */
function Body({
  row,
  locale,
  onClose,
}: {
  row: { targetKind: string; targetId: string; name: string };
  locale: string;
  onClose: () => void;
}) {
  switch (row.targetKind) {
    case 'recurring':
      return <RecurringBody id={row.targetId} onClose={onClose} />;
    case 'debt':
      return <DebtBody id={row.targetId} onClose={onClose} />;
    case 'envelope':
      return <EnvelopeBody id={row.targetId} onClose={onClose} />;
    case 'goal':
      return <GoalBody id={row.targetId} onClose={onClose} />;
    case 'bucket':
      return <BucketBody id={row.targetId} onClose={onClose} />;
    case 'category':
      return <CategoryBody id={row.targetId} onClose={onClose} />;
    case 'income':
      return <IncomeBody id={row.targetId} locale={locale} onClose={onClose} />;
    default:
      return <NotFound />;
  }
}

/** Строка исчезла (удалили в другом окне) или вид неизвестен — говорим прямо, а не пустым листом. */
function NotFound() {
  const { t } = useI18n();
  return <div className="sub danger">{t('grid.row.gone')}</div>;
}

function Loading() {
  const { t } = useI18n();
  return <div className="sub dim">{t('common.loading')}</div>;
}

function RecurringBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isPending } = useRecurringItems();
  if (isPending) return <Loading />;
  const item = data?.find((r) => r.id === id);
  if (!item) return <NotFound />;
  return <RecurringMore item={item} onClose={onClose} />;
}

function DebtBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data, isPending } = useEntities<Debt>('debts');
  if (isPending) return <Loading />;
  const d = data?.find((x) => x.id === id);
  if (!d) return <NotFound />;
  return (
    <>
      <ObligationEdit
        entity="debts"
        id={d.id}
        name={d.name}
        currency={d.currency}
        steps={d.amountSteps}
        paymentsBySource={d.paymentsBySource ?? []}
        fields={[
          {
            key: 'paymentMinor',
            label: t('obl.payment'),
            kind: 'minor' as const,
            value: d.paymentMinor,
          },
        ]}
        onDone={onClose}
      />
      <CurrencyNote currency={d.currency} />
    </>
  );
}

function EnvelopeBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data, isPending } = useEntities<Envelope>('envelopes');
  if (isPending) return <Loading />;
  const e = data?.find((x) => x.id === id);
  if (!e) return <NotFound />;
  return (
    <>
      <ObligationEdit
        entity="envelopes"
        id={e.id}
        name={e.name}
        currency={e.currency}
        fields={[
          {
            key: 'ruleValue',
            label: t('obl.rule.fixed'),
            kind: envelopeEditFieldKind(e.ruleKind),
            value: envelopeEditFieldValue(e.ruleKind, String(e.ruleValue)),
          },
        ]}
        onDone={onClose}
      />
      <CurrencyNote currency={e.currency} />
    </>
  );
}

function GoalBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data, isPending } = useEntities<Goal>('goals');
  if (isPending) return <Loading />;
  const g = data?.find((x) => x.id === id);
  if (!g) return <NotFound />;
  return (
    <>
      <ObligationEdit
        entity="goals"
        id={g.id}
        name={g.name}
        currency={g.currency}
        fields={[
          {
            key: 'targetMinor',
            label: t('obl.target'),
            kind: 'minor' as const,
            value: g.targetMinor,
          },
          {
            key: 'plannedPerPeriodMinor',
            label: t('obl.perPeriod'),
            kind: 'minor' as const,
            value: g.plannedPerPeriodMinor,
          },
        ]}
        onDone={onClose}
      />
      <CurrencyNote currency={g.currency} />
    </>
  );
}

function BucketBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data, isPending } = useEntities<Bucket>('buckets');
  if (isPending) return <Loading />;
  const b = data?.find((x) => x.id === id);
  if (!b) return <NotFound />;
  return (
    <ObligationEdit
      entity="buckets"
      id={b.id}
      name={b.name}
      /* Сумма корзины задана в валюте-источнике: её и правим. */
      currency={b.fromCurrency}
      fields={[
        {
          key: 'amountMinor',
          label: t('obl.buckets'),
          kind: 'minor' as const,
          value: b.amountMinor,
        },
      ]}
      onDone={onClose}
    />
  );
}

/**
 * У категории настраивать нечего, кроме имени и защиты: бюджет — свойство периода и правится прямо
 * в ячейке, а валюты у категорий нет вовсе (расходы считаются в базовой).
 */
function CategoryBody({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const { data, isPending } = useCategories();
  const patch = usePatchCategory();
  const category = data?.find((c) => c.id === id);
  const [name, setName] = useState(category?.name ?? '');
  const [isProtected, setProtected] = useState(category?.protected ?? false);

  if (isPending) return <Loading />;
  if (!category) return <NotFound />;

  return (
    <div className="fx-form">
      <span className="form-row">
        <input
          className="field grow"
          aria-label={t('common.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </span>
      <label className="row row-check">
        <input
          type="checkbox"
          checked={isProtected}
          onChange={(e) => setProtected(e.target.checked)}
        />
        <span className="sub">{t('grid.row.protect')}</span>
        <Hint text={t(isProtected ? 'cat.protected.on' : 'cat.protected.off')} />
      </label>
      <span className="sub dim">{t('grid.row.categoryBudget')}</span>
      <span className="form-row">
        <button
          type="button"
          className="btn"
          disabled={patch.isPending || !name.trim()}
          onClick={() =>
            patch.mutate(
              { id: category.id, name: name.trim(), protected: isProtected },
              { onSuccess: onClose },
            )
          }
        >
          {t('common.save')}
        </button>
        <button type="button" className="act" onClick={onClose}>
          {t('common.cancel')}
        </button>
      </span>
      {patch.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
    </div>
  );
}

function IncomeBody({ id, locale, onClose }: { id: string; locale: string; onClose: () => void }) {
  const { data, isPending } = useIncomeSources();
  if (isPending) return <Loading />;
  const source = data?.find((s) => s.id === id);
  if (!source) return <NotFound />;
  return <IncomeSourceEdit source={source} locale={locale} onDone={onClose} />;
}

/**
 * Почему валюты нет в форме обязательства. Ограничение осознанное (см. шапку `ObligationEdit`):
 * суммы хранятся в minor units своей валюты, и смена валюты у существующей строки переозначила бы
 * записанное число. Молчать об этом нельзя — человек ищет поле и думает, что оно потерялось.
 */
function CurrencyNote({ currency }: { currency: string }) {
  const { t } = useI18n();
  return <span className="sub dim">{t('grid.row.currencyFixed', { ccy: currency })}</span>;
}
