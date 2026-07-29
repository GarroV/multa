import type { TranslationKey } from '@multa/i18n';
import type { WeekendRule } from '@multa/core';
import { previewDates, type RhythmForm, type RhythmKind } from '../lib/income.ts';
import { useI18n } from '../lib/i18n.tsx';

const KINDS: { kind: RhythmKind; key: TranslationKey }[] = [
  { kind: 'twiceMonthly', key: 'income.rhythm.twiceMonthly' },
  { kind: 'monthly', key: 'income.rhythm.monthly' },
  { kind: 'everyWeeks', key: 'income.rhythm.everyWeeks' },
];

const WEEKEND_RULES: { rule: WeekendRule; key: TranslationKey }[] = [
  { rule: 'before', key: 'income.weekend.before' },
  { rule: 'after', key: 'income.weekend.after' },
  { rule: 'as-is', key: 'income.weekend.asIs' },
];

/** Число 1..31 из строки ввода; вне диапазона — прежнее значение (без молчаливой подмены). */
function clampDay(raw: string, fallback: number): number {
  const n = Number(raw.replace(/\D/g, ''));
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : fallback;
}

/**
 * Выбор ритма планирования: три варианта, редактируемые числа/дата якоря, правило выходных
 * и превью реальных дат из @multa/core — видно, что «10 и 25» и «каждые две недели» это разное.
 */
export function RhythmPicker({
  value,
  onChange,
  today,
}: {
  value: RhythmForm;
  onChange: (next: RhythmForm) => void;
  today: string;
}) {
  const { t, locale } = useI18n();
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const dates = previewDates(value, today, 3)
    .map((iso) => fmt.format(new Date(`${iso}T00:00:00Z`)))
    .join(' · ');

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
          {t('income.rhythm.title')}
        </label>
        <div className="row">
          {KINDS.map(({ kind, key }) => (
            <button
              key={kind}
              type="button"
              className="chip"
              aria-pressed={value.kind === kind}
              onClick={() => onChange({ ...value, kind })}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <p className="dim micro" style={{ marginTop: 8 }}>
          {t('income.rhythm.hint')}
        </p>
      </div>

      {value.kind === 'twiceMonthly' && (
        <div className="row">
          <label className="micro">{t('income.rhythm.days')}</label>
          {[0, 1].map((i) => (
            <input
              key={i}
              className="field mono"
              style={{ width: 64 }}
              inputMode="numeric"
              aria-label={t('income.rhythm.day')}
              value={value.days[i] ?? ''}
              onChange={(e) => {
                const days = [...value.days];
                days[i] = clampDay(e.target.value, value.days[i] ?? 1);
                onChange({ ...value, days });
              }}
            />
          ))}
        </div>
      )}

      {value.kind === 'monthly' && (
        <div className="row">
          <label className="micro">{t('income.rhythm.day')}</label>
          <input
            className="field mono"
            style={{ width: 64 }}
            inputMode="numeric"
            aria-label={t('income.rhythm.day')}
            value={value.days[0] ?? ''}
            onChange={(e) =>
              onChange({ ...value, days: [clampDay(e.target.value, value.days[0] ?? 1)] })
            }
          />
        </div>
      )}

      {value.kind === 'everyWeeks' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="row">
            <label className="micro">{t('income.rhythm.weeks')}</label>
            <input
              className="field mono"
              style={{ width: 64 }}
              inputMode="numeric"
              aria-label={t('income.rhythm.weeks')}
              value={value.weeks}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                onChange({ ...value, weeks: n >= 1 && n <= 12 ? n : value.weeks });
              }}
            />
          </div>
          <div>
            <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
              {t('income.rhythm.anchorDate')}
            </label>
            <input
              className="field mono"
              type="date"
              aria-label={t('income.rhythm.anchorDate')}
              value={value.anchorDate}
              onChange={(e) => onChange({ ...value, anchorDate: e.target.value })}
            />
          </div>
        </div>
      )}

      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
          {t('income.weekend.label')}
        </label>
        <div className="row">
          {WEEKEND_RULES.map(({ rule, key }) => (
            <button
              key={rule}
              type="button"
              className="chip"
              aria-pressed={value.weekendRule === rule}
              onClick={() => onChange({ ...value, weekendRule: rule })}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      <div className="note-band mono">{t('income.rhythm.preview', { dates })}</div>
    </div>
  );
}
