import { useI18n } from '../lib/i18n.tsx';
import type { TranslationKey } from '@multa/i18n';
import { usePatchSettings, useSettings, type GridSection } from '../lib/queries.ts';
import { Hint } from './ui/Hint.tsx';
import { Panel, Tag } from './ui/Panel.tsx';

/**
 * Настройки мастер-таблицы (решение владельца 22.08.2026: «все настройки таблицы убираем в
 * настройки, их потом отдельно будем пересматривать»).
 *
 * До этого они жили в трёх местах и ни одно не было настройкой: горизонт — состоянием экрана
 * (сбрасывался при перезагрузке), ширина первого столбца — записью в localStorage (у каждого
 * устройства своя, и телефон не знал, что настроено на ноутбуке), а какие разделы показывать —
 * константой в коде, править которую мог только тот, у кого есть репозиторий.
 *
 * Теперь всё это — настройки воркспейса: одинаковы на всех устройствах и переживают перезагрузку.
 * Таблица из «взгляда на данные» становится тем, чем её просили сделать, — рабочим инструментом,
 * который человек настраивает под себя.
 */

/** Горизонты, между которыми выбирают. Считаем в периодах, а не в месяцах: длина периода у всех своя. */
const HORIZONS = [6, 12, 24] as const;

/**
 * Разделы в порядке каскада — том же, в котором они идут в таблице и раздаются деньги. Счёт и доход
 * стоят рядом с ними: для человека это такие же строки таблицы, а не «другая механика».
 */
const SECTIONS: readonly GridSection[] = [
  'income',
  'debt',
  'bucket',
  'envelope',
  'category',
  'goal',
  'recurring',
  'account',
];

const SECTION_LABEL: Record<GridSection, TranslationKey> = {
  income: 'plan.groups.income',
  debt: 'plan.groups.debt',
  bucket: 'obl.buckets',
  envelope: 'plan.groups.envelope',
  category: 'plan.groups.category',
  goal: 'plan.groups.goal',
  recurring: 'plan.groups.recurring',
  account: 'acc.title',
};

export function GridSettings() {
  const { t } = useI18n();
  const { data } = useSettings();
  const patch = usePatchSettings();
  if (!data) return null;

  const grid = data.grid;

  return (
    <Panel
      label={t('set.grid.title')}
      accent="cyan"
      tools={patch.isError ? <Tag tone="mag">{t('common.error')}</Tag> : undefined}
    >
      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.grid.horizon')}</span>
          <Hint text={t('set.grid.horizon.hint')} />
        </span>
        <span className="prow-num" />
        <span className="seg" role="group" aria-label={t('set.grid.horizon')}>
          {HORIZONS.map((n) => (
            <button
              key={n}
              type="button"
              className="seg-btn"
              aria-pressed={n === grid.horizonPeriods}
              disabled={patch.isPending}
              onClick={() => patch.mutate({ grid: { horizonPeriods: n } })}
            >
              {n}
            </button>
          ))}
        </span>
      </div>

      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.grid.nameWidth')}</span>
          <Hint text={t('set.grid.nameWidth.hint')} />
        </span>
        <span className="prow-num" />
        {/*
          Ширину и так тянут мышью в самой таблице; здесь она числом — чтобы поставить ровное
          значение и чтобы было видно, что это настройка, а не память браузера.
        */}
        <input
          className="field num field-sm"
          type="number"
          inputMode="numeric"
          min={140}
          max={560}
          step={10}
          aria-label={t('set.grid.nameWidth')}
          value={grid.nameWidthPx}
          disabled={patch.isPending}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n >= 140 && n <= 560) patch.mutate({ grid: { nameWidthPx: n } });
          }}
        />
      </div>

      {/*
        Разделы: тумблер прячет раздел из интерфейса, но не удаляет данные. Строки, ручки API и
        таблицы остаются на месте — иначе «упростил экран» означало бы потерю того, что человек уже
        завёл, а вернуть это было бы нечем.
      */}
      <div className="prow">
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t('set.grid.sections')}</span>
          <Hint text={t('set.grid.sections.hint')} />
        </span>
        <span className="prow-bar prow-bar-full">
          <span className="row row-wrap">
            {SECTIONS.map((kind) => {
              const on = grid.sections[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  className={on ? 'act is-on' : 'act'}
                  aria-pressed={on}
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ grid: { sections: { [kind]: !on } } })}
                >
                  {t(SECTION_LABEL[kind])}
                </button>
              );
            })}
          </span>
        </span>
      </div>
    </Panel>
  );
}
