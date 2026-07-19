/**
 * Деньги в Multa — строго integer minor units (bigint). Float в деньгах запрещён.
 * Экспоненты — по ISO 4217, не хардкодить «÷100» (JPY=0, BHD=3 и т.д.).
 * Конвертация — через иммутабельный снапшот курса; вся математика в BigInt.
 *
 * Инвариант 1 (01-domain-model): деньги — только integer minor units.
 * Инвариант 2: снапшот курса иммутабелен; convert не мутирует вход.
 */

export type Currency = string; // ISO 4217 alpha-3

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

/** Направленный снапшот: 1 единица `from` = `rate` единиц `to`. */
export interface RateSnapshot {
  readonly from: Currency;
  readonly to: Currency;
  readonly rate: string; // десятичная строка, напр. "98.1"
  readonly source: string; // 'cbr' | 'ecb' | 'frankfurter' | 'manual'
  readonly date: string; // ISO YYYY-MM-DD — дата котировки
}

// Валюты без минорных единиц (exponent 0).
const EXPONENT_0 = new Set([
  'JPY',
  'KRW',
  'CLP',
  'ISK',
  'VND',
  'HUF',
  'XAF',
  'XOF',
  'XPF',
  'PYG',
  'RWF',
  'UGX',
  'VUV',
  'DJF',
  'GNF',
  'KMF',
]);

// Валюты с тремя знаками (exponent 3).
const EXPONENT_3 = new Set(['BHD', 'KWD', 'OMR', 'TND', 'IQD', 'JOD', 'LYD', 'DZD']);

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export function exponentOf(currency: Currency): number {
  const c = currency.toUpperCase();
  if (EXPONENT_0.has(c)) return 0;
  if (EXPONENT_3.has(c)) return 3;
  return 2;
}

export function money(minor: bigint, currency: Currency): Money {
  return { minor, currency: currency.toUpperCase() };
}

/** Парсит major-строку ("79.45", "1000", "-250") в Money по экспоненте валюты. */
export function fromMajor(major: string, currency: Currency): Money {
  const trimmed = major.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw new Error(`Некорректная денежная строка: "${major}" (ожидается десятичное с точкой)`);
  }
  const exp = exponentOf(currency);
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ''] = unsigned.split('.');
  if (fracPart.length > exp) {
    throw new Error(
      `Слишком много знаков после запятой для ${currency} (экспонента ${exp}): "${major}"`,
    );
  }
  const paddedFrac = fracPart.padEnd(exp, '0');
  const digits = intPart + paddedFrac;
  const magnitude = BigInt(digits);
  return money(negative ? -magnitude : magnitude, currency);
}

/** Money → каноническая major-строка ("79.45", "1000", "-250.00"). Без локали и группировки. */
export function toMajorString(m: Money): string {
  const exp = exponentOf(m.currency);
  const negative = m.minor < 0n;
  const digits = (negative ? -m.minor : m.minor).toString();
  const sign = negative ? '-' : '';
  if (exp === 0) return sign + digits;
  const padded = digits.padStart(exp + 1, '0');
  const cut = padded.length - exp;
  return `${sign}${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Несовпадение валют: ${a.currency} и ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function negate(m: Money): Money {
  return money(-m.minor, m.currency);
}

export function abs(m: Money): Money {
  return money(m.minor < 0n ? -m.minor : m.minor, m.currency);
}

export function isZero(m: Money): boolean {
  return m.minor === 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

/** Целочисленное деление n/d с округлением половины «от нуля» (half-up). d > 0. */
function roundDivHalfUp(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const twiceRemainder = (r < 0n ? -r : r) * 2n;
  if (twiceRemainder >= d) {
    return q + (n < 0n ? -1n : 1n);
  }
  return q;
}

/**
 * Конвертирует Money в валюту `rate.to` по снапшоту. Валюта суммы обязана совпадать с `rate.from`.
 * result_minor = round( minor * rateInt * 10^expTo / (10^scale * 10^expFrom) ), всё в BigInt.
 */
export function convert(m: Money, rate: RateSnapshot): Money {
  if (m.currency !== rate.from.toUpperCase()) {
    throw new Error(
      `convert: валюта суммы ${m.currency} не совпадает с from снапшота ${rate.from}`,
    );
  }
  if (!DECIMAL_RE.test(rate.rate.trim())) {
    throw new Error(`convert: некорректный курс "${rate.rate}"`);
  }
  const [rateInt, scale] = decimalToScaledInt(rate.rate.trim());
  const expFrom = exponentOf(rate.from);
  const expTo = exponentOf(rate.to);
  const numerator = m.minor * rateInt * 10n ** BigInt(expTo);
  const denom = 10n ** BigInt(scale + expFrom);
  const resultMinor = roundDivHalfUp(numerator, denom);
  return money(resultMinor, rate.to);
}

/** "0.011" → [11n, 3]; "98.1" → [981n, 1]; "5" → [5n, 0]. */
function decimalToScaledInt(decimal: string): [bigint, number] {
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const scale = fracPart.length;
  const magnitude = BigInt(intPart + fracPart);
  return [negative ? -magnitude : magnitude, scale];
}
