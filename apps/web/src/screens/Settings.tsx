import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BehaviourSettings } from '../components/BehaviourSettings.tsx';
import { CurrencySettings } from '../components/CurrencySettings.tsx';
import { SignalSettings } from '../components/SignalSettings.tsx';
import { ImportExcel } from '../components/ImportExcel.tsx';
import { RhythmPicker } from '../components/RhythmPicker.tsx';
import { useIsMember } from '../lib/role.ts';
import { Sharing } from '../components/Sharing.tsx';
import { TwoFactor } from '../components/TwoFactor.tsx';
import { AccountData } from '../components/AccountData.tsx';
import { Panel } from '../components/ui/Panel.tsx';
import { CurrencySelect } from '../components/ui/CurrencySelect.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useToday } from '../lib/useToday.ts';
import { rhythmToPayload, type RhythmForm } from '../lib/income.ts';
import { useMe } from '../lib/queries.ts';

/** Ритм воркспейса → состояние формы. Незнакомый вид → дефолт «два раза в месяц». */
function toRhythmForm(
  rhythm: unknown,
  weekendRule: RhythmForm['weekendRule'],
  /* Дата параметром: это чистая функция вне компонента, хук здесь звать нельзя (#109). */
  today: string,
): RhythmForm {
  const r = rhythm as { kind?: string; days?: number[]; weeks?: number; startsOn?: string } | null;
  if (r?.kind === 'every-weeks') {
    return {
      kind: 'everyWeeks',
      days: [10, 25],
      weeks: r.weeks ?? 2,
      anchorDate: r.startsOn ?? today,
      weekendRule,
    };
  }
  if (r?.kind === 'monthly-days' && r.days?.length === 1) {
    return { kind: 'monthly', days: r.days, weeks: 2, anchorDate: today, weekendRule };
  }
  return {
    kind: 'twiceMonthly',
    days: r?.days ?? [10, 25],
    weeks: 2,
    anchorDate: today,
    weekendRule,
  };
}

/**
 * Настройки (прототип, issue #30): панели вместо столбика карточек. Тема и язык живут в топбаре —
 * их меняют на ходу, а не «настраивают», поэтому дублировать их здесь незачем.
 *
 * Сохранение говорит и об успехе, и о провале: раньше ошибка PATCH оставалась в мутации и экран
 * выглядел так, будто всё записалось.
 */
export function Settings() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const ws = me?.workspace;
  const today = useToday();
  // Участник совместного доступа: пишущие блоки настроек ему недоступны (issue #46).
  const isMember = useIsMember();

  const [currency, setCurrency] = useState(ws?.baseCurrency ?? 'RUB');
  const [rhythm, setRhythm] = useState<RhythmForm>(
    toRhythmForm(ws?.rhythm ?? null, ws?.weekendRule ?? 'before', today),
  );
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api('/v1/workspace', {
        method: 'PATCH',
        body: JSON.stringify({
          baseCurrency: currency.toUpperCase().slice(0, 3),
          rhythm: rhythmToPayload(rhythm),
          weekendRule: rhythm.weekendRule,
        }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      setSaved(true);
    },
  });

  if (!ws)
    return (
      <div className="dense">
        <div className="panels">
          <span className="sub">{t('common.loading')}</span>
        </div>
      </div>
    );

  return (
    <div className="dense">
      <div className="panels">
        <div className="col">
          <Panel
            label={t('settings.workspace')}
            sum={ws.timezone}
            tools={
              <>
                {saved && <span className="tag lime">{t('common.saved')}</span>}
                {save.isError && <span className="tag mag">{t('common.error')}</span>}
                <button
                  type="button"
                  className="act"
                  disabled={save.isPending}
                  onClick={() => save.mutate()}
                >
                  {t('common.save')}
                </button>
              </>
            }
          >
            <div className="prow">
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span>{t('settings.currency')}</span>
              </span>
              <span className="prow-num">
                <CurrencySelect
                  value={currency}
                  onChange={(next) => {
                    setCurrency(next);
                    setSaved(false);
                  }}
                  label={t('settings.currency')}
                  className="field num field-ccy-wide"
                />
              </span>
              <span />
            </div>
            <div className="prow">
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span>{t('settings.rhythm')}</span>
              </span>
              <span className="prow-num" />
              <span />
              <span className="prow-bar prow-bar-full">
                <RhythmPicker
                  value={rhythm}
                  onChange={(next) => {
                    setRhythm(next);
                    setSaved(false);
                  }}
                  today={today}
                />
              </span>
            </div>
          </Panel>

          <BehaviourSettings />

          {/* Источник курса и округление к размену: раньше жили только на сервере (#49). */}
          <CurrencySettings />

          {/* Пороги сигналов: раньше жили только на сервере, и каждый жил с чужими цифрами (#49). */}
          <SignalSettings />

          {/* Переезд с Excel пишет данные: участнику он вернул бы 403 на первом же шаге. */}
          {!isMember && <ImportExcel base={ws.baseCurrency} />}

          <Panel label={t('settings.account')} accent="vio">
            <div className="prow">
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span>{me?.user?.email ?? '—'}</span>
              </span>
              <span className="prow-num">
                <i>{me?.user?.name ?? ''}</i>
              </span>
              <span />
            </div>
            <TwoFactor enabled={me?.user?.twoFactorEnabled === true} />
            <AccountData email={me?.user?.email ?? null} />
          </Panel>

          <Sharing />
        </div>
      </div>
    </div>
  );
}
