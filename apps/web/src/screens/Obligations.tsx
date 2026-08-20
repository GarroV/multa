import { fromMajor, paymentToClose, type Currency, type WeekendRule } from '@multa/core';
import { envelopeEditFieldKind, envelopeEditFieldValue } from '../lib/envelopeView.ts';
import { nextPeriodStart, periodsUntil } from '../lib/income.ts';
import { Fragment, useState, type ReactNode } from 'react';
import { RecurringPayments } from '../components/RecurringPayments.tsx';
import { useIsMember } from '../lib/role.ts';
import { isSectionVisible } from '../lib/sections.ts';
import { Bar, Panel, Tag } from '../components/ui/Panel.tsx';
import { CurrencySelect } from '../components/ui/CurrencySelect.tsx';
import { Hint } from '../components/ui/Hint.tsx';
import { ObligationEdit } from '../components/ObligationEdit.tsx';
import { formatDate, formatMinor } from '../lib/format.ts';
import { useI18n } from '../lib/i18n.tsx';
import { useToday } from '../lib/useToday.ts';
import { Select } from '../components/ui/Select.tsx';

import {
  useAccounts,
  useCreateEntity,
  useDeleteEntity,
  useEntities,
  useIncomeSources,
  useRepayLoan,
  useMe,
  useSaveAccount,
  type Bucket,
  type Debt,
  type Envelope,
  type Goal,
} from '../lib/queries.ts';

/**
 * Обязательства: долги, конверты, цели, валютные корзины. Экран редактора, а не витрины —
 * поэтому у каждой панели своя форма добавления в подвале, а строки показывают прогресс.
 *
 * Два правила, вынесенные из ревью (issue #20):
 * 1. Ошибка загрузки не притворяется пустотой. `data = []` при сбое рисовало «пока пусто», и
 *    человек заводил дубликаты долгов, думая, что их нет.
 * 2. Невалидная сумма не превращается в ноль. `'1 000'` или `'12.3.4'` раньше создавали
 *    обязательство на 0 без единого слова — теперь форма не отправляется и говорит, что не так.
 */

/** major-строка → minor или null. Null означает «не смогли понять», а не «ноль». */
function toMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    return fromMajor(s, ccy).minor.toString();
  } catch {
    // fromMajor бросает на превышении разрядности валюты — это тоже «не смогли понять».
    return null;
  }
}

/** Валюта: три латинские буквы, иначе сервер откажет, а форма промолчит. */
function isCurrency(ccy: string): boolean {
  return /^[A-Z]{3}$/.test(ccy);
}

interface SectionProps {
  base: string;
}

/** Обёртка панели раздела: состояние загрузки, ошибка и форма в подвале — одинаково у всех. */
function Section({
  label,
  accent,
  sum,
  isError,
  onRetry,
  rows,
  form,
  formError,
  mutationError,
}: {
  label: string;
  accent: 'mag' | 'cyan' | 'lime' | 'vio';
  sum?: string;
  isError: boolean;
  onRetry: () => void;
  rows: ReactNode;
  form: ReactNode;
  formError: string | null;
  mutationError: boolean;
}) {
  const { t } = useI18n();
  return (
    <Panel
      label={label}
      accent={accent}
      sum={sum}
      foot={
        <div className="fx-form">
          {form}
          {formError && <span className="sub danger">{formError}</span>}
          {mutationError && <span className="sub danger">⚠ {t('common.error')}</span>}
        </div>
      }
    >
      {isError ? (
        <div className="prow">
          <span className="prow-day" aria-hidden />
          <span className="prow-name">
            <span className="danger">{t('obl.loadFailed')}</span>
          </span>
          <span className="prow-num" />
          <button type="button" className="act" onClick={onRetry}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        rows
      )}
    </Panel>
  );
}

function AccountsSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data = [], isError, refetch } = useAccounts();
  const save = useSaveAccount();
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [kind, setKind] = useState<'cash' | 'card' | 'savings' | 'other'>('cash');
  const [balance, setBalance] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const balanceMinor = balance.trim() === '' ? '0' : toMinor(balance, ccy);
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(ccy)) return setError(t('obl.badCurrency'));
    if (balanceMinor === null) return setError(t('spend.badAmount'));
    setError(null);
    save.mutate(
      { name: name.trim(), currency: ccy, kind, balanceMinor },
      {
        onSuccess: () => {
          setName('');
          setBalance('');
        },
      },
    );
  };

  return (
    <Section
      label={t('acc.title')}
      accent="cyan"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={save.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((a) => (
            <div className="prow" key={a.id}>
              <span className="prow-day" aria-hidden />
              <span className="prow-name">
                <span>{a.name}</span>
                <Tag>{t(`acc.kind.${a.kind}`)}</Tag>
                {a.currency !== base && <Tag tone="vio">{a.currency}</Tag>}
              </span>
              <span className="prow-num">
                <b>
                  {formatMinor(a.balanceMinor, a.currency, locale)} {a.currency}
                </b>
              </span>
              {/* Архивация, а не удаление: к счёту привязана история трат. */}
              <button
                type="button"
                className="act"
                title={t('acc.archive')}
                disabled={save.isPending}
                onClick={() => save.mutate({ id: a.id, archived: true })}
              >
                {t('acc.archive')}
              </button>
            </div>
          ))
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <CurrencySelect
              value={ccy}
              onChange={setCcy}
              label={t('common.currency')}
              className="field mono field-ccy-wide"
            />
          </div>
          <div className="form-row">
            <Select
              className="field field-choice"
              // Подпись поля, а не раздела: «ACCOUNTS» не отличало одно от другого (#112).
              label={t('acc.kind')}
              value={kind}
              onChange={(next) => setKind(next as typeof kind)}
              options={(['cash', 'card', 'savings', 'other'] as const).map((k) => ({
                value: k,
                label: t(`acc.kind.${k}`),
              }))}
            />
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('acc.balance')}
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            />
            <button type="button" className="btn" disabled={save.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

/**
 * Займы: деньги, которые должны вернуть мне (issue #94).
 *
 * Отдельным разделом, а не строкой среди долгов: там деньги уходят, здесь приходят, и в одной
 * колонке это сложилось бы с разными знаками. В раздачу заём не входит вовсе — сервер его из
 * каскада исключает, — поэтому здесь нет ни платежа за период, ни доли выплаты.
 *
 * Возврат вводится суммой, а не кнопкой «закрыть»: возвращают частями чаще, чем целиком.
 */
function LoansSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data: all = [], isError, refetch } = useEntities<Debt>('debts');
  const data = all.filter((d) => d.direction === 'owed_to_me');
  const create = useCreateEntity('debts');
  const del = useDeleteEntity('debts');
  const repay = useRepayLoan();

  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Какому займу вводим возврат: поле раскрывается под строкой, как правка у соседей. */
  const [repaying, setRepaying] = useState<string | null>(null);
  const [back, setBack] = useState('');

  const add = () => {
    if (!name.trim()) return setError(t('obl.needName'));
    let minor: string;
    try {
      minor = fromMajor(amount.trim().replace(',', '.'), ccy as Currency).minor.toString();
    } catch {
      return setError(t('spend.badAmount'));
    }
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        currency: ccy,
        direction: 'owed_to_me',
        principalMinor: minor,
        remainingMinor: minor,
        // Платежа за период у займа нет: его никто не откладывает, он просто ждёт возврата.
        paymentMinor: '0',
      },
      {
        onSuccess: () => {
          setName('');
          setAmount('');
        },
      },
    );
  };

  const sendBack = (id: string, currency: string) => {
    let minor: string;
    try {
      minor = fromMajor(back.trim().replace(',', '.'), currency as Currency).minor.toString();
    } catch {
      return setError(t('spend.badAmount'));
    }
    setError(null);
    repay.mutate(
      { id, amountMinor: minor },
      {
        onSuccess: () => {
          setRepaying(null);
          setBack('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.loans')}
      accent="lime"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError || del.isError || repay.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('obl.loans.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((d) => (
            <div key={d.id}>
              <div className="prow">
                <span className="prow-day" aria-hidden />
                <span className="prow-name">
                  <span>{d.name}</span>
                  {d.currency !== base && <Tag tone="vio">{d.currency}</Tag>}
                </span>
                <span className="prow-num">
                  <b>
                    {formatMinor(d.remainingMinor, d.currency, locale)} {d.currency}
                  </b>
                </span>
                <button type="button" className="act" onClick={() => setRepaying(d.id)}>
                  {t('obl.loans.repaid')}
                </button>
                <button
                  type="button"
                  className="act"
                  aria-label={t('common.delete')}
                  onClick={() => del.mutate(d.id)}
                >
                  ✕
                </button>
              </div>
              {repaying === d.id && (
                <div className="prow">
                  <span className="prow-day" aria-hidden />
                  <span className="prow-bar prow-bar-full">
                    <span className="form-row">
                      <input
                        className="field num field-sm"
                        inputMode="decimal"
                        autoFocus
                        aria-label={t('obl.loans.repaid')}
                        placeholder={t('obl.remaining')}
                        value={back}
                        onChange={(e) => setBack(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && sendBack(d.id, d.currency)}
                      />
                      <button
                        type="button"
                        className="btn"
                        disabled={repay.isPending}
                        onClick={() => sendBack(d.id, d.currency)}
                      >
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => setRepaying(null)}
                      >
                        {t('common.cancel')}
                      </button>
                    </span>
                  </span>
                </div>
              )}
            </div>
          ))
        )
      }
      form={
        /*
         * Та же раскладка, что у соседних разделов: первый ряд — название и валюта, второй — то,
         * что отличает раздел, и «Добавить» (замечание владельца 16.08.2026: «почему у долгов и
         * регулярных платежей окна по разному идут, хотя по факту они почти одинаковые»).
         *
         * Здесь обёртки ряда не было вовсе, поэтому в узкой колонке поля вставали друг под друга
         * четырьмя этажами, тогда как рядом такая же форма умещалась в две строки.
         */
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('obl.loans.who')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <CurrencySelect
              value={ccy}
              onChange={setCcy}
              label={t('common.currency')}
              className="field mono field-ccy-wide"
            />
          </div>
          <div className="form-row">
            <input
              className="field num field-sm"
              inputMode="decimal"
              // Не «осталось выплатить»: платить тут не мне, это сумма к возврату (#112).
              placeholder={t('obl.loans.amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

function DebtsSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const today = useToday();
  const { data: all = [], isError, refetch } = useEntities<Debt>('debts');
  /*
   * Займы живут в той же таблице, но в этом разделе им не место: там деньги уходят, здесь приходят.
   * Показать их вместе значило бы сложить в одну колонку числа с разным знаком (#94).
   */
  const data = all.filter((d) => d.direction !== 'owed_to_me');
  const create = useCreateEntity('debts');
  const del = useDeleteEntity('debts');
  // Какую строку правим: правка раскрывается под ней, как редактор категорий.
  const [editing, setEditing] = useState<string | null>(null);
  /*
   * Разбивка платежа прямо при заведении (замечание владельца 16.08.2026: «какой долг на правку?
   * как сразу задать-то?»). Раньше она жила только в редакторе: приходилось завести долг с одной
   * суммой, найти его в списке и открыть правку — ради того, что человек знал с самого начала.
   */
  const [splitOpen, setSplitOpen] = useState(false);
  /*
   * Окно платежей: «платим с ноября по февраль» (issue #117). До этого выражалось только правкой
   * ячеек таблицы — ноль сейчас, сумма с ноября, ноль с марта: работает, но догадаться нельзя.
   */
  const [windowOpen, setWindowOpen] = useState(false);
  /*
   * Панель настроек долга (issue #126, реакция владельца на скрин формы: «сейчас очень путает»).
   *
   * В ряду стояло семь элементов сразу: остаток, платёж, сегмент «Платёж/Срок», знак вопроса, две
   * кнопки-переключателя и «Добавить». Форма уже упрощалась один раз (#117, чекбокс и капслочные
   * кнопки → сегмент и toggle) и всё равно путала — значит дело не в стилях кнопок, а в том, что ВСЁ
   * показано сразу. Поэтому редкое (способ задания, разбивка по выплатам, окно платежей) уезжает под
   * значок, а частое — имя, остаток, платёж, «добавить» — остаётся на виду.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /*
   * Новый долг по умолчанию начинает платиться со СЛЕДУЮЩЕЙ выплаты (issue #121). Текущий период
   * уже прожит наполовину, и обязательство, заведённое сегодня, откусывало от остатка задним
   * числом: цифра дня падала не потому, что человек потратил, а потому, что записал.
   *
   * Умолчание видимое — форма говорит дату, и её можно изменить. Тихим правилом сервера это делать
   * нельзя: платёж может уходить уже в этом периоде, и молча занизить обязательства опаснее, чем
   * показать их раньше срока.
   */
  const [paysFrom, setPaysFrom] = useState('');
  const [paysUntil, setPaysUntil] = useState('');
  const [bySource, setBySource] = useState<Record<string, string>>({});
  const sources = useIncomeSources();
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState('');
  /*
   * Два способа завести долг (разговор с владельцем 10.08.2026). «Знаю платёж» — как было. «Знаю
   * срок» — человек называет дату, взнос считает продукт: остаток делится на число выплат до срока
   * с округлением вверх. Вниз округлять нельзя — хвост уехал бы в лишний период, и «закрою к маю»
   * стало бы «закрою в июне».
   */
  const [mode, setMode] = useState<'payment' | 'deadline'>('payment');
  const [closeBy, setCloseBy] = useState('');
  const [error, setError] = useState<string | null>(null);

  /*
   * Взнос по сроку считается тем же ядром и тем же ритмом, что и план: иначе «шесть платежей» в
   * форме и пять колонок в таблице разошлись бы, и человек не понял бы, какой цифре верить.
   */
  const { data: meForDebt } = useMe();
  const defaultFrom =
    meForDebt?.workspace?.rhythm && meForDebt.today
      ? nextPeriodStart(
          meForDebt.workspace.rhythm,
          (meForDebt.workspace.weekendRule ?? 'before') as WeekendRule,
          meForDebt.today,
        )
      : null;
  const fromToSend = paysFrom || defaultFrom;
  /*
   * Настройки считаются «включёнными», если хоть одна отличается от умолчания. Пустая разбивка или
   * открытое, но незаполненное окно сюда не входят: пометка должна означать «поведение изменено», а
   * не «панель однажды открывали».
   */
  const settingsActive =
    mode !== 'payment' ||
    Object.values(bySource).some((v) => v.trim() !== '') ||
    paysFrom !== '' ||
    paysUntil !== '';
  const remainingForCalc = toMinor(amount, ccy);
  const periodsAhead =
    closeBy && meForDebt?.workspace?.rhythm
      ? periodsUntil(
          meForDebt.workspace.rhythm,
          (meForDebt.workspace.weekendRule ?? 'before') as WeekendRule,
          today,
          closeBy,
        )
      : 0;
  const computed =
    mode === 'deadline' && remainingForCalc && periodsAhead > 0
      ? (() => {
          const perPeriod = paymentToClose(BigInt(remainingForCalc), periodsAhead);
          return perPeriod === null ? null : { perPeriod, periods: periodsAhead };
        })()
      : null;

  const add = () => {
    const principal = toMinor(amount, ccy);
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(ccy)) return setError(t('obl.badCurrency'));
    if (principal === null) return setError(t('spend.badAmount'));
    const pay =
      mode === 'deadline'
        ? (computed?.perPeriod.toString() ?? null)
        : payment.trim() === ''
          ? '0'
          : toMinor(payment, ccy);
    if (pay === null)
      return setError(mode === 'deadline' ? t('obl.badDeadline') : t('spend.badAmount'));

    // Пустое поле — «с этой выплаты не платим», а не ноль; пустая разбивка не отправляется вовсе.
    const split: { sourceId: string; amountMinor: string }[] = [];
    if (splitOpen) {
      for (const source of sources.data ?? []) {
        const raw = (bySource[source.id] ?? '').trim();
        if (!raw) continue;
        const minor = toMinor(raw, ccy);
        if (minor === null) return setError(t('spend.badAmount'));
        split.push({ sourceId: source.id, amountMinor: minor });
      }
    }
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        currency: ccy,
        principalMinor: principal,
        remainingMinor: principal,
        paymentMinor: pay,
        ...(split.length > 0 ? { paymentsBySource: split } : {}),
        ...(fromToSend ? { paysFrom: fromToSend } : {}),
        ...(windowOpen && paysUntil ? { paysUntil } : {}),
      },
      {
        onSuccess: () => {
          setName('');
          setAmount('');
          setPayment('');
          setCloseBy('');
          setBySource({});
          setPaysFrom('');
          setPaysUntil('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.debts')}
      accent="mag"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError || del.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((d) => {
            const principal = BigInt(d.principalMinor);
            const remaining = BigInt(d.remainingMinor);
            const paid = principal - remaining;
            const share = principal > 0n ? Number((paid * 1000n) / principal) / 10 : 0;
            return (
              <Fragment key={d.id}>
                <div className="prow">
                  <span className="prow-day" aria-hidden />
                  <span className="prow-name">
                    <span>{d.name}</span>
                    {d.currency !== base && <Tag tone="vio">{d.currency}</Tag>}
                  </span>
                  <span className="prow-num">
                    <b>
                      {formatMinor(d.paymentMinor, d.currency, locale)} {d.currency}
                    </b>
                    <i>{t('obl.paymentPer')}</i>
                  </span>
                  {/*
                    Действия — в одной ячейке сетки (issue #122). Строка ведомости рассчитана на
                    четыре колонки: день, имя, сумма и ОДНО действие. У долга их два, и второе
                    переносилось на новый этаж, утаскивая полосу прогресса на третий — строка
                    вырастала до 95px с пустотой между этажами.
                  */}
                  <span className="row row-tight">
                    <button
                      type="button"
                      className="act"
                      aria-pressed={editing === d.id}
                      title={t('plan.act.edit')}
                      onClick={() => setEditing(editing === d.id ? null : d.id)}
                    >
                      {t('plan.act.edit')}
                    </button>
                    <button
                      type="button"
                      className="act"
                      title={t('common.delete')}
                      onClick={() => del.mutate(d.id)}
                    >
                      ✕
                    </button>
                  </span>
                  <span className="prow-bar">
                    <Bar share={share} tone="lime" label={d.name} />
                    <span className="prow-num">
                      <i>
                        {formatMinor(paid.toString(), d.currency, locale)} /{' '}
                        {formatMinor(d.principalMinor, d.currency, locale)}
                      </i>
                    </span>
                  </span>
                </div>
                {editing === d.id && (
                  <ObligationEdit
                    entity="debts"
                    id={d.id}
                    name={d.name}
                    currency={d.currency}
                    // Платёж по долгу меняется: банк пересчитал, ставка сменилась, договорились иначе.
                    steps={d.amountSteps}
                    paymentsBySource={d.paymentsBySource ?? []}
                    fields={[
                      {
                        key: 'paymentMinor',
                        label: t('obl.payment'),
                        kind: 'minor' as const,
                        value: d.paymentMinor,
                      },
                    ]}
                    onDone={() => setEditing(null)}
                  />
                )}
              </Fragment>
            );
          })
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <CurrencySelect
              value={ccy}
              onChange={setCcy}
              label={t('common.currency')}
              className="field mono field-ccy-wide"
            />
          </div>
          <div className="form-row">
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('obl.remaining')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {mode === 'payment' ? (
              <input
                className="field mono field-sm"
                inputMode="decimal"
                placeholder={t('obl.payment')}
                value={payment}
                onChange={(e) => setPayment(e.target.value)}
              />
            ) : (
              <input
                className="field"
                type="date"
                aria-label={t('obl.closeBy')}
                value={closeBy}
                onChange={(e) => setCloseBy(e.target.value)}
              />
            )}
            {/*
              Значок настроек. Помечен нажатым, если внутри что-то включено: скрытая настройка,
              которая молча меняет поведение, хуже видимой. Иначе человек свернул бы панель и не
              понял, почему «Платёж» стал датой.
            */}
            <button
              type="button"
              className="act act-icon"
              aria-label={t('obl.settings')}
              title={t('obl.settings')}
              aria-expanded={settingsOpen}
              aria-pressed={settingsActive}
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              ⋯
            </button>
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
          {settingsOpen && (
            <div className="form-row obl-settings">
              {/*
                Способ задать долг — один выбор из двух (issue #117), поэтому сегмент, а не флажок:
                либо человек называет платёж, либо срок, и продукт считает второе сам. Общий контур
                говорит о взаимоисключающем выборе сам — тот же приём, что в референсе владельца.
              */}
              <span className="seg seg-inline" role="group" aria-label={t('obl.mode')}>
                {(['payment', 'deadline'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="seg-btn"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                  >
                    {t(m === 'payment' ? 'obl.mode.payment' : 'obl.mode.deadline')}
                  </button>
                ))}
              </span>
              {/* Что вносить в «Осталось» и «Платёж» — под знаком: нужно один раз. */}
              <Hint text={t('obl.formHint')} />
              {/*
                Разбивка платежа по выплатам (issue #117). За кнопкой: у большинства долгов сумма
                одна на все выплаты, и лишние поля здесь — шум. Но задать её надо уметь СРАЗУ, а не
                после: иначе человек заводит долг, ищет его в списке и открывает правку ради того,
                что знал с самого начала.
              */}
              <button
                type="button"
                className="toggle"
                aria-pressed={splitOpen}
                onClick={() => setSplitOpen(!splitOpen)}
              >
                {t('obl.split')}
              </button>
              <button
                type="button"
                className="toggle"
                aria-pressed={windowOpen}
                onClick={() => setWindowOpen(!windowOpen)}
              >
                {t('obl.window')}
              </button>
            </div>
          )}
          {splitOpen && (
            <div className="form-row obl-split">
              {/*
                Подпись — знаком вопроса, а не заголовком в полстроки: раздел уже назван кнопкой,
                которой его открыли, и повторять то же самое крупным текстом значит тратить строку
                на пересказ (замечание владельца о крупноте, 16.08.2026).
              */}
              <Hint text={t('obl.split.hint')} />
              {(sources.data ?? []).map((source) => (
                <input
                  key={source.id}
                  className="field num field-sm"
                  inputMode="decimal"
                  aria-label={source.label}
                  placeholder={source.label}
                  value={bySource[source.id] ?? ''}
                  onChange={(e) => setBySource({ ...bySource, [source.id]: e.target.value })}
                />
              ))}
            </div>
          )}
          {!windowOpen && defaultFrom && (
            <div className="sub dim obl-from-note">
              {t('obl.startsNext', { date: formatDate(defaultFrom) })}
            </div>
          )}
          {windowOpen && (
            <div className="form-row obl-window">
              <Hint text={t('obl.window.hint')} />
              <input
                className="field"
                type="date"
                aria-label={t('obl.window.from')}
                value={paysFrom}
                onChange={(e) => setPaysFrom(e.target.value)}
              />
              <input
                className="field"
                type="date"
                aria-label={t('obl.window.until')}
                value={paysUntil}
                onChange={(e) => setPaysUntil(e.target.value)}
              />
            </div>
          )}
          {/* Считаем вслух: человек должен увидеть взнос до того, как нажмёт «добавить». */}
          {mode === 'deadline' && computed && (
            <span className="sub dim">
              {t('obl.computed', {
                amount: `${formatMinor(computed.perPeriod.toString(), ccy, locale)} ${ccy}`,
                periods: String(computed.periods),
              })}
            </span>
          )}
          {mode === 'deadline' && closeBy && !computed && (
            <span className="sub danger">{t('obl.badDeadline')}</span>
          )}
        </>
      }
    />
  );
}

function EnvelopesSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data = [], isError, refetch } = useEntities<Envelope>('envelopes');
  const create = useCreateEntity('envelopes');
  const del = useDeleteEntity('envelopes');
  // Какую строку правим: правка раскрывается под ней, как редактор категорий.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [ruleKind, setRuleKind] = useState<'fixed' | 'percent'>('fixed');
  const [ruleValue, setRuleValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(ccy)) return setError(t('obl.badCurrency'));
    // fixed: rule_value хранится в minor-единицах валюты (02-data-schema); percent — «%» как есть.
    const value =
      ruleKind === 'fixed'
        ? toMinor(ruleValue, ccy)
        : /^\d+(\.\d+)?$/.test(ruleValue.trim().replace(',', '.'))
          ? ruleValue.trim().replace(',', '.')
          : null;
    if (value === null) return setError(t('spend.badAmount'));
    if (ruleKind === 'percent' && Number(value) > 100) return setError(t('obl.badPercent'));
    setError(null);
    create.mutate(
      { name: name.trim(), currency: ccy, ruleKind, ruleValue: value },
      {
        onSuccess: () => {
          setName('');
          setRuleValue('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.envelopes')}
      accent="cyan"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError || del.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((e) => (
            <Fragment key={e.id}>
              <div className="prow">
                <span className="prow-day" aria-hidden />
                <span className="prow-name">
                  <span>{e.name}</span>
                  <Tag tone={e.ruleKind === 'percent' ? 'cyan' : 'quiet'}>
                    {e.ruleKind === 'percent' ? t('obl.rule.percent') : t('obl.rule.fixed')}
                  </Tag>
                </span>
                <span className="prow-num">
                  <b>
                    {e.ruleKind === 'percent'
                      ? `${Number(e.ruleValue)}%`
                      : `${formatMinor(e.ruleValue.split('.')[0] ?? '0', e.currency, locale)} ${e.currency}`}
                  </b>
                </span>
                <button
                  type="button"
                  className="act"
                  aria-pressed={editing === e.id}
                  title={t('plan.act.edit')}
                  onClick={() => setEditing(editing === e.id ? null : e.id)}
                >
                  {t('plan.act.edit')}
                </button>
                <button
                  type="button"
                  className="act"
                  title={t('common.delete')}
                  onClick={() => del.mutate(e.id)}
                >
                  ✕
                </button>
              </div>
              {editing === e.id && (
                <ObligationEdit
                  entity="envelopes"
                  id={e.id}
                  name={e.name}
                  currency={e.currency}
                  fields={[
                    {
                      key: 'ruleValue',
                      label: t('obl.rule.fixed'),
                      // «Фикс» — деньги в minor units, «процент» — число как есть (issue #127).
                      kind: envelopeEditFieldKind(e.ruleKind),
                      value: envelopeEditFieldValue(e.ruleKind, String(e.ruleValue)),
                    },
                  ]}
                  onDone={() => setEditing(null)}
                />
              )}
            </Fragment>
          ))
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(ev) => setName(ev.target.value)}
            />
            <CurrencySelect
              value={ccy}
              onChange={setCcy}
              label={t('common.currency')}
              className="field mono field-ccy-wide"
            />
          </div>
          <div className="form-row">
            <Select
              className="field field-choice"
              // Подпись поля, а не текущего значения: «fixed» звучало как «fixed, fixed» (#112).
              label={t('obl.rule.how')}
              value={ruleKind}
              onChange={(next) => setRuleKind(next as 'fixed' | 'percent')}
              options={[
                { value: 'fixed', label: t('obl.rule.fixed') },
                { value: 'percent', label: t('obl.rule.percent') },
              ]}
            />
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('common.amount')}
              value={ruleValue}
              onChange={(ev) => setRuleValue(ev.target.value)}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

function GoalsSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data = [], isError, refetch } = useEntities<Goal>('goals');
  const create = useCreateEntity('goals');
  const del = useDeleteEntity('goals');
  // Какую строку правим: правка раскрывается под ней, как редактор категорий.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [ccy, setCcy] = useState(base);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const targetMinor = toMinor(target, ccy);
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(ccy)) return setError(t('obl.badCurrency'));
    if (targetMinor === null) return setError(t('spend.badAmount'));
    setError(null);
    create.mutate(
      { name: name.trim(), currency: ccy, targetMinor },
      {
        onSuccess: () => {
          setName('');
          setTarget('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.goals')}
      accent="lime"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError || del.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((g) => {
            const target = BigInt(g.targetMinor);
            const saved = BigInt(g.savedMinor);
            const share = target > 0n ? Number((saved * 1000n) / target) / 10 : 0;
            return (
              <Fragment key={g.id}>
                <div className="prow">
                  <span className="prow-day" aria-hidden />
                  <span className="prow-name">
                    <span>{g.name}</span>
                    {g.currency !== base && <Tag tone="vio">{g.currency}</Tag>}
                  </span>
                  <span className="prow-num">
                    <b>
                      {formatMinor(g.savedMinor, g.currency, locale)} /{' '}
                      {formatMinor(g.targetMinor, g.currency, locale)}
                    </b>
                  </span>
                  <button
                    type="button"
                    className="act"
                    aria-pressed={editing === g.id}
                    title={t('plan.act.edit')}
                    onClick={() => setEditing(editing === g.id ? null : g.id)}
                  >
                    {t('plan.act.edit')}
                  </button>
                  <button
                    type="button"
                    className="act"
                    title={t('common.delete')}
                    onClick={() => del.mutate(g.id)}
                  >
                    ✕
                  </button>
                  <span className="prow-bar">
                    <Bar share={share} tone="lime" label={g.name} />
                    <span className="prow-num">
                      <i>{share.toFixed(0)}%</i>
                    </span>
                  </span>
                </div>
                {editing === g.id && (
                  <ObligationEdit
                    entity="goals"
                    id={g.id}
                    name={g.name}
                    currency={g.currency}
                    fields={[
                      {
                        key: 'targetMinor',
                        label: t('obl.target'),
                        kind: 'minor' as const,
                        value: g.targetMinor,
                      },
                    ]}
                    onDone={() => setEditing(null)}
                  />
                )}
              </Fragment>
            );
          })
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <CurrencySelect
              value={ccy}
              onChange={setCcy}
              label={t('common.currency')}
              className="field mono field-ccy-wide"
            />
          </div>
          <div className="form-row">
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('obl.target')}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

function BucketsSection({ base }: SectionProps) {
  const { t, locale } = useI18n();
  const { data = [], isError, refetch } = useEntities<Bucket>('buckets');
  const create = useCreateEntity('buckets');
  const del = useDeleteEntity('buckets');
  // Какую строку правим: правка раскрывается под ней, как редактор категорий.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [from, setFrom] = useState(base);
  const [to, setTo] = useState('EUR');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const amountMinor = toMinor(amount, from);
    if (!name.trim()) return setError(t('obl.needName'));
    if (!isCurrency(from) || !isCurrency(to)) return setError(t('obl.badCurrency'));
    if (from === to) return setError(t('fx.sameCurrency'));
    if (amountMinor === null) return setError(t('spend.badAmount'));
    setError(null);
    create.mutate(
      { name: name.trim(), fromCurrency: from, toCurrency: to, amountMinor },
      {
        onSuccess: () => {
          setName('');
          setAmount('');
        },
      },
    );
  };

  return (
    <Section
      label={t('obl.buckets')}
      accent="vio"
      isError={isError}
      onRetry={() => void refetch()}
      formError={error}
      mutationError={create.isError || del.isError}
      rows={
        data.length === 0 ? (
          <div className="prow">
            <span />
            <span className="dim">{t('common.empty')}</span>
            <span />
            <span />
          </div>
        ) : (
          data.map((b) => (
            <Fragment key={b.id}>
              <div className="prow">
                <span className="prow-day" aria-hidden />
                <span className="prow-name">
                  <span>{b.name}</span>
                  <Tag tone="vio">
                    {b.fromCurrency} → {b.toCurrency}
                  </Tag>
                </span>
                <span className="prow-num">
                  <b>
                    {formatMinor(b.amountMinor, b.fromCurrency, locale)} {b.fromCurrency}
                  </b>
                </span>
                <button
                  type="button"
                  className="act"
                  aria-pressed={editing === b.id}
                  title={t('plan.act.edit')}
                  onClick={() => setEditing(editing === b.id ? null : b.id)}
                >
                  {t('plan.act.edit')}
                </button>
                <button
                  type="button"
                  className="act"
                  title={t('common.delete')}
                  onClick={() => del.mutate(b.id)}
                >
                  ✕
                </button>
              </div>
              {editing === b.id && (
                <ObligationEdit
                  entity="buckets"
                  id={b.id}
                  name={b.name}
                  /* Сумма корзины задана в валюте-источнике: её и правим. */
                  currency={b.fromCurrency}
                  fields={[
                    {
                      key: 'amountMinor',
                      label: t('obl.buckets'),
                      kind: 'minor' as const,
                      value: b.amountMinor,
                    },
                  ]}
                  onDone={() => setEditing(null)}
                />
              )}
            </Fragment>
          ))
        )
      }
      form={
        <>
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('common.name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <CurrencySelect
              value={from}
              onChange={setFrom}
              label={t('obl.from')}
              className="field mono field-ccy-wide"
            />
            <span className="dim">→</span>
            <CurrencySelect
              value={to}
              onChange={setTo}
              label={t('obl.to')}
              className="field mono field-ccy-wide"
            />
          </div>
          <div className="form-row">
            <input
              className="field mono field-sm"
              inputMode="decimal"
              placeholder={t('common.amount')}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button type="button" className="btn" disabled={create.isPending} onClick={add}>
              {t('common.add')}
            </button>
          </div>
        </>
      }
    />
  );
}

export function Obligations() {
  const { data: me } = useMe();
  const base = me?.workspace?.baseCurrency ?? 'RUB';
  /*
   * Участник совместного доступа смотрит и не правит (issue #46). Счета матрицы не знают вовсе,
   * поэтому их раздел ему не показываем — иначе он получит отказ вместо содержимого (issue #84).
   */
  const isMember = useIsMember();
  return (
    <div className="dense">
      {/*
        Счета, цели и корзины скрыты (решение владельца 06.08.2026, см. lib/sections.ts): владелец
        заводит бюджет, а не отслеживает остатки по кошелькам, и три похожих раздела рядом мешают
        заполнять. Компоненты оставлены в файле — возвращать их придётся целиком, а не писать заново.
      */}
      <div className="panels">
        <div className="col">
          {isSectionVisible('account') && !isMember && <AccountsSection base={base} />}
          <DebtsSection base={base} />
          {/* Займы рядом с долгами: та же сущность, обратный знак денег (#94). */}
          <LoansSection base={base} />
          {isSectionVisible('goal') && <GoalsSection base={base} />}
        </div>
        <div className="col">
          <EnvelopesSection base={base} />
          {isSectionVisible('bucket') && <BucketsSection base={base} />}
          {/* Регулярные платежи (issues #21, #55) — не обязательство каскада, но живут рядом с ними:
              это то же «что с меня спишется», просто вне раздачи. */}
          <RecurringPayments base={base} />
        </div>
      </div>
    </div>
  );
}
