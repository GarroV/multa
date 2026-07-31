/**
 * FX: парсеры источников курсов и резолвер пары на дату.
 *
 * Грабли (CLAUDE.md §Известные грабли):
 * - ЦБ РФ XML: windows-1251 (декодирование — на стороне фетчера), значения с запятой,
 *   поле Nominal (JPY за 100) → нормализуем к курсу за 1 единицу; дата DD.MM.YYYY.
 * - Выходные: курса на дату нет → берём последний рабочий день, rate_date фактический.
 * - Кросс-курсы вычисляем из котировок к базе источника, не храним.
 *
 * Всё десятичное деление — в BigInt с округлением half-up. Точность по умолчанию 10
 * знаков (совпадает с numeric(20,10) в схеме).
 */

import type { RateSnapshot } from './money.ts';

const DEFAULT_PLACES = 10;

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function toScaled(decimal: string): [bigint, number] {
  const s = decimal.trim();
  if (!DECIMAL_RE.test(s)) throw new Error(`Некорректное десятичное: "${decimal}"`);
  const negative = s.startsWith('-');
  const unsigned = negative ? s.slice(1) : s;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  const magnitude = BigInt(intPart + fracPart);
  return [negative ? -magnitude : magnitude, fracPart.length];
}

function roundDivHalfUp(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice >= d) return q + (n < 0n ? -1n : 1n);
  return q;
}

function formatScaled(scaled: bigint, places: number): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString();
  const sign = negative ? '-' : '';
  if (places === 0) return sign + digits;
  const padded = digits.padStart(places + 1, '0');
  const cut = padded.length - places;
  return `${sign}${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

/** Делит две десятичные строки с фиксированным числом знаков (half-up). */
export function divDecimal(a: string, b: string, places: number = DEFAULT_PLACES): string {
  const [ai, as_] = toScaled(a);
  const [bi, bs] = toScaled(b);
  if (bi === 0n) throw new Error('divDecimal: деление на ноль');
  const exp = places + bs - as_;
  let numerator = ai;
  let denom = bi;
  if (exp >= 0) numerator = ai * 10n ** BigInt(exp);
  else denom = bi * 10n ** BigInt(-exp);
  return formatScaled(roundDivHalfUp(numerator, denom), places);
}

/** Убирает хвостовые нули дробной части и лишнюю точку: "0.1250"→"0.125", "100.00"→"100". */
export function normalizeDecimal(decimal: string): string {
  if (!decimal.includes('.')) return decimal;
  let s = decimal.replace(/0+$/, '');
  if (s.endsWith('.')) s = s.slice(0, -1);
  return s;
}

function firstGroup(re: RegExp, text: string): string | undefined {
  const m = re.exec(text);
  return m?.[1];
}

/**
 * Парсит XML ЦБ РФ (уже декодированный из windows-1251) в котировки X→RUB за 1 единицу.
 */
export function parseCbrXml(xml: string): RateSnapshot[] {
  const dateMatch = /<ValCurs[^>]*\bDate="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml);
  const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : '';
  const quotes: RateSnapshot[] = [];
  for (const block of xml.match(/<Valute\b[\s\S]*?<\/Valute>/g) ?? []) {
    const charCode = firstGroup(/<CharCode>([^<]+)<\/CharCode>/, block);
    const nominal = firstGroup(/<Nominal>([^<]+)<\/Nominal>/, block);
    const value = firstGroup(/<Value>([^<]+)<\/Value>/, block);
    if (!charCode || !nominal || !value) continue;
    const perUnit = normalizeDecimal(
      divDecimal(value.trim().replace(',', '.'), nominal.trim(), DEFAULT_PLACES),
    );
    quotes.push({ from: charCode.trim(), to: 'RUB', rate: perUnit, source: 'cbr', date });
  }
  return quotes;
}

export interface FrankfurterResponse {
  amount: number;
  base: string;
  date: string;
  rates: Record<string, number>;
}

/** Раскладывает ответ Frankfurter (ЕЦБ) в котировки base→quote. */
export function parseFrankfurter(data: FrankfurterResponse): RateSnapshot[] {
  return Object.entries(data.rates).map(([to, rate]) => ({
    from: data.base,
    to,
    rate: String(rate),
    source: 'frankfurter',
    date: data.date,
  }));
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const ms = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  const dt = new Date(ms);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** Котировка from→to с датой ≤ on в пределах lookback; берётся ближайшая (максимальная дата). */
function findOnOrBefore(
  quotes: RateSnapshot[],
  from: string,
  to: string,
  on: string,
  lookbackDays: number,
): RateSnapshot | undefined {
  const minDate = addDaysISO(on, -lookbackDays);
  let best: RateSnapshot | undefined;
  for (const q of quotes) {
    if (q.from === from && q.to === to && q.date <= on && q.date >= minDate) {
      if (!best || q.date > best.date) best = q;
    }
  }
  return best;
}

interface Leg {
  rate: string;
  date: string;
  source: string;
}

function rateDirectOrInverse(
  quotes: RateSnapshot[],
  from: string,
  to: string,
  on: string,
  lookbackDays: number,
  places: number,
): Leg | null {
  const direct = findOnOrBefore(quotes, from, to, on, lookbackDays);
  if (direct) return { rate: direct.rate, date: direct.date, source: direct.source };
  const inverse = findOnOrBefore(quotes, to, from, on, lookbackDays);
  if (inverse) {
    return {
      rate: divDecimal('1', inverse.rate, places),
      date: inverse.date,
      source: inverse.source,
    };
  }
  return null;
}

export interface ResolveOptions {
  pivots?: string[];
  maxLookbackDays?: number;
  places?: number;
}

/**
 * Курс пары `from`→`to` на дату `on`: identity → прямая/обратная → кросс через пивот →
 * фоллбек на последний рабочий день (в пределах lookback). null, если не нашли.
 */
export function resolveRate(
  quotes: RateSnapshot[],
  from: string,
  to: string,
  on: string,
  opts: ResolveOptions = {},
): RateSnapshot | null {
  const pivots = opts.pivots ?? ['RUB', 'EUR', 'USD'];
  const lookback = opts.maxLookbackDays ?? 7;
  const places = opts.places ?? DEFAULT_PLACES;

  if (from === to) return { from, to, rate: '1', source: 'identity', date: on };

  const dio = rateDirectOrInverse(quotes, from, to, on, lookback, places);
  if (dio) return { from, to, rate: dio.rate, source: dio.source, date: dio.date };

  for (const pivot of pivots) {
    if (pivot === from || pivot === to) continue;
    const legFrom = rateDirectOrInverse(quotes, from, pivot, on, lookback, places);
    const legTo = rateDirectOrInverse(quotes, to, pivot, on, lookback, places);
    if (legFrom && legTo) {
      const rate = divDecimal(legFrom.rate, legTo.rate, places);
      const date = legFrom.date < legTo.date ? legFrom.date : legTo.date;
      return { from, to, rate, source: `cross:${pivot}`, date };
    }
  }
  return null;
}
