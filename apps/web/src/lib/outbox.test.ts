import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dequeue, enqueue, flush, queued, queueSize } from './outbox.ts';

/**
 * Очередь трат без сети (Спринт 6). Проверяется главное свойство: запись не теряется и не
 * удваивается, а сбой одной строки не блокирует остальные.
 */
const item = (key: string) => ({
  clientKey: key,
  body: { amountMinor: '100', currency: 'RUB' },
  queuedAt: '2026-08-13T10:00:00.000Z',
});

describe('outbox', () => {
  beforeEach(() => localStorage.clear());

  it('запись доживает до чтения', () => {
    enqueue(item('a'));
    expect(queueSize()).toBe(1);
    expect(queued()[0]!.clientKey).toBe('a');
  });

  it('порядок сохраняется: траты вводят серией, и хронология важна', () => {
    enqueue(item('a'));
    enqueue(item('b'));
    expect(queued().map((i) => i.clientKey)).toEqual(['a', 'b']);
  });

  it('отправленное уходит из очереди', async () => {
    enqueue(item('a'));
    enqueue(item('b'));
    const sent = await flush(async () => 'sent');
    expect(sent).toBe(2);
    expect(queueSize()).toBe(0);
  });

  it('пропавшая сеть останавливает отправку и сохраняет хвост', async () => {
    enqueue(item('a'));
    enqueue(item('b'));
    const send = vi
      .fn<() => Promise<'sent' | 'rejected' | 'offline'>>()
      .mockResolvedValueOnce('sent')
      .mockResolvedValueOnce('offline');
    const sent = await flush(send);
    expect(sent).toBe(1);
    // Вторая осталась в очереди — не потеряна и будет отправлена при следующем появлении сети.
    expect(queued().map((i) => i.clientKey)).toEqual(['b']);
  });

  it('отклонённая сервером запись уходит из очереди, а не блокирует хвост', async () => {
    enqueue(item('bad'));
    enqueue(item('good'));
    const send = vi
      .fn<() => Promise<'sent' | 'rejected' | 'offline'>>()
      .mockResolvedValueOnce('rejected')
      .mockResolvedValueOnce('sent');
    const sent = await flush(send);
    // Доехала одна, но очередь пуста: невалидная запись не станет валидной от повторов.
    expect(sent).toBe(1);
    expect(queueSize()).toBe(0);
  });

  it('испорченное хранилище читается как пустая очередь, а не роняет экран', () => {
    localStorage.setItem('multa.outbox.v1', '{не json');
    expect(queueSize()).toBe(0);
  });

  it('удаление по ключу не задевает соседей', () => {
    enqueue(item('a'));
    enqueue(item('b'));
    dequeue('a');
    expect(queued().map((i) => i.clientKey)).toEqual(['b']);
  });
});
