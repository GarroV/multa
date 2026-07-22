import { fromMajor, money, toMajorString } from '@multa/core';
import { useState } from 'react';
import { formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  useCategories,
  useClearCategoryBudget,
  useCreateCategory,
  useDeleteCategory,
  usePatchCategory,
  useSetCategoryBudget,
  type Category,
  type PlanAllocation,
} from '../lib/queries.ts';

/** major-строку → minor или null (не подставляем молча 0 на мусоре — см. правило валидации). */
function parseMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return fromMajor(s, ccy).minor.toString();
}

function CategoryRow({
  cat,
  budget,
  base,
  locale,
}: {
  cat: Category;
  budget: PlanAllocation | undefined;
  base: string;
  locale: string;
}) {
  const { t } = useI18n();
  const setBudget = useSetCategoryBudget();
  const clearBudget = useClearCategoryBudget();
  const patch = usePatchCategory();
  const del = useDeleteCategory();
  const [val, setVal] = useState(budget ? toMajorString(money(BigInt(budget.plannedMinor), base)) : '');

  const commit = () => {
    const s = val.trim();
    if (s === '' || Number(s.replace(',', '.')) === 0) {
      if (budget) clearBudget.mutate(cat.id);
      return;
    }
    const minor = parseMinor(s, base);
    if (minor === null) return; // невалидный ввод — не трогаем, не подставляем 0
    if (!budget || minor !== budget.plannedMinor) setBudget.mutate({ id: cat.id, plannedMinor: minor });
  };

  const trimmed = budget && BigInt(budget.shortfallMinor) > 0n;
  // Ошибка любой мутации строки не должна выглядеть как успех (тихий сбой) — подсвечиваем.
  const rowError = setBudget.isError || clearBudget.isError || patch.isError || del.isError;

  return (
    <div className="list-item">
      <span className="row" style={{ gap: 8 }}>
        <button
          className="btn btn-ghost"
          style={{ padding: '2px 8px' }}
          aria-pressed={cat.protected}
          title={t(cat.protected ? 'cat.protected.on' : 'cat.protected.off')}
          onClick={() => patch.mutate({ id: cat.id, protected: !cat.protected })}
        >
          {cat.protected ? '🔒' : '🔓'}
        </button>
        <span>{cat.name}</span>
        {trimmed && (
          <span className="badge-trim">
            {t('plan.row.trimmed', { amount: `${formatMinor(budget!.shortfallMinor, base, locale)} ${base}` })}
          </span>
        )}
        {rowError && <span className="danger" title={t('common.error')} style={{ fontSize: 13 }}>⚠ {t('common.retry')}</span>}
      </span>
      <span className="row" style={{ gap: 8 }}>
        <input
          className="field mono"
          style={{ width: 110, textAlign: 'right' }}
          inputMode="decimal"
          placeholder="0"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="dim mono" style={{ fontSize: 13, width: 34 }}>{base}</span>
        {!cat.isSystem && (
          <button className="btn btn-ghost" style={{ padding: '4px 10px' }} title={t('common.delete')} onClick={() => del.mutate(cat.id)}>
            ✕
          </button>
        )}
      </span>
    </div>
  );
}

/** Редактор бюджетов категорий на текущий период (04-web-ux §Категории). */
export function CategoryEditor({ allocations, base, locale }: { allocations: PlanAllocation[]; base: string; locale: string }) {
  const { t } = useI18n();
  const { data: categories = [] } = useCategories();
  const create = useCreateCategory();
  const [newName, setNewName] = useState('');

  const budgetByCat = new Map(allocations.filter((a) => a.targetKind === 'category').map((a) => [a.targetId, a]));

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate({ name }, { onSuccess: () => setNewName('') });
  };

  return (
    <div className="card">
      <div className="plan-group-head">
        <span className="micro">{t('plan.groups.category')}</span>
        <span className="dim" style={{ fontSize: 12 }}>{t('plan.category.budgetHint')}</span>
      </div>
      {categories.map((cat) => (
        <CategoryRow key={cat.id} cat={cat} budget={budgetByCat.get(cat.id)} base={base} locale={locale} />
      ))}
      <div className="row" style={{ marginTop: 14 }}>
        <input
          className="field"
          style={{ flex: 1, minWidth: 140 }}
          placeholder={t('cat.new.placeholder')}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn" disabled={create.isPending} onClick={add}>{t('common.add')}</button>
      </div>
      {create.isError && <div className="dim danger" style={{ marginTop: 8, fontSize: 13 }}>⚠ {t('common.error')}</div>}
    </div>
  );
}
