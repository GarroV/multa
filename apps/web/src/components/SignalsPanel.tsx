import type { TranslationKey } from '@multa/i18n';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { formatDate, formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import {
  useGoalFreeze,
  useSetCategoryBudget,
  useSignals,
  type SignalActionDto,
  type SignalDto,
  type SignalMetricDto,
} from '../lib/queries.ts';
import { Rebalance } from './Rebalance.tsx';
import { Panel, Tag } from './ui/Panel.tsx';

/**
 * Сигналы (issue #50) — единственный список того, что требует решения сейчас.
 *
 * Раньше эта панель была разметкой: экран сам склеивал четыре источника, сам выбирал тон и не
 * давал ни одной кнопки. Теперь сигналы приходят сущностями с сервера, а компонент делает ровно
 * две вещи: подписывает правило словарём и превращает `action.kind` в уже существующую мутацию.
 *
 * Ни одной денежной формулы здесь нет и быть не может: суммы приходят посчитанными, компонент их
 * только форматирует.
 */

const SEVERITY_TONE = { risk: 'mag', attention: 'amber', opportunity: 'lime' } as const;

const ACTION_LABEL: Record<SignalActionDto['kind'], TranslationKey> = {
  rebalance: 'signal.act.rebalance',
  set_budget: 'signal.act.setBudget',
  freeze_goal: 'signal.act.freezeGoal',
  open: 'signal.act.open',
};

export function SignalsPanel({ base, locale }: { base: string; locale: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data, isError, refetch } = useSignals();
  const setBudget = useSetCategoryBudget();
  const freeze = useGoalFreeze();
  /** Пересборка открывается поверх: сигнал знает категорию, а откуда взять деньги — решает человек. */
  const [rebalanceFor, setRebalanceFor] = useState<{ id: string; name: string } | null>(null);

  const metricText = (metric: SignalMetricDto): string => {
    switch (metric.kind) {
      case 'money':
        return `${formatMinor(metric.minor, metric.currency, locale)} ${metric.currency}`;
      case 'percent':
        return `${Math.round(metric.bp / 100)}%`;
      case 'days':
        return t('signal.metric.days', { days: metric.days });
      case 'date':
        return formatDate(metric.on);
    }
  };

  /**
   * Параметры сигнала — сырые значения (суммы в minor units). Денежные приводим к виду человека
   * здесь: сервер формат не знает и знать не должен, а словарь получает уже готовую подстановку.
   */
  const textParams = (signal: SignalDto): Record<string, string | number> => {
    const out: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(signal.params)) {
      out[key] = key.endsWith('Minor')
        ? `${formatMinor(String(value), base, locale)} ${base}`
        : value;
    }
    return out;
  };

  const run = (signal: SignalDto, action: SignalActionDto) => {
    switch (action.kind) {
      case 'set_budget':
        setBudget.mutate({ id: action.targetId, plannedMinor: action.amountMinor });
        return;
      case 'freeze_goal':
        freeze.mutate({ goalId: action.targetId, frozen: true });
        return;
      case 'rebalance':
        setRebalanceFor({ id: action.targetId, name: signal.targetName ?? '' });
        return;
      case 'open':
        void navigate({ to: `/${action.screen}` });
        return;
    }
  };

  if (isError) {
    return (
      <Panel label={t('stats.signals')} accent="amber">
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="danger">{t('obl.loadFailed')}</span>
          </span>
          <span className="prow-num" />
          <button type="button" className="act" onClick={() => void refetch()}>
            {t('common.retry')}
          </button>
        </div>
      </Panel>
    );
  }

  const signals = data?.signals ?? [];
  const worst = signals[0]?.severity;

  return (
    <>
      {rebalanceFor && (
        <Rebalance
          categoryId={rebalanceFor.id}
          categoryName={rebalanceFor.name}
          needMinor="0"
          base={base}
          locale={locale}
          onClose={() => setRebalanceFor(null)}
        />
      )}
      <Panel
        label={t('stats.signals')}
        slot="signals"
        accent={worst === 'risk' ? 'mag' : worst === 'attention' ? 'amber' : 'cyan'}
      >
        {signals.length === 0 && (
          <div className="prow">
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              <span>{t('signal.ok')}</span>
            </span>
            <span className="prow-num" />
            <span />
          </div>
        )}
        {signals.map((signal) => (
          <div className="prow" key={signal.id}>
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              <span>{t(`signal.${signal.rule}.title` as TranslationKey, textParams(signal))}</span>
              <Tag tone={SEVERITY_TONE[signal.severity]}>{t(`stats.tone.${signal.severity}`)}</Tag>
            </span>
            <span className="prow-num">
              <b>{metricText(signal.metric)}</b>
            </span>
            <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
              {signal.actions.map((action) => (
                <button
                  key={action.kind}
                  type="button"
                  className="act"
                  disabled={setBudget.isPending || freeze.isPending}
                  onClick={() => run(signal, action)}
                >
                  {t(ACTION_LABEL[action.kind])}
                </button>
              ))}
            </span>
            <span className="prow-note">
              {t(`signal.${signal.rule}.body` as TranslationKey, textParams(signal))}
            </span>
          </div>
        ))}
      </Panel>
    </>
  );
}
