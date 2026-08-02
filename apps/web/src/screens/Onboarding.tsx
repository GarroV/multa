import { fromMajor, rhythmMismatches, type IncomeSource } from '@multa/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { IncomeSourceList } from '../components/IncomeSourceList.tsx';
import { OnboardingShell } from '../components/OnboardingShell.tsx';
import { RhythmPicker } from '../components/RhythmPicker.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  formatPayday,
  payoutsToSources,
  rhythmToConfig,
  rhythmToPayload,
  type PayoutForm,
  type RhythmForm,
  type SourcePayload,
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

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/**
 * Сид меток выплат — ДАННЫЕ пользователя, не строки интерфейса, поэтому i18n-ключей у них нет:
 * подставляем на языке локали и даём переписать.
 */
const SEED_LABELS: Record<'ru' | 'en', [string, string]> = {
  ru: ['Аванс', 'Зарплата'],
  en: ['Advance', 'Salary'],
};

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
  const today = todayISO();
  const [rhythm, setRhythm] = useState<RhythmForm>({
    kind: 'twiceMonthly',
    days: [10, 25],
    weeks: 2,
    anchorDate: today,
    weekendRule: 'before',
  });
  const [payouts, setPayouts] = useState<PayoutForm[]>(() => {
    const [first, second] = SEED_LABELS[locale];
    return [
      { label: first, day: 10, amount: '', percent: '' },
      { label: second, day: 25, amount: '', percent: '' },
    ];
  });
  const [usePercent, setUsePercent] = useState(false);
  const [gross, setGross] = useState('');
  const save = useSaveOnboardingIncome();

  const sources = payoutsToSources(payouts, { currency: base, usePercent, gross });
  const canContinue =
    sources.length > 0 && (rhythm.kind !== 'everyWeeks' || rhythm.anchorDate !== '');
  const mismatches = canContinue
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
        <h1 style={{ margin: 0, fontSize: 32 }}>{t('onboarding.payday.title')}</h1>
        <p className="dim" style={{ marginTop: 8 }}>
          {t('onboarding.payday.subtitle')}
        </p>
      </div>
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
      {mismatches.map((date) => (
        <div className="note-band" key={date}>
          {t('income.amounts.mismatch', { date: formatPayday(date, locale) })}
        </div>
      ))}
      {save.isError && <div className="note-band">{t('common.error')}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {/* Хотя бы одна валидная выплата обязательна: иначе план собрался бы на нуле. */}
        <button
          className="btn"
          disabled={save.isPending || !canContinue}
          onClick={() =>
            save.mutate(
              { rhythm: rhythmToPayload(rhythm), weekendRule: rhythm.weekendRule, sources },
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
