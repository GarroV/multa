/**
 * Разбор строки быстрого ввода: «250 продукты», «кофе 4.5 eur вчера», «+15000 подработка».
 *
 * Правило спеки (04-web-ux §Ввод): поле угадывает, но не выдумывает. Не нашли сумму — честно
 * отдаём null и просим уточнить, а не пишем ноль. Категорию угадываем только для трат: у прихода
 * категории не бывает. Всё остальное (какой день считать «сегодня», список категорий, базовая
 * валюта) приходит контекстом — модуль остаётся чистым и тестируемым.
 */

import { addDays } from './periods.ts';
import { fromMajor, type Currency } from './money.ts';

export interface ParseEntryContext {
  readonly baseCurrency: Currency;
  /** Сегодняшняя дата в таймзоне воркспейса (ISO). */
  readonly today: string;
  /** Имена живых категорий — по ним угадывается назначение траты. */
  readonly categories: readonly string[];
}

export interface ParsedEntry {
  readonly kind: 'expense' | 'income';
  /** null — сумму распознать не удалось (единственная обязательная часть ввода). */
  readonly amountMinor: bigint | null;
  readonly currency: Currency;
  readonly occurredOn: string;
  readonly categoryName?: string;
  readonly note?: string;
}

/** Разговорные обозначения валют. Код (eur/rsd) распознаётся сам, здесь — символы и слова. */
const CURRENCY_WORDS: Record<string, Currency> = {
  '€': 'EUR',
  eur: 'EUR',
  евро: 'EUR',
  $: 'USD',
  usd: 'USD',
  бакс: 'USD',
  баксов: 'USD',
  доллар: 'USD',
  долларов: 'USD',
  '₽': 'RUB',
  rub: 'RUB',
  руб: 'RUB',
  рубль: 'RUB',
  рублей: 'RUB',
  '¥': 'JPY',
  jpy: 'JPY',
  иен: 'JPY',
  '₺': 'TRY',
  try: 'TRY',
  лир: 'TRY',
  rsd: 'RSD',
  дин: 'RSD',
  динар: 'RSD',
  динаров: 'RSD',
  gel: 'GEL',
  лари: 'GEL',
  amd: 'AMD',
  драм: 'AMD',
  kzt: 'KZT',
  тенге: 'KZT',
};

const INCOME_WORDS = new Set([
  'пришло',
  'приход',
  'получил',
  'получила',
  'зарплата',
  'подработка',
  'аванс',
  'income',
  'got',
  'received',
  'paid',
]);

const DAY_SHIFTS: Record<string, number> = {
  сегодня: 0,
  today: 0,
  вчера: -1,
  yesterday: -1,
  позавчера: -2,
};

