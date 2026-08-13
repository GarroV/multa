import type { TranslationKey } from '@multa/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ReceiptEntry } from './components/ReceiptEntry.tsx';
import { SpendEntry } from './components/SpendEntry.tsx';
import { authClient } from './lib/authClient.ts';
import { useI18n } from './lib/i18n.tsx';
import { useFlushOutbox, useMe, useMembers } from './lib/queries.ts';
import { queueSize } from './lib/outbox.ts';
import { useOnline } from './lib/useOnline.ts';
import { IconEye, IconPanels, IconTable } from './components/ui/icons.tsx';
import { useTheme } from './lib/theme.ts';

/**
 * Оболочка по прототипу (issue #30): навигация сверху, а не сайдбаром. Причина не в моде —
 * сайдбар забирал 216px ширины у ведомости, а плотный экран живёт шириной колонок. Табы, ввод
 * факта, тема и язык стоят в одной строке: всё управление в 48px высоты.
 */

const NAV: { to: string; key: TranslationKey; ownerOnly?: true }[] = [
  { to: '/plan', key: 'nav.plan' },
  /*
   * «Статистика» участнику пока закрыта: её ручки (аналитика категорий, спред по провайдерам,
   * история разменов) матрицу видимости ещё не умеют — issue #84. Открывать вкладку раньше, чем
   * это сделано, значит вести человека на экран из сообщений об отказе.
   */
  { to: '/statistics', key: 'nav.statistics', ownerOnly: true },
  { to: '/obligations', key: 'nav.obligations' },
  { to: '/settings', key: 'nav.settings' },
];

type PlanSearch = { view?: 'table'; as?: 'member' };

/**
 * Инструменты экрана «План» в топбаре (2026-08-03).
 *
 * Раньше над планом стояли три полосы подряд: топбар, предпросмотр «глазами участника» и
 * переключатель «панели/таблица». Две нижние несли по одному сегменту на всю ширину и отодвигали
 * первую цифру вниз на треть экрана телефона — хром важнее содержимого выглядел как ошибка, ею и
 * был.
 *
 * Оба переключателя стали пиктограммами и переехали сюда, к остальному управлению. Подписи
 * остались — в `aria-label` и `title`: пиктограмма экономит место, но не смысл.
 *
 * Предпросмотр показывается только когда в воркспейсе есть кому смотреть. Владельцу-одиночке
 * (а это все, пока он никого не позвал) предлагать «взгляд участника» не на что.
 */
function PlanTools({ hasMembers }: { hasMembers: boolean }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search as PlanSearch });
  const isTable = search.view === 'table';
  const isPreview = search.as === 'member';

  return (
    <>
      <span className="seg" role="group" aria-label={t('plan.master.title')}>
        {([false, true] as const).map((table) => (
          <button
            key={String(table)}
            type="button"
            className="seg-btn seg-icon"
            aria-pressed={isTable === table}
            aria-label={t(table ? 'plan.master.on' : 'plan.master.off')}
            title={t(table ? 'plan.master.on' : 'plan.master.off')}
            onClick={() =>
              void navigate({
                to: '/plan',
                search: (prev: PlanSearch): PlanSearch => ({
                  ...prev,
                  view: table ? 'table' : undefined,
                }),
              })
            }
          >
            {table ? <IconTable /> : <IconPanels />}
          </button>
        ))}
      </span>
      {hasMembers && (
        <button
          type="button"
          className="act act-icon"
          aria-pressed={isPreview}
          aria-label={t(isPreview ? 'share.viewAsOff' : 'share.viewAs')}
          title={t(isPreview ? 'share.viewAsOff' : 'share.viewAs')}
          onClick={() =>
            void navigate({
              to: '/plan',
              search: (prev: PlanSearch): PlanSearch => ({
                ...prev,
                as: isPreview ? undefined : 'member',
              }),
            })
          }
        >
          <IconEye open={isPreview} />
        </button>
      )}
    </>
  );
}

