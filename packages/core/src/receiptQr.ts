/**
 * Разбор QR фискального чека — бесплатный путь пайплайна чеков (01-domain-model §Receipt).
 * QR пробуется всегда первым: он даёт структурные данные без единого запроса к платному LLM.
 *
 * Поддержаны два формата:
 * - **ФНС РФ** — плоские параметры `t/s/fn/i/fp/n` прямо в QR: сумма и дата читаются сразу,
 *   реквизиты нужны, чтобы потом запросить позиции у оператора фискальных данных.
 * - **Сербия (suf.purs.gov.rs)** — ссылка на фискальный сервис: сумма и позиции живут там,
 *   поэтому здесь фиксируем только адрес и валюту, а не выдумываем итог.
 *
 * Ничего «почти похожего» чеком не считаем: без фискальных реквизитов сумма непроверяема,
 * а молча принятый мусор в бюджете хуже отказа.
 */

import { fromMajor } from './money.ts';

export type ReceiptProvider = 'fns_ru' | 'suf_rs';

export interface ParsedReceiptQr {
  readonly provider: ReceiptProvider;
  /** Итог чека; null — сумма известна только фискальному сервису (Сербия). */
  readonly totalMinor: bigint | null;
  readonly currency: string;
  /** Момент покупки в ISO (UTC); null — дата в QR битая. */
  readonly purchasedAt: string | null;
  readonly raw: string;
  /** Фискальные реквизиты для запроса позиций (ФНС). */
  readonly reference?: { fn: string; fd: string; fp: string };
}

/** `20260730T1215` / `20260730T121533` → ISO. Битая дата → null, чек от этого не пропадает. */
function parseFnsDate(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, min, sec] = m;
  return `${y}-${mo}-${d}T${h}:${min}:${sec ?? '00'}Z`;
}

function parseFns(payload: string): ParsedReceiptQr | null {
  const params = new URLSearchParams(payload);
  const [sum, fn, fd, fp] = [params.get('s'), params.get('fn'), params.get('i'), params.get('fp')];
  // Реквизиты обязательны: без них сумму нельзя проверить у оператора данных.
  if (!sum || !fn || !fd || !fp) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(sum) || Number(sum) <= 0) return null;

  return {
    provider: 'fns_ru',
    totalMinor: fromMajor(sum, 'RUB').minor,
    currency: 'RUB',
    purchasedAt: parseFnsDate(params.get('t') ?? undefined),
    raw: payload,
    reference: { fn, fd, fp },
  };
}

function parseSerbia(payload: string): ParsedReceiptQr | null {
  try {
    const url = new URL(payload);
    if (!/(^|\.)suf\.purs\.gov\.rs$/i.test(url.hostname)) return null;
    return {
      provider: 'suf_rs',
      totalMinor: null,
      currency: 'RSD',
      purchasedAt: null,
      raw: payload,
    };
  } catch {
    return null;
  }
}

/** Разбирает содержимое QR. null — это не фискальный чек (или формат не поддержан). */
export function parseReceiptQr(payload: string): ParsedReceiptQr | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('http')) return parseSerbia(trimmed);
  return parseFns(trimmed);
}
