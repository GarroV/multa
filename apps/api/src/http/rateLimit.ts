import { createMiddleware } from 'hono/factory';
import { logger } from '../logger.ts';

/**
 * Ограничение частоты запросов.
 *
 * Появилось, когда приложение стало доступно из интернета (решение владельца 2026-08-02).
 * Регистрация открыта намеренно — продуктом пользуются владелец и его знакомые, — но открытая
 * регистрация без ограничения на публичном адресе это приглашение забить базу за ночь.
 *
 * Хранилище в памяти процесса: api работает в одном экземпляре, а лишний Redis нарушил бы профиль
 * нулевой стоимости. При перезапуске счётчики обнуляются — для защиты от перебора этого достаточно,
 * потому что перезапуск не в руках атакующего.
 *
 * Окно фиксированное, а не скользящее: на границе окна можно получить двойную квоту, и это
 * осознанный размен. Точное скользящее окно требует хранить метки каждого запроса, а разница
 * между «100 в минуту» и «200 на стыке минут» не меняет ничего в защите от перебора паролей.
 */

interface Bucket {
  /** Сколько запросов уже сделано в текущем окне. */
  count: number;
  /** Когда окно закончится (мс эпохи). */
  resetAt: number;
}

export interface RateRule {
  /** Длина окна в секундах. */
  readonly windowSec: number;
  /** Сколько запросов разрешено за окно. */
  readonly max: number;
}

/**
 * Правила по путям. Порядок важен: берётся первое совпадение по префиксу, поэтому частные пути
 * стоят выше общего.
 *
 * Дорогие ручки ограничены строже не из-за безопасности, а из-за цены: пересев демо переписывает
 * сотни строк, а разбор чека и голоса уходит в платный OpenAI — на публичном адресе это чужой
 * счёт за наш счёт.
 */
const RULES: readonly (readonly [string, RateRule])[] = [
  ['/v1/auth/sign-up', { windowSec: 3600, max: 10 }],
  ['/v1/auth/sign-in', { windowSec: 300, max: 20 }],
  ['/v1/auth/two-factor', { windowSec: 300, max: 20 }],
  ['/v1/demo/reset', { windowSec: 3600, max: 5 }],
  ['/v1/demo/enter', { windowSec: 600, max: 20 }],
  ['/v1/receipts/photo', { windowSec: 3600, max: 30 }],
  ['/v1/transactions/voice', { windowSec: 3600, max: 30 }],
  ['/v1/transactions/parse', { windowSec: 3600, max: 200 }],
  ['/v1/import/', { windowSec: 3600, max: 30 }],
];

/** Общий потолок на всё остальное: обычная работа в интерфейсе в него не упирается. */
const DEFAULT_RULE: RateRule = { windowSec: 60, max: 240 };

const buckets = new Map<string, Bucket>();

/** Чистка просроченных: без неё карта растёт по одному ключу на каждый увиденный IP. */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}

function ruleFor(path: string): readonly [string, RateRule] {
  for (const entry of RULES) if (path.startsWith(entry[0])) return entry;
  return ['*', DEFAULT_RULE];
}

/**
 * Клиент запроса. За Caddy и Tailscale реальный адрес приходит в `x-forwarded-for`; берём первый
 * элемент — он от ближайшего к клиенту прокси. Без заголовка все запросы попадут в один ключ:
 * это грубее, но безопаснее, чем не ограничивать вовсе.
 */
function clientOf(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return headers.get('x-real-ip')?.trim() || 'unknown';
}

export const rateLimit = createMiddleware(async (c, next) => {
  const path = c.req.path;
  // Статику и здоровье не считаем: они дешёвые, а health дёргает докер каждые несколько секунд.
  if (path === '/v1/health') return next();

  const [ruleKey, rule] = ruleFor(path);
  const now = Date.now();
  sweep(now);

  const key = `${clientOf(c.req.raw.headers)} ${ruleKey}`;
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowSec * 1000 });
    return next();
  }

  if (bucket.count >= rule.max) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    // Логируем один раз на превышение, а не на каждый запрос сверх лимита.
    if (bucket.count === rule.max) logger.warn(`rate limit: ${key}`);
    bucket.count += 1;
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: 'rate_limited', retryAfter }, 429);
  }

  bucket.count += 1;
  await next();
});

/** Сброс счётчиков — только для тестов: между сценариями лимит не должен протекать. */
export function resetRateLimits(): void {
  buckets.clear();
}
