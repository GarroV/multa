import { fromMajor } from '@multa/core';
import { env } from '../env.ts';
import { logger } from '../logger.ts';

/**
 * LLM-фоллбэк текстового ввода (хвост Спринта 5). Порядок как у чеков: сначала бесплатный
 * regex-парсер `parseEntry` в ядре, и только если он не нашёл суммы — этот платный путь.
 *
 * Модель отвечает по strict-схеме, но ответ всё равно перепроверяется: «понял так» с
 * выдуманной суммой молча испортит бюджет. Правила:
 * - нет суммы → null, и пользователь получает просьбу уточнить, а не случайную трату;
 * - валюты нет → базовая воркспейса (самый вероятный случай), а не отказ;
 * - дата из будущего отбрасывается: вводят факт, а не план;
 * - у прихода категории не бывает, даже если модель её придумала.
 */

const MODEL = 'gpt-4o-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export const TEXT_ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['expense', 'income'] },
    amountMajor: { type: 'string', description: 'сумма в основных единицах, точка как разделитель' },
    currency: { type: ['string', 'null'], description: 'ISO 4217, если названа' },
    occurredOn: { type: ['string', 'null'], description: 'YYYY-MM-DD, если названа' },
    categoryName: { type: ['string', 'null'], description: 'ровно из переданного списка категорий' },
    note: { type: ['string', 'null'] },
  },
  required: ['kind', 'amountMajor', 'currency', 'occurredOn', 'categoryName', 'note'],
  additionalProperties: false,
} as const;

export interface TextEntryContext {
  readonly baseCurrency: string;
  readonly today: string;
  readonly categories?: readonly string[];
}

export interface ParsedTextEntry {
  readonly kind: 'expense' | 'income';
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly occurredOn: string;
  readonly categoryName: string | null;
  readonly note: string | null;
}

const isAmount = (v: unknown): v is string => typeof v === 'string' && /^-?\d+(\.\d{1,2})?$/.test(v.trim());

export function parseTextPayload(raw: string, ctx: TextEntryContext): ParsedTextEntry | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const amount = data.amountMajor;
  if (!isAmount(amount) || Number(amount) <= 0) return null;

  const kind = data.kind === 'income' ? 'income' : 'expense';
  const currencyRaw = typeof data.currency === 'string' ? data.currency.trim().toUpperCase() : '';
  const currency = currencyRaw.length === 3 ? currencyRaw : ctx.baseCurrency.toUpperCase();

  const dateRaw = typeof data.occurredOn === 'string' ? data.occurredOn.trim() : '';
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) && dateRaw <= ctx.today;
  const occurredOn = validDate ? dateRaw : ctx.today;

  const categoryRaw = typeof data.categoryName === 'string' ? data.categoryName.trim() : '';
  // Категорию принимаем только из списка воркспейса: выдуманная строка создала бы мусор.
  const known = ctx.categories?.some((c) => c.toLowerCase() === categoryRaw.toLowerCase());
  const categoryName = kind === 'income' || !categoryRaw || (ctx.categories && !known) ? null : categoryRaw;

  const note = typeof data.note === 'string' && data.note.trim() !== '' ? data.note.trim() : null;

  return { kind, amountMinor: fromMajor(amount.trim(), currency).minor, currency, occurredOn, categoryName, note };
}

/** Разбирает свободную фразу. null — ключа нет, сеть отказала или ответу нельзя доверять. */
export async function parseEntryWithLlm(text: string, ctx: TextEntryContext): Promise<ParsedTextEntry | null> {
  if (!env.OPENAI_API_KEY) {
    logger.warn('textLlm: OPENAI_API_KEY не задан — фоллбэк недоступен');
    return null;
  }
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Ты превращаешь короткую фразу о деньгах в структуру. Сегодня ' +
              ctx.today +
              '. Базовая валюта: ' +
              ctx.baseCurrency +
              '. Доступные категории: ' +
              (ctx.categories?.join(', ') || 'нет') +
              '. Категорию выбирай только из этого списка, иначе null. Ничего не додумывай: ' +
              'если суммы во фразе нет, верни "0" в amountMajor.',
          },
          { role: 'user', content: text },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'entry', strict: true, schema: TEXT_ENTRY_SCHEMA },
        },
        max_tokens: 400,
      }),
    });
    if (!res.ok) {
      logger.warn('textLlm: OpenAI ответил ошибкой', { status: res.status });
      return null;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseTextPayload(content, ctx);
  } catch (err) {
    logger.error('textLlm: сбой разбора', err);
    return null;
  }
}
