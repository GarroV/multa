import {
  parseCbrXml,
  parseFrankfurter,
  type FrankfurterResponse,
  type RateSnapshot,
} from '@multa/core';

const CBR_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?base=EUR';

/** ЦБ РФ: XML в windows-1251 → котировки X→RUB за 1 единицу (грабли: кодировка, запятая, Nominal). */
export async function fetchCbr(): Promise<RateSnapshot[]> {
  const res = await fetch(CBR_URL);
  if (!res.ok) throw new Error(`CBR HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  const xml = new TextDecoder('windows-1251').decode(buffer);
  return parseCbrXml(xml);
}

/** Frankfurter (ЕЦБ): JSON base=EUR → котировки EUR→X. */
export async function fetchFrankfurter(): Promise<RateSnapshot[]> {
  const res = await fetch(FRANKFURTER_URL);
  if (!res.ok) throw new Error(`Frankfurter HTTP ${res.status}`);
  const data = (await res.json()) as FrankfurterResponse;
  return parseFrankfurter(data);
}
