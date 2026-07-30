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
      <div style={{ padding: 24 }} className="dim">
        {t('common.loading')}
      </div>
    );

  return (
    <div style={{ padding: 24, maxWidth: 560, display: 'grid', gap: 20 }}>
      <h1 className="section-title">{t('settings.title')}</h1>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
          {t('settings.currency')}
        </label>
        <input
          className="field mono"
          value={currency}
          maxLength={3}
          onChange={(e) => {
            setCurrency(e.target.value.toUpperCase());
            setSaved(false);
          }}
        />
      </div>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
          {t('settings.rhythm')}
        </label>
        <RhythmPicker
          value={rhythm}
          onChange={(next) => {
            setRhythm(next);
            setSaved(false);
          }}
          today={todayISO()}
        />
      </div>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>
          {t('settings.sources')}
        </label>
        <div className="card" style={{ display: 'grid', gap: 4 }}>
          {sources.map((s) => (
            <div key={s.id} className="list-item">
              <span>
                {s.label} <span className="dim">· {scheduleLabel(s.schedule)}</span>
                {s.stability === 'variable' && (
                  <span className="dim"> · {t('income.variable')}</span>
                )}
              </span>
              <span className="row">
                <span className="mono dim">
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
          <div className="row">
            <input
              className="field"
              style={{ flex: 2, minWidth: 110 }}
              aria-label={t('income.amounts.label')}
              placeholder={t('income.amounts.label')}
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
            <input
              className="field mono"
              style={{ width: 64 }}
              inputMode="numeric"
              aria-label={t('income.amounts.day')}
              value={draft.day}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                setDraft({ ...draft, day: n >= 1 && n <= 31 ? n : draft.day });
              }}
            />
            <input
              className="field mono"
              style={{ flex: 1, minWidth: 100 }}
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
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {saved && <span className="dim">{t('common.saved')}</span>}
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
