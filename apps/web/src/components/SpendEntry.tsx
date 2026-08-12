import { fromMajor, parseEntry, toMajorString, money } from '@multa/core';
import { useState } from 'react';
import { formatDate, formatMinor } from '../lib/format.ts';
import { useSheet } from '../lib/useSheet.ts';
import { useVoiceCapture } from '../lib/useVoiceCapture.ts';
import { CurrencySelect } from './ui/CurrencySelect.tsx';
import { useI18n } from '../lib/i18n.tsx';
import { ApiError } from '../lib/api.ts';
import {
  useCategories,
  useCreateSpend,
  useParseEntry,
  useParseVoice,
  useDeleteSpend,
  useTransactions,
  type Transaction,
} from '../lib/queries.ts';

/** major-строка → minor; null на мусоре (не подставляем молча 0 — как в CategoryEditor). */
function parseMinor(value: string, ccy: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) return null;
  try {
    return fromMajor(s, ccy).minor.toString();
  } catch {
    // Лишние знаки после точки (у JPY их нет вовсе): без catch исключение вылетало из submit до
    // установки признака ошибки, и кнопка «записать» просто ничего не делала (находка аудита).
    return null;
  }
}

const todayISO = (): string => new Date().toISOString().slice(0, 10);

function SpendRow({ tx, base, locale }: { tx: Transaction; base: string; locale: string }) {
  const { t } = useI18n();
  const { data: categories = [] } = useCategories();
  const del = useDeleteSpend();
  const catName = tx.categoryId ? categories.find((c) => c.id === tx.categoryId)?.name : undefined;
  const converted = tx.currency !== base;

  return (
    <div className="list-item">
      <span className="row row-8">
        <span className="sub num">{formatDate(tx.occurredOn)}</span>
        <span>{catName ?? t('spend.noCategory')}</span>
        {tx.note && <span className="sub">· {tx.note}</span>}
        {del.isError && <span className="sub danger">⚠ {t('common.error')}</span>}
      </span>
      <span className="row">
        <span className="num">
          {formatMinor(tx.amountMinor, tx.currency, locale)} {tx.currency}
          {converted && (
            <span className="sub">
              {' '}
              = {formatMinor(tx.baseAmountMinor, base, locale)} {base}
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn btn-ghost"
          title={t('common.delete')}
          disabled={del.isPending}
          onClick={() => del.mutate(tx.id)}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/**
 * Ввод факта (04-web-ux §Ввод): сумма → категория сеткой → готово.
 * Умное текстовое поле и чеки — следующие шаги Спринта 3/5; здесь путь «в 3 клика».
 */
export function SpendEntry({
  base,
  locale,
  onClose,
}: {
  base: string;
  locale: string;
  onClose: () => void;
}) {
  // Escape закрывает лист, фокус возвращается на кнопку, которой его открыли.
  useSheet(onClose);
  const { t } = useI18n();
  const { data: categories = [] } = useCategories();
  const { data: txs } = useTransactions();
  const create = useCreateSpend();
  const parseRemote = useParseEntry();

  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [amount, setAmount] = useState('');
  /*
   * Валюта траты — своё состояние, а не всегда базовая (#100). Человек, живущий между валютами,
   * платит в той, что под рукой, и парсер это распознаёт: «coffee 4.5 eur». Раньше submit слал
   * базовую жёстко, и распознанная валюта молча подменялась — 4,50 EUR превращались в 4,50 RUB.
   */
  const [currency, setCurrency] = useState(base);
  const voice = useVoiceCapture();
  const parseVoice = useParseVoice();
  const [categoryId, setCategoryId] = useState<string | undefined>(undefined);
  const [occurredOn, setOccurredOn] = useState(todayISO());
  const [note, setNote] = useState('');
  const [badAmount, setBadAmount] = useState(false);
  const [smart, setSmart] = useState('');

  /**
   * Умное поле (04-web-ux §Ввод): разбираем строку в ядре и раскладываем по полям формы,
   * а не отправляем сразу — пользователь видит, как его поняли, и может поправить.
   */
  /**
   * Кнопка микрофона: первое нажатие пишет, второе отправляет запись на разбор.
   *
   * Результат раскладывается по тем же полям, что и текстовая фраза, а сама расшифровка кладётся
   * в умное поле — человек видит, КАК его услышали, и может поправить словом, а не заново диктовать.
   */
  const toggleVoice = async () => {
    if (voice.state !== 'recording') return await voice.start();
    const audioUrl = await voice.stop();
    if (!audioUrl) return;
    parseVoice.mutate(audioUrl, {
      onSuccess: (parsed) => {
        setBadAmount(false);
        setSmart(parsed.transcript);
        setKind(parsed.kind);
        setAmount(toMajorString(money(BigInt(parsed.amountMinor), parsed.currency)));
        setCurrency(parsed.currency);
        setOccurredOn(parsed.occurredOn);
        setNote(parsed.note ?? '');
        setCategoryId(parsed.kind === 'income' ? undefined : (parsed.categoryId ?? undefined));
      },
    });
  };

  const applySmart = () => {
    const line = smart.trim();
    if (!line) return;
    const parsed = parseEntry(line, {
      baseCurrency: base,
      today: todayISO(),
      categories: categories.map((c) => c.name),
    });
    if (parsed.amountMinor === null) {
      // Локальный парсер не понял — просим сервер (там regex, а за ним LLM-фоллбэк).
      parseRemote.mutate(line, {
        onSuccess: (remote) => {
          setBadAmount(false);
          setKind(remote.kind);
          setAmount(toMajorString(money(BigInt(remote.amountMinor), remote.currency)));
          setCurrency(remote.currency);
          setOccurredOn(remote.occurredOn);
          setNote(remote.note ?? '');
          setCategoryId(remote.kind === 'income' ? undefined : (remote.categoryId ?? undefined));
        },
        onError: () => setBadAmount(true),
      });
      return;
    }
    setBadAmount(false);
    setKind(parsed.kind);
    setAmount(toMajorString(money(parsed.amountMinor, parsed.currency)));
    setCurrency(parsed.currency);
    setOccurredOn(parsed.occurredOn);
    setNote(parsed.note ?? '');
    const hit = parsed.categoryName
      ? categories.find((c) => c.name === parsed.categoryName)
      : undefined;
    setCategoryId(parsed.kind === 'income' ? undefined : hit?.id);
  };

  const submit = () => {
    const minor = parseMinor(amount, currency);
    if (minor === null) {
      setBadAmount(true);
      return;
    }
    setBadAmount(false);
    create.mutate(
      {
        kind,
        amountMinor: minor,
        currency,
        ...(kind === 'expense' && categoryId ? { categoryId } : {}),
        occurredOn,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          setAmount('');
          setNote('');
        },
      },
    );
  };

  const rateMissing = create.error instanceof ApiError && create.error.code === 'rate_unavailable';
  const isIncome = kind === 'income';

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={t('spend.title')}>
      <div className="sheet">
        <div className="row row-between-top">
          <div>
            <div className="strong">{t(isIncome ? 'spend.titleIncome' : 'spend.title')}</div>
            <div className="sub mt-xs">
              {t(isIncome ? 'spend.subtitleIncome' : 'spend.subtitle')}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            title={t('common.cancel')}
          >
            ✕
          </button>
        </div>

        {/* Трата или приход: один ввод на оба случая — «пришло сегодня» так же частый жест, как трата. */}
        <div className="row row-8">
          {(['expense', 'income'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {t(k === 'income' ? 'spend.kind.income' : 'spend.kind.expense')}
            </button>
          ))}
        </div>

        <div className="stack-xs">
          <div className="form-row">
            <input
              className="field grow"
              placeholder={t('spend.smart.placeholder')}
              value={smart}
              onChange={(e) => setSmart(e.target.value)}
              onBlur={applySmart}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applySmart();
                }
              }}
            />
            {/*
              Диктовка кладёт результат в то же поле, что и напечатанная фраза (#107): дальше он
              идёт общим путём разбора, поэтому «понял так» у голоса и у текста не разъедется.
            */}
            <button
              type="button"
              className="act"
              aria-pressed={voice.state === 'recording'}
              aria-label={t('spend.voice')}
              title={t('spend.voice')}
              disabled={voice.state === 'encoding' || parseVoice.isPending}
              onClick={() => void toggleVoice()}
            >
              {voice.state === 'recording' ? '■' : '🎙'}
            </button>
          </div>
          <span className="sub">{t('spend.smart.hint')}</span>
          {voice.state === 'denied' && (
            <span className="sub danger">{t('spend.voice.denied')}</span>
          )}
          {voice.state === 'unsupported' && <span className="sub dim">{t('spend.voice.no')}</span>}
          {parseVoice.isError && <span className="sub danger">{t('spend.voice.failed')}</span>}
        </div>

        <div className="stack-sm">
          <span className="micro">{t('spend.amount')}</span>
          <div className="row row-8">
            <input
              className="field num field-amount"
              inputMode="decimal"
              autoFocus
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
            <CurrencySelect
              value={currency}
              onChange={setCurrency}
              label={t('spend.currency')}
              className="field field-ccy-wide"
            />
          </div>
          {badAmount && <span className="sub danger">{t('spend.badAmount')}</span>}
        </div>

        {!isIncome && (
          <div className="stack-sm">
            <span className="micro">{t('spend.category')}</span>
            <div className="row row-8">
              <button
                type="button"
                className="chip"
                aria-pressed={categoryId === undefined}
                onClick={() => setCategoryId(undefined)}
              >
                {t('spend.noCategory')}
              </button>
              {categories.map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className="chip"
                  aria-pressed={categoryId === cat.id}
                  onClick={() => setCategoryId(cat.id)}
                >
                  {cat.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="row row-8">
          <div className="stack-sm">
            <span className="micro">{t('spend.date')}</span>
            <input
              className="field num"
              type="date"
              value={occurredOn}
              max={todayISO()}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
          </div>
          <div className="stack-sm stack-grow">
            <span className="micro">{t('common.name')}</span>
            <input
              className="field"
              placeholder="—"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
        </div>

        <button type="button" className="btn" disabled={create.isPending} onClick={submit}>
          {create.isPending
            ? t('common.loading')
            : t(isIncome ? 'spend.submitIncome' : 'spend.submit')}
        </button>

        {create.isError && (
          <div className="sub danger">
            ⚠ {rateMissing ? t('spend.rateUnavailable') : t('common.error')}
          </div>
        )}

        <section className="tile">
          <div className="tile-head">
            <span className="micro">{t('spend.recent')}</span>
            {txs && txs.transactions.length > 0 && (
              <span className="num num-dim">
                {formatMinor(
                  txs.transactions
                    .reduce((acc, tx) => acc + BigInt(tx.baseAmountMinor), 0n)
                    .toString(),
                  base,
                  locale,
                )}{' '}
                {base}
              </span>
            )}
          </div>
          {txs?.transactions.length ? (
            txs.transactions.map((tx) => (
              <SpendRow key={tx.id} tx={tx} base={base} locale={locale} />
            ))
          ) : (
            <div className="sub">{t('spend.empty')}</div>
          )}
        </section>
      </div>
    </div>
  );
}
