import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import { rateLimit, resetRateLimits } from '../src/http/rateLimit.ts';

/**
 * Ограничение частоты (публичный доступ, решение владельца 2026-08-02).
 *
 * Проверяется не «лимит существует», а то, из-за чего он был переписан: **разные люди не должны
 * делить одну квоту**. За Tailscale адрес клиента до приложения не доходит — первая версия писала
 * в лог ключ `172.21.0.1` и считала всех одним человеком, то есть первый упершийся в лимит запирал
 * бы остальных.
 *
 * Middleware проверяется напрямую, а не через `app`: в тестовом окружении он намеренно выключен,
 * иначе интеграционные сценарии упирались бы в него, проверяя не то.
 */

/** Приложение из одного middleware: проверяем лимитер, а не то, что за ним. */
const probe = new Hono();
probe.use('/v1/*', rateLimit);
probe.all('/v1/*', (c) => c.json({ ok: true }));

const call = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  probe.request(`http://localhost${path}`, { method: 'POST', headers });

/** Метка клиента из ответа: ею он и отличается от других (см. `clientOf`). */
function markerOf(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('multa_c='));
  return raw ? raw.split(';')[0]! : '';
}

describe('ограничение частоты', () => {
  beforeEach(() => resetRateLimits());

  test('перебор регистрации упирается в лимит и получает Retry-After', async () => {
    const first = await call('/v1/auth/sign-up/email');
    const cookie = markerOf(first);
    expect(cookie).not.toBe('');

    let last = first;
    // Правило: 10 в час одному клиенту. Одиннадцатый обязан быть отклонён.
    for (let i = 0; i < 12; i += 1) last = await call('/v1/auth/sign-up/email', { cookie });

    expect(last.status).toBe(429);
    expect(await last.json()).toMatchObject({ error: 'rate_limited' });
    expect(Number(last.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  test('разные люди не делят квоту', async () => {
    /*
     * Ровно та причина, по которой лимитер переписан. Первый клиент выбирает свой лимит целиком,
     * второй обязан работать как ни в чём не бывало.
     */
    const alice = markerOf(await call('/v1/auth/sign-up/email'));
    for (let i = 0; i < 12; i += 1) await call('/v1/auth/sign-up/email', { cookie: alice });
    expect((await call('/v1/auth/sign-up/email', { cookie: alice })).status).toBe(429);

    const bob = markerOf(await call('/v1/auth/sign-up/email'));
    expect(bob).not.toBe(alice);
    expect((await call('/v1/auth/sign-up/email', { cookie: bob })).status).toBe(200);
  });

  test('общий потолок держит того, кто сбрасывает метку', async () => {
    /*
     * Метка живёт в cookie, и сбросить её — один клик. Персональный лимит такого не держит,
     * держит общий потолок правила: 60 регистраций в час на всех.
     */
    let blocked = false;
    for (let i = 0; i < 70; i += 1) {
      // Каждый раз без cookie: сервер видит нового клиента.
      const res = await call('/v1/auth/sign-up/email');
      if (res.status === 429) {
        blocked = true;
        break;
      }
    }
    expect(blocked).toBe(true);
  });

  test('настоящий адрес важнее метки, когда он доходит', async () => {
    // Если однажды появится обычный обратный прокси, ключ станет точным сам собой.
    for (let i = 0; i < 12; i += 1)
      await call('/v1/auth/sign-up/email', { 'x-forwarded-for': '203.0.113.7' });
    expect(
      (await call('/v1/auth/sign-up/email', { 'x-forwarded-for': '203.0.113.7' })).status,
    ).toBe(429);
    // Другой адрес — своя квота.
    expect(
      (await call('/v1/auth/sign-up/email', { 'x-forwarded-for': '203.0.113.8' })).status,
    ).toBe(200);
  });

  test('адрес нашего же прокси за адрес клиента не принимается', async () => {
    /*
     * Caddy за Tailscale подставляет docker-шлюз. Принять его за клиента значит вернуться ровно к
     * той ошибке, из-за которой всё переписано.
     */
    const a = await call('/v1/auth/sign-up/email', { 'x-forwarded-for': '172.21.0.1' });
    const b = await call('/v1/auth/sign-up/email', { 'x-forwarded-for': '172.21.0.1' });
    // Обоим выдана своя метка — значит их не склеили в один ключ.
    expect(markerOf(a)).not.toBe('');
    expect(markerOf(b)).not.toBe('');
    expect(markerOf(a)).not.toBe(markerOf(b));
  });

  test('здоровье не считается: его дёргает докер каждые несколько секунд', async () => {
    for (let i = 0; i < 300; i += 1) {
      const res = await call('/v1/health');
      expect(res.status).toBe(200);
    }
  });
});