export function AppShell() {
  const { t, locale, setLocale } = useI18n();
  const online = useOnline();
  /*
   * Отложенные траты уходят при появлении сети и при запуске (Спринт 6). Эффект, а не кнопка:
   * человек не должен помнить, что у него что-то не доехало, — иначе очередь бесполезна.
   */
  const flushOutbox = useFlushOutbox();
  useEffect(() => {
    if (online && queueSize() > 0) flushOutbox.mutate();
    // flushOutbox в зависимостях не нужен: он стабилен, а его добавление зациклило бы эффект.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { theme, setTheme } = useTheme();
  const [spendOpen, setSpendOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const base = me?.workspace?.baseCurrency;
  /*
   * Участник совместного доступа смотрит и не правит (issue #46). Кнопки ввода ему не показываем:
   * сервер их всё равно отклонит, а кнопка, которая всегда падает, — обман, а не ограничение.
   */
  const isMember = me?.role === 'member';
  /*
   * Состав участников нужен обеим сторонам: участнику — имя владельца в баннере («чужой кабинет»
   * без имени звучит тревожнее, чем есть), владельцу — знать, есть ли вообще кому смотреть его
   * план: без приглашённых предпросмотр «глазами участника» показывать не на чем.
   */
  const { data: members } = useMembers(Boolean(me?.workspace));
  const ownerName = members?.members.find((m) => m.role === 'owner')?.name ?? '';
  const hasMembers = (members?.members ?? []).some((m) => m.role !== 'owner');
  // Инструменты вида относятся к плану: на других экранах они переключали бы невидимое.
  const onPlan = useRouterState({ select: (s) => s.location.pathname.startsWith('/plan') });

  return (
    <div className="app-frame">
      {/*
        Полоса «нет сети» (Спринт 6). Приложение теперь открывается из кэша, и без этой полосы
        человек видел бы пустой план, решив, что данные потерялись. Полоса в потоке, а не поверх
        содержимого: перекрывать цифры сообщением о сети — плохой обмен.
      */}
      {!online && <div className="offline-bar">{t('common.offline')}</div>}
      <header className="topbar">
        <span className="topbar-brand">multa</span>
        <nav className="tabs" aria-label={t('nav.plan')}>
          {NAV.filter((n) => !(n.ownerOnly && isMember)).map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className="tab"
              activeProps={{ className: 'tab tab-active' }}
            >
              {t(n.key)}
            </Link>
          ))}
        </nav>
        <div className="topbar-right">
          {/* Мастер-таблица матрицу видимости пока не умеет — участнику её не предлагаем (#46). */}
          {onPlan && !isMember && <PlanTools hasMembers={hasMembers} />}
          {/* Ввод факта доступен с любого экрана: трату записывают на ходу (04-web-ux §Ввод). */}
          {base && !isMember && (
            <>
              {/*
               * Главное действие продукта, и выглядит оно теперь как главное. Прежнее название
               * «Записать трату» врало половиной: за кнопкой и трата, и приход, а приходу она
               * нужнее — у кого доход ежедневный, тот заходит сюда отмечать смену, а не покупку.
               */}
              <button
                type="button"
                className="act act-primary"
                title={t('spend.openHint')}
                onClick={() => setSpendOpen(true)}
              >
                {t('spend.open')}
              </button>
              <button type="button" className="act" onClick={() => setReceiptOpen(true)}>
                {t('receipt.open')}
              </button>
            </>
          )}
          <span className="seg" role="group" aria-label={t('settings.theme')}>
            {(['dark', 'light'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className="seg-btn"
                aria-pressed={theme === v}
                onClick={() => setTheme(v)}
              >
                {t(v === 'dark' ? 'settings.theme.dark' : 'settings.theme.light')}
              </button>
            ))}
          </span>
          <span className="seg" role="group" aria-label={t('settings.language')}>
            {(['en', 'ru'] as const).map((l) => (
              <button
                key={l}
                type="button"
                className="seg-btn"
                aria-pressed={locale === l}
                onClick={() => setLocale(l)}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </span>
          <button
            type="button"
            className="act"
            title={t('settings.signOut')}
            onClick={async () => {
              await authClient.signOut();
              await qc.invalidateQueries();
            }}
          >
            ⎋
          </button>
        </div>
      </header>
      {isMember && (
        <div className="risk-band info">{t('share.banner.member', { owner: ownerName })}</div>
      )}
      <main className="app-main">
        <Outlet />
      </main>
      {spendOpen && base && (
        <SpendEntry base={base} locale={locale} onClose={() => setSpendOpen(false)} />
      )}
      {receiptOpen && base && (
        <ReceiptEntry base={base} locale={locale} onClose={() => setReceiptOpen(false)} />
      )}
    </div>
  );
}
