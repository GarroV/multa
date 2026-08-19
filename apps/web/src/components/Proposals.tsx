import { formatDate, formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useProposals, useResolveProposal } from '../lib/queries.ts';
import { useIsMember } from '../lib/role.ts';
import { Panel, Tag } from './ui/Panel.tsx';

/**
 * Лента предложений правок (issue #83).
 *
 * Участник совместного доступа не пишет в план — он предлагает, владелец решает. Панель появляется
 * только когда есть о чём решать: пустая лента у одинокого владельца была бы напоминанием о
 * функции, которой он не пользуется.
 *
 * Участнику показываем его же предложения со статусом: иначе он не узнает, приняли правку или нет,
 * и предложит то же самое ещё раз.
 */
export function Proposals({ base }: { base: string }) {
  const { t, locale } = useI18n();
  const isMember = useIsMember();
  const { data } = useProposals();
  const resolve = useResolveProposal();

  const all = data?.proposals ?? [];
  const pending = all.filter((p) => p.status === 'pending');
  /* Участнику интересна и судьба решённых, владельцу — только то, что ждёт его ответа. */
  const shown = isMember ? all.slice(0, 10) : pending;
  if (shown.length === 0) return null;

  const statusTag = (status: string) => {
    if (status === 'accepted') return <Tag tone="lime">{t('prop.accepted')}</Tag>;
    if (status === 'rejected') return <Tag>{t('prop.rejected')}</Tag>;
    return <Tag tone="amber">{t('prop.pending')}</Tag>;
  };

  return (
    <Panel label={t('prop.title')} accent="vio">
      {shown.map((p) => (
        <div className="prow" key={p.id}>
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            {/*
              Что именно предлагают: раздел, строка и период. Имя строки сюда не тянем — оно живёт
              в плане, а лента говорит «куда и сколько», чтобы решение можно было принять не уходя.
            */}
            <span>{t(`plan.groups.${p.targetKind}` as 'plan.groups.category')}</span>
            <Tag>{formatDate(p.startsOn)}</Tag>
            {isMember && statusTag(p.status)}
          </span>
          <span className="prow-num mono">{formatMinor(p.plannedMinor, base, locale)}</span>
          {!isMember && (
            <span className="row row-gap-8">
              <button
                type="button"
                className="btn"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ id: p.id, verdict: 'accept' })}
              >
                {t('prop.accept')}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ id: p.id, verdict: 'reject' })}
              >
                {t('prop.reject')}
              </button>
            </span>
          )}
        </div>
      ))}
      {resolve.isError && <div className="mgrid-note danger">{t('common.error')}</div>}
    </Panel>
  );
}
