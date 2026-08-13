/**
 * Очередь трат, записанных без сети (Спринт 6).
 *
 * Приложение открывается из кэша, значит человек может записать трату в метро — и обязан не
 * потерять её. Молча проглотить запись хуже, чем отказать: он видел «записано» и больше к этой
 * покупке не вернётся.
 *
 * Почему localStorage, а не IndexedDB: очередь — это единицы коротких записей за раз, синхронное
 * чтение здесь проще и надёжнее, а сложность IndexedDB (версии, транзакции, миграции) ничего не
 * добавляет к задаче «дожить до появления сети».
 *
 * Почему у каждой попытки свой `clientKey`: повтор не может знать, дошла ли первая отправка —
 * ответ мог пропасть при уже записанной трате. Ключ уникален в воркспейсе на стороне БД, поэтому
 * повтор отдаёт ту же трату вместо второй такой же (миграция 0019).
 */

const KEY = 'multa.outbox.v1';

export interface QueuedSpend {
  /** Ключ попытки: один и тот же при всех повторах этой записи. */
  readonly clientKey: string;
  /** Тело запроса как есть — очередь не знает и не должна знать его состав. */
  readonly body: Record<string, unknown>;
  /** Когда попало в очередь: для «в очереди с 14:05», если понадобится показать. */
  readonly queuedAt: string;
}

function read(): QueuedSpend[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as QueuedSpend[]) : [];
  } catch {
    // Испорченная или запрещённая (приватный режим) очередь — пустая, а не причина уронить экран.
    return [];
  }
}

function write(items: readonly QueuedSpend[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Хранилище недоступно: очередь не переживёт перезагрузку, но текущая сессия работает.
  }
}

export function queueSize(): number {
  return read().length;
}

export function enqueue(item: QueuedSpend): void {
  write([...read(), item]);
}

export function dequeue(clientKey: string): void {
  write(read().filter((i) => i.clientKey !== clientKey));
}

export function queued(): QueuedSpend[] {
  return read();
}

/**
 * Отправляет очередь. Возвращает число записей, доехавших до сервера.
 *
 * Порядок сохраняется, и на первой же сетевой ошибке отправка прекращается: если сети снова нет,
 * долбить сервер остатком очереди незачем. Ошибка ВАЛИДАЦИИ — другое дело: такая запись не станет
 * валидной от повторов и должна уйти из очереди, иначе она навсегда заблокирует хвост.
 */
export async function flush(
  send: (item: QueuedSpend) => Promise<'sent' | 'rejected' | 'offline'>,
): Promise<number> {
  let sent = 0;
  for (const item of read()) {
    const result = await send(item);
    if (result === 'offline') break;
    dequeue(item.clientKey);
    if (result === 'sent') sent += 1;
  }
  return sent;
}
