import type { TranslationKey } from '@multa/i18n';
import { useState } from 'react';
import { useI18n } from '../lib/i18n.tsx';
import {
  usePatchSettings,
  useCreateInvite,
  useMembers,
  useRemoveMember,
  type ShareMode,
  type ShareSection,
} from '../lib/queries.ts';
import { Panel, Tag } from './ui/Panel.tsx';

/**
 * Совместный доступ (issue #46): участники и матрица видимости.
 *
 * Правило продукта, которое здесь надо не потерять в интерфейсе: **скрыть можно содержимое, но не
 * факт траты**. Поэтому у режимов честные подписи — «сумма» прямо говорит, что итог всё равно
 * виден, а «скрыто» — что деньги останутся в общем каскаде строкой «Личное». Иначе владелец решит,
 * что спрятал расход целиком, и удивится вопросу партнёра «а куда ушли 40 тысяч».
 *
 * Приглашение — код, а не письмо: почтового провайдера в профиле $0 нет.
 */

const SECTIONS: { key: ShareSection; label: TranslationKey }[] = [
  { key: 'income', label: 'share.sec.income' },
  { key: 'debts', label: 'plan.groups.debt' },
  { key: 'buckets', label: 'obl.buckets' },
  { key: 'envelopes', label: 'plan.groups.envelope' },
  { key: 'categories', label: 'plan.groups.category' },
  { key: 'goals', label: 'plan.groups.goal' },
];

const MODES: { key: ShareMode; label: TranslationKey }[] = [
  { key: 'open', label: 'share.mode.open' },
  { key: 'sum', label: 'share.mode.sum' },
  { key: 'hidden', label: 'share.mode.hidden' },
];

export function Sharing() {
  const { t } = useI18n();
  const { data, isError, refetch } = useMembers();
  const invite = useCreateInvite();
  const remove = useRemoveMember();
  const patch = usePatchSettings();
  const [code, setCode] = useState<string | null>(null);

  if (isError) {
    return (
      <Panel label={t('share.title')} accent="vio">
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
  if (!data) return null;

  // Участник состав не меняет и матрицу не видит: она — решение владельца о его собственных деньгах.
  const isOwner = data.role === 'owner';

  return (
    <Panel
      label={t('share.title')}
      accent="vio"
      foot={
        isOwner ? (
          <div className="form-row">
            <button
              type="button"
              className="btn"
              disabled={invite.isPending}
              onClick={() => invite.mutate(undefined, { onSuccess: (res) => setCode(res.code) })}
            >
              {invite.isPending ? t('common.loading') : t('share.invite')}
            </button>
            {code && <code className="mono">{code}</code>}
            <span className="sub">{t('share.inviteHint')}</span>
          </div>
        ) : (
          <span className="sub">{t('share.memberHint')}</span>
        )
      }
    >
      {data.members.map((m) => (
        <div className="prow" key={m.id}>
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span>{m.name}</span>
            <Tag tone={m.role === 'owner' ? 'lime' : 'quiet'}>
              {t(m.role === 'owner' ? 'share.role.owner' : 'share.role.member')}
            </Tag>
          </span>
          <span className="prow-num">
            <i>{m.email}</i>
          </span>
          {isOwner && m.role === 'member' ? (
            <button
              type="button"
              className="act"
              disabled={remove.isPending}
              title={t('share.remove')}
              onClick={() => remove.mutate(m.id)}
            >
              ✕
            </button>
          ) : (
            <span />
          )}
        </div>
      ))}

      {isOwner &&
        SECTIONS.map((section) => (
          <div className="prow" key={section.key}>
            <span className="prow-day" aria-hidden />
            <span className="prow-name">
              <span>{t(section.label)}</span>
            </span>
            <span className="prow-num" />
            <span className="seg" role="group" aria-label={t(section.label)}>
              {MODES.map((mode) => (
                <button
                  key={mode.key}
                  type="button"
                  className="seg-btn"
                  aria-pressed={data.sharing[section.key] === mode.key}
                  disabled={patch.isPending}
                  onClick={() => patch.mutate({ sharing: { [section.key]: mode.key } })}
                >
                  {t(mode.label)}
                </button>
              ))}
            </span>
          </div>
        ))}

      {isOwner && (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="sub">{t('share.matrixHint')}</span>
          </span>
          <span className="prow-num" />
          <span />
        </div>
      )}
    </Panel>
  );
}
