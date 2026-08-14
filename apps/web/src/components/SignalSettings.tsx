import { useState } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import { usePatchSettings, useSettings, type WorkspaceSettingsDto } from '../lib/queries.ts';
import { Hint } from './ui/Hint.tsx';
import { Panel, Tag } from './ui/Panel.tsx';

/**
 * Пороги сигналов (issue #49).
 *
 * Сигналы — то, ради чего продукт вмешивается в жизнь человека: он сам решает, когда сказать «так
 * ты не дотянешь». Пороги хранились на сервере с самого начала и ни разу не были выведены на экран,
 * то есть каждый жил с чужими цифрами: кому-то «за три дня» рано, кому-то «за неделю» поздно.
 *
 * Границы допустимого те же, что на сервере (`signalsSettings` в validation.ts). Дублирование
 * осознанное: сервер обязан проверять сам, но поле, которое молча не сохраняется, хуже поля, в
 * которое нельзя ввести лишнего.
 */

type SignalKey = 'burnThresholdDays' | 'runwayWarnDays' | 'lockedWarnPct' | 'maxSignals';

const LIMITS: Record<SignalKey, { min: number; max: number }> = {
  burnThresholdDays: { min: 1, max: 14 },
  runwayWarnDays: { min: 1, max: 90 },
  lockedWarnPct: { min: 10, max: 95 },
  maxSignals: { min: 3, max: 12 },
};

export function SignalSettings() {
  const { t } = useI18n();
  const { data } = useSettings();
  const patch = usePatchSettings();
  /*
   * Черновик ввода отдельно от сохранённого значения.
   *
   * Раньше поле показывало серверное число напрямую, и стереть его было нельзя: пустая строка не
   * проходит проверку, состояние не меняется, React возвращает прежнюю цифру — набирая «7» поверх
   * «3», человек получал «37». Найдено компонентным тестом, а не глазами.
   */
  const [draft, setDraft] = useState<Partial<Record<SignalKey, string>>>({});
  if (!data) return null;

  const row = (key: SignalKey) => {
    const { min, max } = LIMITS[key];
    return (
      <div className="prow" key={key}>
        <span className="prow-day" aria-hidden />
        <span className="prow-name">
          <span>{t(`set.signal.${key}`)}</span>
          <Hint text={t(`set.signal.${key}.hint`)} />
        </span>
        <span className="prow-num">
          <input
            className="field num field-xs"
            inputMode="numeric"
            aria-label={t(`set.signal.${key}`)}
            value={draft[key] ?? String(data.signals[key])}
            onChange={(e) => {
              const text = e.target.value.replace(/\D/g, '');
              // Показываем ровно то, что человек набрал, включая пустое поле и промежуточные цифры.
              setDraft({ ...draft, [key]: text });
              const n = Number(text);
              /*
               * На сервер уходит только допустимое. Молча подставить дефолт вместо введённого
               * значило бы решить за человека, а ругаться на каждую промежуточную цифру — мешать
               * набирать. Вне границ просто ничего не отправляется.
               */
              if (text !== '' && n >= min && n <= max) {
                patch.mutate({ signals: { [key]: n } as Partial<WorkspaceSettingsDto['signals']> });
              }
            }}
            onBlur={() => {
              // Ушёл, оставив мусор или пустоту — возвращаем сохранённое, а не держим ложь на экране.
              const { [key]: _dropped, ...rest } = draft;
              setDraft(rest);
            }}
          />
        </span>
        <span className="prow-note">{`${min}–${max}`}</span>
      </div>
    );
  };

  return (
    <Panel
      label={t('set.signals')}
      accent="mag"
      tools={patch.isError ? <Tag tone="mag">{t('common.error')}</Tag> : undefined}
    >
      {(Object.keys(LIMITS) as SignalKey[]).map(row)}
    </Panel>
  );
}
