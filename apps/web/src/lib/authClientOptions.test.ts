import { createAuthClient } from 'better-auth/react';
import { describe, expect, it } from 'vitest';
import { AUTH_BASE_PATH, authClientOptions } from './authClientOptions.ts';

/** Перехватывает URL, по которому клиент реально стучится. */
function clientWithSpy(apiUrl: string | undefined) {
  const calls: string[] = [];
  const options = authClientOptions(apiUrl);
  const client = createAuthClient({
    ...options,
    fetchOptions: {
      ...options.fetchOptions,
      customFetchImpl: async (url) => {
        calls.push(String(url));
        return new Response('null', { headers: { 'content-type': 'application/json' } });
      },
    },
  });
  return { client, calls };
}

describe('authClientOptions', () => {
  it('в деве отдаёт абсолютный baseURL из VITE_API_URL', () => {
    const options = authClientOptions('http://localhost:3000');

    expect(options.baseURL).toBe('http://localhost:3000');
    expect(options.basePath).toBe(AUTH_BASE_PATH);
  });

  it('в прод-сборке (VITE_API_URL пуст) baseURL не задаёт — его подставит origin страницы', () => {
    expect(authClientOptions('')).not.toHaveProperty('baseURL');
    expect(authClientOptions(undefined)).not.toHaveProperty('baseURL');
    expect(authClientOptions('   ')).not.toHaveProperty('baseURL');
  });

  it('всегда просит credentials: сессия живёт в httpOnly-cookie', () => {
    expect(authClientOptions('').fetchOptions.credentials).toBe('include');
  });
});

describe('createAuthClient с этими опциями', () => {
  it('в прод-сборке бьёт в origin страницы, а не падает на относительном пути', async () => {
    // Регрессия: baseURL '/v1/auth' валил модуль на старте — BetterAuthError: Invalid base URL,
    // из-за чего прод отдавал белый экран (см. issue про белый экран прода).
    const { client, calls } = clientWithSpy('');

    await client.getSession();

    expect(calls[0]).toBe('http://multa.example.test/v1/auth/get-session');
  });

  it('в деве бьёт в API на отдельном порту', async () => {
    const { client, calls } = clientWithSpy('http://localhost:3000');

    await client.getSession();

    expect(calls[0]).toBe('http://localhost:3000/v1/auth/get-session');
  });

  it('относительный baseURL (как было до фикса) клиент не принимает', () => {
    expect(() => createAuthClient({ baseURL: AUTH_BASE_PATH })).toThrow(/Invalid base URL/);
  });
});
