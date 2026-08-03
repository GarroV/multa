import { randomUUID } from 'node:crypto';
import { setCookie } from 'hono/cookie';
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
  /** Сколько запросов разрешено одному клиенту за окно. */
  readonly max: number;
  /**
   * Потолок на всех разом за то же окно. Нужен потому, что клиента мы отличаем по метке, а метку
   * злоупотребляющий сбрасывает в один клик — значит персональный лимит его не держит. Держит этот.
   */
  readonly globalMax: number;
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
  ['/v1/auth/sign-up', { windowSec: 3600, max: 10, globalMax: 60 }],
  ['/v1/auth/sign-in', { windowSec: 300, max: 20, globalMax: 200 }],
  ['/v1/auth/two-factor', { windowSec: 300, max: 20, globalMax: 200 }],
  ['/v1/demo/reset', { windowSec: 3600, max: 5, globalMax: 20 }],
  ['/v1/demo/enter', { windowSec: 600, max: 20, globalMax: 200 }],
  ['/v1/receipts/photo', { windowSec: 3600, max: 30, globalMax: 120 }],
  ['/v1/transactions/voice', { windowSec: 3600, max: 30, globalMax: 120 }],
  ['/v1/transactions/parse', { windowSec: 3600, max: 200, globalMax: 2000 }],
  ['/v1/import/', { windowSec: 3600, max: 30, globalMax: 120 }],
];

/** Общий потолок на всё остальное: обычная работа в интерфейсе в него не упирается. */
const DEFAULT_RULE: RateRule = { windowSec: 60, max: 240, globalMax: 3000 };

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

/** Имя метки клиента. httpOnly: она служебная, интерфейсу знать о ней незачем. */
const CLIENT_COOKIE = 'multa_c';

/**
 * Кто именно к нам пришёл.
 *
 * Порядок продиктован тем, что реально доступно. За Tailscale Serve и Funnel адрес клиента до
 * приложения **не доходит**: туннель проксирует на localhost, и Caddy видит docker-шлюз — то есть
 * один и тот же адрес у всех. Пойман фактически: первая версия лимитера писала в лог ключ
 * `172.21.0.1`, и один человек, упершийся в лимит регистрации, запер бы всех остальных.
 *
 * Поэтому:
 * 1. `x-forwarded-for` — если однажды появится настоящий обратный прокси, ключ станет точным;
 * 2. личность tailnet (`tailscale-user-login`) — для своих устройств она есть всегда;
 * 3. собственная метка в cookie — отличает обычных людей друг от друга, чтобы они не делили
 *    квоту. От злоупотребления она не защищает: метка сбрасывается в один клик. Для этого есть
 *    общий потолок правила (`globalMax`), и держит именно он.
 */
function clientOf(c: { req: { raw: Request } }): string {
  const headers = c.req.raw.headers;
  const forwarded = headers.get('x-forwarded-for');
  // Docker-шлюз и локалхост в роли «клиента» — признак того, что настоящего адреса нам не дали.
  const first = forwarded?.split(',')[0]?.trim();
  if (first && !isProxyHop(first)) return `ip:${first}`;

  const tailnetUser = headers.get('tailscale-user-login');
  if (tailnetUser) return `ts:${tailnetUser}`;

  const cookie = headers.get('cookie') ?? '';
  const marked = new RegExp(`(?:^|; )${CLIENT_COOKIE}=([A-Za-z0-9_-]{8,64})`).exec(cookie);
  return marked ? `c:${marked[1]}` : '';
}

/** Адреса, за которыми стоит наш же прокси, а не человек. */
function isProxyHop(ip: string): boolean {
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('172.') ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.')
  );
}

export const rateLimit = createMiddleware(async (c, next) => {
  const path = c.req.path;
  // Статику и здоровье не считаем: они дешёвые, а health дёргает докер каждые несколько секунд.
  if (path === '/v1/health') return next();

  const [ruleKey, rule] = ruleFor(path);
  const now = Date.now();
  sweep(now);

  let client = clientOf(c);
  if (!client) {
    /*
     * Метку выдаём где угодно, кроме `/v1/auth/*`.
     *
     * Причина конкретная и поймана вживую: better-auth возвращает СВОЙ объект Response со своими
     * `Set-Cookie`, и кука, поставленная нами на контекст, его заголовок вытесняла — регистрация
     * отвечала 200, но сессионной куки в ответе не оказывалось, и следующий же запрос получал 401.
     *
     * Интерфейс дёргает `/v1/me` при загрузке, поэтому к моменту входа метка уже есть. Клиент,
     * который пришёл сразу на auth без метки, попадает в общую корзину — грубее, но безопаснее:
     * общий потолок правила его всё равно держит, а сессию мы ему не ломаем.
     */
    if (path.startsWith('/v1/auth/')) {
      client = 'anon';
    } else {
      client = `c:${randomUUID().replaceAll('-', '')}`;
      setCookie(c, CLIENT_COOKIE, client.slice(2), {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        maxAge: 365 * 24 * 3600,
        secure: c.req.url.startsWith('https://'),
      });
    }
  }

  const denied =
    hit(`${client} ${ruleKey}`, rule.max, rule.windowSec, now) ??
    hit(`* ${ruleKey}`, rule.globalMax, rule.windowSec, now);

  if (denied !== null) {
    c.header('Retry-After', String(denied));
    return c.json({ error: 'rate_limited', retryAfter: denied }, 429);
  }

  await next();
});

/**
 * Отмечает запрос в корзине. Возвращает `null`, если запрос разрешён, иначе — через сколько секунд
 * повторять. Лог пишется ровно на переходе через порог: иначе шквал запросов даёт шквал строк.
 */
function hit(key: string, max: number, windowSec: number, now: number): number | null {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return null;
  }
  bucket.count += 1;
  if (bucket.count <= max) return null;
  if (bucket.count === max + 1) logger.warn(`rate limit: ${key}`);
  return Math.ceil((bucket.resetAt - now) / 1000);
}

/** Сброс счётчиков — только для тестов: между сценариями лимит не должен протекать. */
export function resetRateLimits(): void {
  buckets.clear();
}
