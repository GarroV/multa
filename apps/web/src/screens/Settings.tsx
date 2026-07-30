import { money, toMajorString } from '@multa/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RhythmPicker } from '../components/RhythmPicker.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { payoutsToSources, rhythmToPayload, type RhythmForm } from '../lib/income.ts';
import {
  useCreateIncomeSource,
  useDeleteIncomeSource,
  useIncomeSources,
  useMe,
} from '../lib/queries.ts';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** Ритм воркспейса → состояние формы. Незнакомый вид → дефолт «два раза в месяц». */
function toRhythmForm(rhythm: unknown, weekendRule: RhythmForm['weekendRule']): RhythmForm {
  const r = rhythm as { kind?: string; days?: number[]; weeks?: number; startsOn?: string } | null;
  const today = todayISO();
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

/** Сумма источника в major-строке — для отображения в списке. */
function amountLabel(amount: unknown, currency: string): string {
  const a = amount as { kind?: string; amountMinor?: string; percent?: string };
  if (a?.kind === 'percent') return `${a.percent}%`;
  if (a?.kind === 'absolute' && a.amountMinor) {
    return toMajorString(money(BigInt(a.amountMinor), currency));
  }
  return '—';
}

/** Читаемое расписание источника. */
function scheduleLabel(schedule: unknown): string {
  const s = schedule as { kind?: string; days?: number[]; weeks?: number; date?: string };
  if (s?.kind === 'monthly-days') return (s.days ?? []).join(', ');
  if (s?.kind === 'every-weeks') return `×${s.weeks}`;
  if (s?.kind === 'one-off') return s.date ?? '—';
  return '—';
}

export function Settings() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const ws = me?.workspace;
  const { data: sources = [] } = useIncomeSources(Boolean(ws));
  const removeSource = useDeleteIncomeSource();
  const addSource = useCreateIncomeSource();

  // Новая выплата: метка + число месяца + сумма. Здесь же закрывается путь после «пропустить настройку».
  const [draft, setDraft] = useState({ label: '', day: 25, amount: '' });
  const draftPayload = payoutsToSources([{ ...draft, percent: '' }], {
    currency: ws?.baseCurrency ?? 'RUB',
    usePercent: false,
    gross: '',
  })[0];

  const [currency, setCurrency] = useState(ws?.baseCurrency ?? 'RUB');
  const [rhythm, setRhythm] = useState<RhythmForm>(
    toRhythmForm(ws?.rhythm ?? null, ws?.weekendRule ?? 'before'),
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
      <div className="page sub">
        {t('common.loading')}
      </div>
    );

  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <div className="page-head">
        <h1 className="page-title">{t('settings.title')}</h1>
      </div>
      <section className="tile tile-wide">
        <span className="micro">{t('settings.currency')}</span>
        <input
          className="field num field-sm"
          value={currency}
          maxLength={3}
          onChange={(e) => {
            setCurrency(e.target.value.toUpperCase());
            setSaved(false);
          }}
        />
      </section>
      <section className="tile tile-wide">
        <span className="micro">{t('settings.rhythm')}</span>
        <RhythmPicker
          value={rhythm}
          onChange={(next) => {
            setRhythm(next);
            setSaved(false);
          }}
          today={todayISO()}
        />
      </section>
      <section className="tile tile-wide">
        <span className="micro">{t('settings.sources')}</span>
          {sources.map((s) => (
            <div key={s.id} className="list-item">
              <span>
                {s.label} <span className="sub">· {scheduleLabel(s.schedule)}</span>
                {s.stability === 'variable' && (
                  <span className="sub"> · {t('income.variable')}</span>
                )}
              </span>
              <span className="row">
                <span className="num sub">
                  {amountLabel(s.amount, s.currency)} {s.currency}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={t('common.cancel')}
                  disabled={removeSource.isPending}
                  onClick={() => removeSource.mutate(s.id)}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
          <div className="form-row" style={{ marginTop: 6 }}>
            <input
              className="field grow"
              aria-label={t('income.amounts.label')}
              placeholder={t('income.amounts.label')}
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <input
              className="field num field-ccy"
              inputMode="numeric"
              aria-label={t('income.amounts.day')}
              value={draft.day}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                setDraft({ ...draft, day: n >= 1 && n <= 31 ? n : draft.day });
              }}
            />
            <input
              className="field num grow"
              inputMode="decimal"
              aria-label={t('income.amounts.amount')}
              placeholder={`${t('income.amounts.amount')} · ${ws.baseCurrency}`}
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value.replace(',', '.') })}
            />
            <button
              type="button"
              className="btn"
              disabled={addSource.isPending || !draftPayload}
              onClick={() =>
                draftPayload &&
                addSource.mutate(
                  { ...draftPayload, sort: sources.length },
                  { onSuccess: () => setDraft({ label: '', day: 25, amount: '' }) },
                )
              }
            >
              {t('common.add')}
            </button>
          </div>
      </section>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {saved && <span className="sub st-ok">{t('common.saved')}</span>}
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
