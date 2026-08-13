import { fromMajor, rhythmMismatches, type IncomeSource } from '@multa/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { IncomeSourceList } from '../components/IncomeSourceList.tsx';
import { weekdayName } from '../components/IncomeEditor.tsx';
import { OnboardingShell } from '../components/OnboardingShell.tsx';
import { RhythmPicker } from '../components/RhythmPicker.tsx';
import { api } from '../lib/api.ts';
import { useToday } from '../lib/useToday.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  formatPayday,
  onboardingIncome,
  type IncomeMode,
  payoutsToSources,
  rhythmToConfig,
  rhythmToPayload,
  type PayoutForm,
  type RhythmForm,
  type SourcePayload,
  seedPayouts,
} from '../lib/income.ts';
import {
  useCreateEntity,
  useEntities,
  useSaveOnboardingIncome,
  type Bucket,
  type Debt,
  type MeDto,
  type WorkspaceDto,
} from '../lib/queries.ts';

/** major → minor или null (не подставляем 0 молча). */
function toMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    return fromMajor(s, ccy).minor.toString();
  } catch {
    return null;
  }
}

// --- Шаг 2: ритм планирования + источники дохода ---

/** Payload источников → доменный вид для проверки рассинхрона (суммы для неё не важны). */
function toProbeSources(sources: readonly SourcePayload[]): IncomeSource[] {
  return sources.map((s, i) => ({
    id: String(i),
    label: s.label,
    currency: s.currency,
    schedule: s.schedule as IncomeSource['schedule'],
    amount: { kind: 'absolute', amountMinor: 1n },
    stability: 'fixed',
    active: true,
  }));
}

