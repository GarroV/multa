import type { TranslationKey } from '@multa/i18n';
import { useI18n } from '../../lib/i18n.tsx';
import { useSectionVisible } from '../../lib/sections.ts';
import { formatMinor } from '../../lib/format.ts';
import { cascadeGroups, donutArcs } from '../../lib/planView.ts';
import type { PlanDto, PlanTargetKind } from '../../lib/queries.ts';

/**
 * Донат раздачи: куда ушла выплата по группам каскада (долги → корзины → конверты →
 * категории → цели) и сколько осталось на жизнь. Отвечает на вопрос «почему на жизнь столько,
 * а не больше» одной картинкой — без него каскад приходится складывать в голове.
 *
 * Дуги считает `planView.donutArcs` (там же тесты): длина окружности выбрана равной 100,
 * поэтому проценты кладутся в `stroke-dasharray` напрямую, без пересчётов в разметке.
 */

/* Радиус с запасом на толщину обводки: 12 + 7/2 = 15.5 < 16, круг целиком внутри viewBox.
   Длину контура нормирует `pathLength=100`, поэтому проценты дуг кладутся в dasharray напрямую. */
const RADIUS = 12;

const KIND_LABEL: Record<PlanTargetKind, TranslationKey> = {
  debt: 'plan.groups.debt',
  bucket: 'plan.groups.bucket',
  envelope: 'plan.groups.envelope',
  category: 'plan.groups.category',
  goal: 'plan.groups.goal',
};

/** Цвет группы берётся из тех же классов, что у точек легенды, — палитра ролей одна. */
const KIND_VAR: Record<PlanTargetKind, string> = {
  debt: 'var(--mag)',
  bucket: 'var(--vio)',
  envelope: 'var(--cyan)',
  category: 'var(--cyan-hi)',
  goal: 'var(--lime)',
};

export function CascadeDonut({ plan }: { plan: PlanDto }) {
  const { t, locale } = useI18n();
  /* Скрытые разделы (lib/sections.ts) не рисуем и здесь: раздел убран из интерфейса целиком, а
     не наполовину. Логика раздачи не тронута — сервер считает как считал. */
  const isSectionVisible = useSectionVisible();
  const groups = cascadeGroups(plan).filter((g) => isSectionVisible(g.kind));
  const arcs = donutArcs(groups);
  const fmt = (minor: string | bigint) => formatMinor(String(minor), plan.baseCurrency, locale);

  return (
    <div className="row donut-row">
      <svg className="donut" viewBox="0 0 32 32" aria-hidden>
        <circle className="track" cx="16" cy="16" r={RADIUS} pathLength={100} />
        {arcs.map((arc) => (
          <circle
            key={arc.kind}
            cx="16"
            cy="16"
            r={RADIUS}
            pathLength={100}
            stroke={KIND_VAR[arc.kind]}
            strokeDasharray={`${arc.length} ${100 - arc.length}`}
            strokeDashoffset={-arc.offset}
          />
        ))}
      </svg>
      <div className="legend">
        {groups.map((g) => (
          <div key={g.kind}>
            <span className={`dot k-${g.kind}`} aria-hidden />
            <span className="name">{t(KIND_LABEL[g.kind])}</span>
            <span className="val">{fmt(g.minor)}</span>
          </div>
        ))}
        {groups.length === 0 && <span className="sub">{t('plan.cascade.empty')}</span>}
      </div>
    </div>
  );
}
