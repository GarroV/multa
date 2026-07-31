/**
 * Идентификаторы из пути.
 *
 * Кривой id — это «нет такого», а не сбой сервера: Postgres на `not-a-uuid` бросает 22P02, и без
 * проверки ручка отвечала 500 (найдено адверсарным аудитом на `/v1/exchange-ops/:id` и
 * `/v1/buckets/:id`). Пятисотка вместо 404 и врёт пользователю, и засоряет логи чужими ошибками,
 * поэтому проверка живёт в одном месте и применяется на границе всех ручек с `:id`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