function IncomeStep({ base, onDone }: { base: string; onDone: () => void }) {
  const { t, locale } = useI18n();
  // Воркспейс к этому шагу уже создан, значит таймзона известна — дату берём у сервера (#109).
  const today = useToday();
  /*
   * Первый вопрос шага — КАК приходят деньги, а не по каким числам. «По числам месяца» отвечает
   * оклад, но у смен, такси и торговли числа нет вовсе: живой тестер (05.08.2026) остановился
   * именно здесь, потому что вопрос был не про неё.
   */
  const [mode, setMode] = useState<IncomeMode>('monthly');
  const [oneOff, setOneOff] = useState({ label: '', amount: '', weekday: 5 });
  const [rhythm, setRhythm] = useState<RhythmForm>({
    kind: 'twiceMonthly',
    days: [10, 25],
    weeks: 2,
    anchorDate: today,
    weekendRule: 'before',
  });
  const [payouts, setPayouts] = useState<PayoutForm[]>(() => seedPayouts(locale));
  const [usePercent, setUsePercent] = useState(false);
  const [gross, setGross] = useState('');
  const save = useSaveOnboardingIncome();

  const sources = payoutsToSources(payouts, { currency: base, usePercent, gross });
  const irregular =
    mode === 'monthly' ? null : onboardingIncome({ mode, ...oneOff }, { currency: base, today });
  const canContinue =
    mode === 'monthly'
      ? sources.length > 0 && (rhythm.kind !== 'everyWeeks' || rhythm.anchorDate !== '')
      : irregular !== null;
  /* Расхождение «ритм против дат выплат» бывает только у выплат по числам: сравнивать нечего. */
  const mismatches =
    mode === 'monthly' && canContinue
      ? rhythmMismatches(
          rhythmToConfig(rhythm),
          toProbeSources(sources),
          rhythm.weekendRule,
          today,
          2,
        )
      : [];

  return (
    <OnboardingShell step={2}>
      <div>
        <h1 className="screen-title">{t('onboarding.payday.title')}</h1>
        <p className="dim screen-sub">{t('onboarding.payday.subtitle')}</p>
      </div>
      <div>
        <label className="micro field-legend">{t('onboarding.income.how')}</label>
        <div className="row">
          {(['monthly', 'weekly', 'daily'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className="chip"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {t(
                m === 'monthly'
                  ? 'income.kind.monthly'
                  : m === 'weekly'
                    ? 'income.kind.weekly'
                    : 'income.kind.daily',
              )}
            </button>
          ))}
        </div>
      </div>

      {mode === 'monthly' ? (
        <>
          <RhythmPicker value={rhythm} onChange={setRhythm} today={today} />
          <IncomeSourceList
            payouts={payouts}
            usePercent={usePercent}
            gross={gross}
            currency={base}
            onChange={setPayouts}
            onTogglePercent={setUsePercent}
            onGrossChange={setGross}
          />
        </>
      ) : (
        <div className="stack">
          <div className="form-row">
            <input
              className="field grow"
              aria-label={t('income.amounts.label')}
              placeholder={t('income.amounts.label')}
              value={oneOff.label}
              onChange={(e) => setOneOff({ ...oneOff, label: e.target.value })}
            />
            {mode === 'weekly' && (
              <select
                className="field field-sm"
                aria-label={t('income.kind.weekday')}
                value={oneOff.weekday}
                onChange={(e) => setOneOff({ ...oneOff, weekday: Number(e.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <option value={d} key={d}>
                    {weekdayName(d, locale)}
                  </option>
                ))}
              </select>
            )}
            <input
              className="field num field-sm"
              inputMode="decimal"
              aria-label={`${t('onboarding.income.perArrival')} · ${base}`}
              placeholder={t('onboarding.income.perArrival')}
              value={oneOff.amount}
              onChange={(e) => setOneOff({ ...oneOff, amount: e.target.value.replace(',', '.') })}
            />
          </div>
          {/* Границы периода — решение продукта, а не догадка о заработке: говорим об этом прямо. */}
          <p className="dim micro">{t('onboarding.income.periodNote')}</p>
        </div>
      )}
      {mismatches.map((date) => (
        <div className="note-band" key={date}>
          {t('income.amounts.mismatch', { date: formatPayday(date, locale) })}
        </div>
      ))}
      {save.isError && <div className="note-band">{t('common.error')}</div>}
      <div className="row-end">
        {/* Хотя бы одна валидная выплата обязательна: иначе план собрался бы на нуле. */}
        <button
          className="btn"
          disabled={save.isPending || !canContinue}
          onClick={() =>
            save.mutate(
              irregular
                ? {
                    rhythm: irregular.rhythm,
                    weekendRule: irregular.weekendRule,
                    sources: irregular.sources,
                  }
                : { rhythm: rhythmToPayload(rhythm), weekendRule: rhythm.weekendRule, sources },
              { onSuccess: onDone }, // НЕ инвалидируем 'me' — иначе гейт откроет приложение до шагов 3-4
            )
          }
        >
          {t('common.next')}
        </button>
      </div>
    </OnboardingShell>
  );
}

// --- Шаг 3: долги (пропускаемо) ---

/**
 * Онбординг: валюта (в `OnboardingCurrency`) и доход — всё.
 *
 * Долги и валютные корзины отсюда убраны намеренно (issue #28). Человек отвечал на них **ещё не
 * увидев продукт** — и отвечал наугад: «примерно сколько платишь по кредиту» без понимания, куда
 * это число пойдёт и что от него зависит. Обязательный минимум до первого расчёта — валюта, ритм и
 * сумма выплаты; всё остальное заводится потом, на «Обязательствах», куда зовёт обучающий тур.
 *
 * Так ага-момент наступает через два экрана вместо пяти: ради него всё и затевалось.
 */
export function Onboarding({ workspace }: { workspace: WorkspaceDto }) {
  const qc = useQueryClient();
  const base = workspace.baseCurrency;

  const finish = useMutation({
    mutationFn: async () => {
      await qc.invalidateQueries({ queryKey: ['plan'] });
      // Явный fetch (не invalidate): гейт App детерминированно → AppShell, а ошибка всплывает в isError.
      const me = await api<MeDto>('/v1/me');
      qc.setQueryData(['me'], me);
    },
  });

  return <IncomeStep base={base} onDone={() => finish.mutate()} />;
}
