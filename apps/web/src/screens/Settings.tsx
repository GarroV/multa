import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { BehaviourSettings } from '../components/BehaviourSettings.tsx';
import { ImportExcel } from '../components/ImportExcel.tsx';
import { RhythmPicker } from '../components/RhythmPicker.tsx';
import { useIsMember } from '../lib/role.ts';
import { Sharing } from '../components/Sharing.tsx';
import { TwoFactor } from '../components/TwoFactor.tsx';
import { Panel, Tag } from '../components/ui/Panel.tsx';
import { api } from '../lib/api.ts';
import { formatMinor } from '../lib/format.ts';
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

/**
 * Сумма источника для списка. Формат — как везде в колонке сумм (разряды, локаль): raw-major
 * давал «190000.00» рядом с «190,000» в плане, и глазом это читалось как разные числа.
 */
function amountLabel(amount: unknown, currency: string, locale: string): string {
  const a = amount as { kind?: string; amountMinor?: string; percent?: string };
  if (a?.kind === 'percent') return `${a.percent}%`;
  if (a?.kind === 'absolute' && a.amountMinor) {
    return formatMinor(a.amountMinor, currency, locale);
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
  // Участник совместного доступа: пишущие блоки настроек ему недоступны (issue #46).
  const isMember = useIsMember();
  const {
    data: sources = [],
    isError: sourcesFailed,
    refetch: refetchSources,
  } = useIncomeSources(Boolean(ws));
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
                <input
                  className="field num field-ccy"
                  aria-label={t('settings.currency')}
                  value={currency}
                  maxLength={3}
                  onChange={(e) => {
                    setCurrency(e.target.value.toUpperCase());
                    setSaved(false);
                  }}
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
              <span className="prow-bar" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <RhythmPicker
                  value={rhythm}
                  onChange={(next) => {
                    setRhythm(next);
                    setSaved(false);
                  }}
                  today={todayISO()}
                />
              </span>
            </div>
          </Panel>

          <BehaviourSettings />

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
          </Panel>

          <Sharing />
        </div>

        <Panel
          label={t('settings.sources')}
          accent="lime"
          foot={
            <div className="fx-form">
              <div className="form-row">
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
                  className="field num field-sm"
                  inputMode="decimal"
                  aria-label={`${t('income.amounts.amount')} · ${ws.baseCurrency}`}
                  placeholder={t('income.amounts.amount')}
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
              {/* Ввод, из которого не собирается источник, не должен выглядеть как «кнопка сломалась». */}
              {!draftPayload && (draft.label.trim() !== '' || draft.amount.trim() !== '') && (
                <span className="sub danger">{t('settings.sourceIncomplete')}</span>
              )}
              {addSource.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
              {removeSource.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
            </div>
          }
        >
          {/* Сбой загрузки не выдаём за «пусто»: иначе человек заведёт источник дохода второй раз. */}
          {sourcesFailed && (
            <div className="prow">
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span className="danger">{t('obl.loadFailed')}</span>
              </span>
              <span className="prow-num" />
              <button type="button" className="act" onClick={() => void refetchSources()}>
                {t('common.retry')}
              </button>
            </div>
          )}
          {!sourcesFailed && sources.length === 0 && (
            <div className="prow">
              <span />
              <span className="dim">{t('common.empty')}</span>
              <span />
              <span />
            </div>
          )}
          {sources.map((s) => (
            <div className="prow" key={s.id}>
              <span className="prow-day">{scheduleLabel(s.schedule)}</span>
              <span className="prow-name">
                <span>{s.label}</span>
                {s.stability === 'variable' && <Tag tone="amber">{t('income.variable')}</Tag>}
                {s.currency !== ws.baseCurrency && <Tag tone="vio">{s.currency}</Tag>}
              </span>
              <span className="prow-num">
                <b>
                  {amountLabel(s.amount, s.currency, locale)} {s.currency}
                </b>
              </span>
              <button
                type="button"
                className="act"
                aria-label={t('common.delete')}
                disabled={removeSource.isPending}
                onClick={() => removeSource.mutate(s.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}
