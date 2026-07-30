import { logger } from '../logger.ts';

/**
 * Ключ OpenAI читаем из process.env напрямую, а не через env-схему: модули внешних сервисов
 * должны импортироваться в тестах без полного окружения (иначе один отсутствующий DATABASE_URL
 * рушит юниты разбора ответов). Валидация ключа при старте живёт в env.ts.
 */
const openaiKey = (): string | undefined => process.env.OPENAI_API_KEY;

/**
 * Голосовой ввод (остаток Спринта 5): запись → Whisper → тот же текстовый пайплайн.
 *
 * Голос не получает своей логики разбора: расшифровка отдаётся уже готовой цепочке
 * «regex ядра → LLM-фоллбэк». Одна правда о том, как понимать фразу про деньги, — иначе
 * голос и клавиатура начали бы расходиться в поведении.
 *
 * Всё, что можно отсеять до платного вызова, отсекаем здесь: тишина, чужой формат,
 * гигантский файл. Платим только за то, что имеет шанс распознаться.
 */

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

/** Порог размера записи. Минута голоса в opus — сотни килобайт, 10 МБ хватает с запасом. */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

/** Форматы, которые принимает Whisper. Остальное отвергаем до отправки. */
const MIME_EXT: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/m4a': 'm4a',
};

export interface DecodedAudio {
  readonly mime: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** Разбирает `data:audio/...;base64,...`. null — это не пригодная запись. */
export function decodeAudioDataUrl(dataUrl: string): DecodedAudio | null {
  const match = /^data:([^;,]+)(;[^,]*)?,(.*)$/s.exec(dataUrl.trim());
  if (!match) return null;
  const mime = match[1]!.toLowerCase();
  const ext = MIME_EXT[mime];
  if (!ext) return null;

  const base64 = match[3] ?? '';
  if (base64.trim() === '') return null;
  // Оценка размера до декодирования: 4 символа base64 ≈ 3 байта.
  if ((base64.length * 3) / 4 > MAX_AUDIO_BYTES) return null;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return null;

  try {
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
    if (bytes.byteLength === 0) return null;
    return { mime, filename: `voice.${ext}`, bytes };
  } catch {
    return null;
  }
}

/** Расшифровывает голосовую заметку. null — ключа нет, формат не тот или сеть отказала. */
export async function transcribe(dataUrl: string, language = 'ru'): Promise<string | null> {
  const audio = decodeAudioDataUrl(dataUrl);
  if (!audio) return null;
  if (!openaiKey()) {
    logger.warn('voice: OPENAI_API_KEY не задан — расшифровка недоступна');
    return null;
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([audio.bytes], { type: audio.mime }), audio.filename);
    form.append('model', MODEL);
    form.append('language', language);
    // Подсказка модели: короткие фразы про траты, чтобы «четыреста восемьдесят» не стало «400 80».
    form.append('prompt', 'Короткая фраза о трате или приходе денег: сумма, категория, валюта, когда.');

    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey()}` },
      body: form,
    });
    if (!res.ok) {
      logger.warn('voice: Whisper ответил ошибкой', { status: res.status });
      return null;
    }
    const body = (await res.json()) as { text?: string };
    const text = body.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    logger.error('voice: сбой расшифровки', err);
    return null;
  }
}
