import { fromMajor } from '@multa/core';
import { logger } from '../logger.ts';

/**
 * Ключ OpenAI читаем из process.env напрямую, а не через env-схему: модули внешних сервисов
 * должны импортироваться в тестах без полного окружения (иначе один отсутствующий DATABASE_URL
 * рушит юниты разбора ответов). Валидация ключа при старте живёт в env.ts.
 */
const openaiKey = (): string | undefined => process.env.OPENAI_API_KEY;

/**
 * Vision-фоллбэк чеков (Спринт 5). Включается ТОЛЬКО когда QR не сработал: QR бесплатный и
 * точный, а это единственный платный вызов в продукте (CLAUDE.md: профиль $0 + один ключ OpenAI).
 *
 * Модель отвечает по strict-схеме (structured output), но мы всё равно перепроверяем ответ:
 * галлюцинация в сумме тихо испортит бюджет. Правила отказа:
 * - нет итога или валюты → null (сумму из позиций не досчитываем: чек мог быть недосканирован);
 * - битые позиции выбрасываются, но сам чек остаётся — итог важнее состава;
 * - любой сбой сети/ключа → null, и вызывающий уводит сумму в «Общее» одним тапом.
 */

const MODEL = 'gpt-4o-mini';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/** JSON-схема для structured output: обязательны итог и валюта. */
export const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: ['string', 'null'] },
    currency: { type: 'string', description: 'ISO 4217, три буквы' },
    purchasedOn: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    totalMajor: {
      type: 'string',
      description: 'итог чека в основных единицах, точка как разделитель',
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          amountMajor: { type: 'string' },
        },
        required: ['name', 'amountMajor'],
        additionalProperties: false,
      },
    },
  },
  required: ['currency', 'totalMajor', 'items', 'merchant', 'purchasedOn'],
  additionalProperties: false,
} as const;

export interface VisionReceipt {
  readonly merchant: string | null;
  readonly currency: string;
  readonly purchasedOn: string | null;
  readonly totalMinor: bigint;
  readonly items: readonly { name: string; amountMinor: bigint }[];
}

const isAmount = (v: unknown): v is string =>
  typeof v === 'string' && /^\d+(\.\d{1,2})?$/.test(v.trim());

/** Разбирает ответ модели. null — ответу нельзя доверять, чек уйдёт в «Общее». */
export function parseVisionPayload(raw: string): VisionReceipt | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const currency = typeof data.currency === 'string' ? data.currency.trim().toUpperCase() : null;
  if (!currency || currency.length !== 3) return null;

  const total = data.totalMajor;
  if (!isAmount(total) || Number(total) <= 0) return null;

  const purchasedOnRaw = typeof data.purchasedOn === 'string' ? data.purchasedOn.trim() : '';
  const purchasedOn = /^\d{4}-\d{2}-\d{2}$/.test(purchasedOnRaw) ? purchasedOnRaw : null;

  const rawItems = Array.isArray(data.items) ? data.items : [];
  const items = rawItems
    .filter((i): i is { name: string; amountMajor: string } => {
      const item = i as { name?: unknown; amountMajor?: unknown };
      return typeof item.name === 'string' && item.name.trim() !== '' && isAmount(item.amountMajor);
    })
    .map((i) => ({
      name: i.name.trim(),
      amountMinor: fromMajor(i.amountMajor.trim(), currency).minor,
    }))
    .filter((i) => i.amountMinor > 0n);

  return {
    merchant:
      typeof data.merchant === 'string' && data.merchant.trim() !== ''
        ? data.merchant.trim()
        : null,
    currency,
    purchasedOn,
    totalMinor: fromMajor(total.trim(), currency).minor,
    items,
  };
}

/**
 * Распознаёт чек по изображению (data URL или https). Возвращает null, если ключа нет,
 * сеть отказала или ответу нельзя доверять — вызывающий тогда уводит сумму в «Общее».
 */
export async function recognizeReceipt(imageUrl: string): Promise<VisionReceipt | null> {
  if (!openaiKey()) {
    logger.warn('vision: OPENAI_API_KEY не задан — фоллбэк недоступен');
    return null;
  }
  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey()}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Ты извлекаешь данные из фотографии кассового чека. Отвечай только фактами с чека. ' +
              'Если суммы или валюты не видно — верни пустую строку в totalMajor. Ничего не додумывай.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Извлеки итог, валюту, дату, магазин и позиции этого чека.' },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'receipt', strict: true, schema: RECEIPT_SCHEMA },
        },
        max_tokens: 1500,
      }),
    });
    if (!res.ok) {
      logger.warn('vision: OpenAI ответил ошибкой', { status: res.status });
      return null;
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseVisionPayload(content);
  } catch (err) {
    logger.error('vision: сбой распознавания', err);
    return null;
  }
}
