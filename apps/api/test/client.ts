import { and, eq } from 'drizzle-orm';
import { app } from '../src/app.ts';
import { db } from '../src/db/client.ts';
import { fxRates } from '../src/db/schema/domain.ts';
import type { PlanDto } from '../src/plan/assemble.ts';

/**
 * Тестовый клиент поверх Hono: те же HTTP-запросы, что делает браузер, без поднятия сервера.
 *
 * Cookie сессии живёт в клиенте, потому что на ней и держится изоляция workspace (правило 7):
 * тест не может «подсунуть» workspace_id — ровно как не может и настоящий клиент.
 */

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'IntegrationTest123!';

export interface TestClient {
  readonly email: string;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  patch(path: string, body?: unknown): Promise<Response>;
  del(path: string): Promise<Response>;
}

let seq = 0;

function makeClient(): TestClient {
  // Банка cookie: better-auth ставит несколько (сессия + признак TOTP), и обрезка до первой
  // ломала бы сценарии, где важна не только сессия.
  const jar = new Map<string, string>();
  const email = `test-${process.pid}-${++seq}@multa.local`;

  const request = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.request(`http://localhost:3000${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  };

  return {
    email,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body ?? {}),
    put: (path, body) => request('PUT', path, body ?? {}),
    patch: (path, body) => request('PATCH', path, body ?? {}),
    del: (path) => request('DELETE', path),
  };
}

/** Разбирает тело ответа, но сначала требует ожидаемый статус — иначе тест врёт про причину. */
export async function expectOk<T>(res: Response, status = 200): Promise<T> {
  if (res.status !== status) {
    throw new Error(`ожидался ${status}, получен ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** Анонимный клиент без сессии — для проверок «без токена ничего не отдаём». */
export function anonymous(): TestClient {
  return makeClient();
}

/** Зарегистрированный пользователь без workspace. */
export async function signedUp(): Promise<TestClient> {
  const client = makeClient();
  const res = await client.post('/v1/auth/sign-up/email', {
    email: client.email,
    password: PASSWORD,
    name: 'Integration Test',
  });
  if (!res.ok) throw new Error(`sign-up не прошёл: ${res.status} ${await res.text()}`);
  return client;
}

export interface WorkspaceOptions {
  /** Базовая валюта воркспейса. */
  readonly baseCurrency?: string;
  /** Сумма одной выплаты в minor units базовой валюты. */
  readonly payoutMinor?: string;
  /** Числа месяца, когда приходят деньги. */
  readonly days?: number[];
  /** Таймзона воркспейса: от неё зависит, какой день сервер считает сегодняшним (#109). */
  readonly timezone?: string;
}

/** Пользователь с воркспейсом и настроенным доходом — обычная точка старта сценария. */
export async function onboarded(options: WorkspaceOptions = {}): Promise<TestClient> {
  const client = await signedUp();
  const baseCurrency = options.baseCurrency ?? 'RUB';
  const days = options.days ?? [10, 25];

  await expectOk(
    await client.post('/v1/workspace', {
      baseCurrency,
      ...(options.timezone ? { timezone: options.timezone } : {}),
    }),
    201,
  );
  await expectOk(
    await client.post('/v1/onboarding/income', {
      rhythm: { kind: 'monthly-days', days },
      weekendRule: 'before',
      sources: [
        {
          label: 'Зарплата',
          currency: baseCurrency,
          schedule: { kind: 'monthly-days', days },
          amount: { kind: 'absolute', amountMinor: options.payoutMinor ?? '30000000' },
          stability: 'fixed',
        },
      ],
    }),
    201,
  );
  return client;
}

export async function getPlan(client: TestClient): Promise<PlanDto> {
  return expectOk<PlanDto>(await client.get('/v1/plan/current'));
}

export interface CategoryRow {
  id: string;
  name: string;
  protected: boolean;
  isSystem: boolean;
}

export async function listCategories(client: TestClient): Promise<CategoryRow[]> {
  return expectOk<CategoryRow[]>(await client.get('/v1/categories'));
}

/** Категория по имени — пресеты создаются онбордингом, id заранее неизвестен. */
export async function categoryId(client: TestClient, name: string): Promise<string> {
  const rows = await listCategories(client);
  const hit = rows.find((c) => c.name === name);
  if (!hit)
    throw new Error(`категория «${name}» не найдена; есть: ${rows.map((r) => r.name).join(', ')}`);
  return hit.id;
}

/*
 * Курсы в кэше `fx_rates`. FX-сервис читает только базу (сеть не трогает), поэтому валютные
 * сценарии должны сами положить котировку — иначе тест зависел бы от того, что кто-то до него
 * сходил в ЦБ.
 *
 * `fx_rates` — единственная таблица БЕЗ скоупа по воркспейсу: котировка ЦБ одна на продукт, и это
 * правильно. Цена этого — общее состояние между тестовыми файлами, поэтому два правила.
 *
 * **Первое: устойчивость держится на `fileParallelism: false`** (см. `vitest.config.ts`). Пару
 * EUR→RUB на «сегодня» сеют семь файлов с РАЗНЫМИ значениями (100 в `exchange`/`demo`/`plan-grid`,
 * 90 и 99 в `income-receipts`, 95.4321 в `settings`), а `seedRate` перезаписывает значение по
 * (source, base, quote, onDate). Сейчас это безопасно только потому, что каждый тест сеет курс
 * непосредственно перед своим действием и между посевом и проверкой никто не вмешивается. Включите
 * параллельность файлов — и валютные тесты начнут ронять друг друга значениями, а падать будет
 * случайный файл. Это не деталь конфигурации, а несущая конструкция.
 *
 * **Второе: `forgetRate` требует СВОЕЙ пары.** Он удаляет пару целиком — по любой дате и любому
 * источнику, включая чужие посевы, — и проверяет «курса нет», то есть любой посторонний посев той же
 * пары превращает проверку в ложное падение. Занятые пары:
 *
 *   | Пара      | Владелец                | Зачем эксклюзивно            |
 *   | RSD → RUB | receipts.test.ts        | «без курса чек отказывает»   |
 *   | KZT → RUB | plan-resilience.test.ts | «план без курса не врёт»     |
 *
 * Нужен сценарий «курса нет» — возьми свободную пару (KGS, TRY, GEL) и допиши сюда, а не
 * переиспользуй чужую или общие EUR/USD.
 *
 * Порядок файлов при этом НЕ алфавитный: Vitest сортирует их своим sequencer'ом, и он меняется между
 * прогонами, поэтому конфликт состояния проявляется «через прогон» и выглядит как флак CI (#141).
 */

/**
 * Убирает котировку из кэша — воспроизводит «источник переехал / кэш почистили». Тестовой ручки в
 * приложении для этого нет и быть не должно, поэтому работаем прямо с таблицей, как и `seedRate`.
 */
export async function forgetRate(base: string, quote: string): Promise<void> {
  await db
    .delete(fxRates)
    .where(and(eq(fxRates.base, base.toUpperCase()), eq(fxRates.quote, quote.toUpperCase())));
}

export async function seedRate(
  base: string,
  quote: string,
  rate: string,
  onDate: string,
  source = 'cbr',
): Promise<void> {
  await db
    .insert(fxRates)
    .values({ source, base, quote, onDate, rate })
    .onConflictDoUpdate({
      target: [fxRates.source, fxRates.base, fxRates.quote, fxRates.onDate],
      set: { rate },
    });
}

export { PASSWORD };
export type { PlanDto };
