import { describe, expect, it } from 'vitest';
import { scrubPii } from './scrub.ts';

/**
 * Очистка отчёта об ошибке от личного (Спринт 6, «Sentry без PII»).
 *
 * Мы шлём ошибки в свой же лог — но это не повод класть туда почту, токен из ссылки или сумму
 * чужой зарплаты. Стектрейс и текст ошибки бывают склеены с данными пользователя: сообщение вида
 * `Failed to parse "Зарплата 133980"` уносит в лог доход человека.
 *
 * Правило простое: вырезаем то, что опознаётся однозначно (почта, длинные цифровые
 * последовательности, значения параметров запроса), и не пытаемся угадывать остальное — иначе
 * очистка либо съест полезное, либо создаст ложное чувство безопасности.
 */
describe('scrubPii', () => {
  it('вырезает почту', () => {
    expect(scrubPii('failed for v.garro@dodobrands.io while saving')).toBe(
      'failed for [email] while saving',
    );
  });

  it('вырезает значения параметров запроса, оставляя имена', () => {
    expect(scrubPii('GET /v1/demo/enter?token=abc123&code=XYZ failed')).toBe(
      'GET /v1/demo/enter?token=[value]&code=[value] failed',
    );
  });

  it('вырезает длинные числа: это суммы, id и токены', () => {
    expect(scrubPii('amount 13398000 rejected')).toBe('amount [number] rejected');
  });

  it('короткие числа оставляет: строки, коды и версии без них не читаются', () => {
    expect(scrubPii('line 42 of chunk 7')).toBe('line 42 of chunk 7');
  });

  it('режет длину: лог не место для мегабайтного стектрейса', () => {
    expect(scrubPii('a'.repeat(5000)).length).toBeLessThanOrEqual(2000);
  });

  it('пустое и мусорное не роняет', () => {
    expect(scrubPii('')).toBe('');
  });
});