/** Разделитель тысяч: обычный, неразрывный и узкий пробелы — так суммы копируют из банка. */
const THIN_SPACES = '\u0020\u00A0\u202F';
const AMOUNT_RE = new RegExp(
  `(^|\\s)([+-]?\\d{1,3}(?:[${THIN_SPACES}]\\d{3})+(?:[.,]\\d{1,2})?|[+-]?\\d+(?:[.,]\\d{1,2})?)(?=\\s|$)`,
);
const DATE_RE = /(^|\s)(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?(?=\s|$)/;

/** Дата «12.07» без года: ближайшая такая дата в прошлом — вводят факт, а не план. */
function resolveShortDate(day: number, month: number, year: number | undefined, today: string): string | null {
  const [ty, , ] = today.split('-').map(Number);
  const pad = (n: number) => String(n).padStart(2, '0');
  const candidateYear = year ?? ty!;
  const full = (y: number) => `${y}-${pad(month)}-${pad(day)}`;
  const iso = full(year !== undefined && year < 100 ? 2000 + year : candidateYear);
  if (!isValidDate(iso)) return null;
  if (year !== undefined) return iso;
  return iso <= today ? iso : full(candidateYear - 1);
}

function isValidDate(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseEntry(input: string, ctx: ParseEntryContext): ParsedEntry {
  let rest = ` ${input.trim().replace(/\s+/g, ' ')} `;
  const cut = (match: string) => {
    rest = rest.replace(match, ' ');
  };

  // Вид операции: «+сумма» или слово прихода.
  const words = rest.trim().split(' ').filter(Boolean);
  let kind: 'expense' | 'income' = 'expense';
  for (const w of words) {
    const bare = w.toLowerCase().replace(/[^\p{L}]/gu, '');
    if (INCOME_WORDS.has(bare)) {
      kind = 'income';
      break;
    }
  }

  // Сумма — единственная обязательная часть ввода.
  let amountMinor: bigint | null = null;
  let currency = ctx.baseCurrency;
  const amountMatch = AMOUNT_RE.exec(rest);
  let rawAmount: string | null = null;
  if (amountMatch) {
    rawAmount = amountMatch[2]!;
    if (rawAmount.startsWith('+')) kind = 'income';
    cut(amountMatch[0]);
  }

  // Валюта: символ, слово или код. Ищем до подсчёта minor — от неё зависит exponent.
  for (const word of rest.trim().split(' ').filter(Boolean)) {
    const bare = word.toLowerCase().replace(/[.,!?]+$/, '');
    const named = CURRENCY_WORDS[bare];
    const code = /^[a-z]{3}$/.test(bare) && KNOWN_CODES.has(bare.toUpperCase()) ? bare.toUpperCase() : undefined;
    const found = named ?? code;
    if (!found) continue;
    currency = found;
    rest = rest.replace(new RegExp(`(^|\\s)${escapeRe(word)}(?=\\s|$)`), ' ');
    break;
  }

  // Дату разбираем ПОСЛЕ суммы: в «4.5 кафе» точка принадлежит сумме, а не дате 4 мая.
  let occurredOn = ctx.today;
  const dateMatch = DATE_RE.exec(rest);
  if (dateMatch) {
    const resolved = resolveShortDate(
      Number(dateMatch[2]),
      Number(dateMatch[3]),
      dateMatch[4] !== undefined ? Number(dateMatch[4]) : undefined,
      ctx.today,
    );
    if (resolved) {
      occurredOn = resolved;
      cut(dateMatch[0]);
    }
  }
  for (const [word, shift] of Object.entries(DAY_SHIFTS)) {
    const re = new RegExp(`(^|\\s)${word}(?=\\s|$)`, 'i');
    const m = re.exec(rest);
    if (m) {
      occurredOn = addDays(ctx.today, shift);
      cut(m[0]);
      break;
    }
  }

  if (rawAmount !== null) {
    const normalized = rawAmount
      .replace('+', '')
      .replace(new RegExp(`[${THIN_SPACES}]`, 'g'), '') // убираем разделители тысяч
      .replace(',', '.');
    if (!normalized.startsWith('-') && Number(normalized) > 0) {
      amountMinor = fromMajor(normalized, currency).minor;
    }
  }

  // Категория — только для траты, по началу слова.
  let categoryName: string | undefined;
  if (kind === 'expense') {
    const leftovers = rest.trim().split(' ').filter(Boolean);
    for (const w of leftovers) {
      const bare = w.toLowerCase().replace(/[^\p{L}]/gu, '');
      if (!bare) continue;
      const hit = ctx.categories.find(
        (c) => c.toLowerCase() === bare || c.toLowerCase().startsWith(bare) || bare.startsWith(c.toLowerCase()),
      );
      if (hit) {
        categoryName = hit;
        rest = rest.replace(new RegExp(`(^|\\s)${escapeRe(w)}(?=\\s|$)`), ' ');
        break;
      }
    }
  }

  // Остаток строки — заметка (слова прихода в неё не тащим: они служебные).
  const note = rest
    .trim()
    .split(' ')
    .filter((w) => w && !INCOME_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, '')))
    .join(' ')
    .trim();

  return {
    kind,
    amountMinor,
    currency,
    occurredOn,
    ...(categoryName ? { categoryName } : {}),
    ...(note ? { note } : {}),
  };
}

const KNOWN_CODES = new Set([
  'RUB',
  'EUR',
  'USD',
  'RSD',
  'GEL',
  'AMD',
  'KZT',
  'TRY',
  'JPY',
  'GBP',
  'CHF',
  'PLN',
  'CZK',
  'UAH',
  'BYN',
  'AED',
  'THB',
  'CNY',
  'KRW',
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
