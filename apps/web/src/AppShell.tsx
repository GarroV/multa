import type { TranslationKey } from '@multa/i18n';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { ReceiptEntry } from './components/ReceiptEntry.tsx';
import { SpendEntry } from './components/SpendEntry.tsx';
import { authClient } from './lib/authClient.ts';
import { useI18n } from './lib/i18n.tsx';
import { useMe, useMembers } from './lib/queries.ts';
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
/*
 * Иконки нарисованы, а не набраны глифами. Юникодные «▤» и «▦» в интерфейсном шрифте выходят двумя
 * почти одинаковыми серыми квадратиками 15px: отличить панели от таблицы нельзя, а угадывать
 * приходится каждому. Контур наследует цвет кнопки, поэтому нажатое состояние подсвечивается само.
 */
function IconPanels() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden focusable="false">
      {/* Две широкие полосы: панели идут одна под другой на всю ширину. */}
      <rect x="1" y="2" width="12" height="4" rx="1" fill="none" stroke="currentColor" />
      <rect x="1" y="8" width="12" height="4" rx="1" fill="none" stroke="currentColor" />
    </svg>
  );
}

function IconTable() {
  return (
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden focusable="false">
      {/* Рамка с сеткой: строки статей против колонок периодов. */}
      <rect x="1" y="2" width="12" height="10" rx="1" fill="none" stroke="currentColor" />
      <path d="M5.5 2v10M9.5 2v10M1 5.5h12M1 8.5h12" stroke="currentColor" />
    </svg>
  );
}

/**
 * Предпросмотр «глазами участника»: глаз открыт — смотрим чужими глазами, закрыт — своими.
 */
function IconEye({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 14" width="16" height="14" aria-hidden focusable="false">
      <path
        d="M1 7c2-3.2 4.3-4.8 7-4.8S13 3.8 15 7c-2 3.2-4.3 4.8-7 4.8S3 10.2 1 7z"
        fill="none"
        stroke="currentColor"
      />
      {open ? (
        <circle cx="8" cy="7" r="2.1" fill="currentColor" />
      ) : (
        <path d="M3 3l10 8" stroke="currentColor" />
      )}
    </svg>
  );
}

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
