/** Кастомный mount better-auth на сервере (apps/api/src/auth.ts → basePath). */
export const AUTH_BASE_PATH = '/v1/auth';

export interface AuthClientOptions {
  readonly baseURL?: string;
  readonly basePath: string;
  readonly fetchOptions: { readonly credentials: RequestCredentials };
}

/**
 * Опции better-auth-клиента по origin API.
 *
 * better-auth валидирует baseURL через `new URL()` и падает на относительном пути
 * (`BetterAuthError: Invalid base URL`) — причём на этапе импорта модуля, то есть весь
 * SPA превращается в белый экран. В прод-сборке VITE_API_URL пуст (фронт и api за одним
 * Caddy), поэтому baseURL не задаём вовсе: клиент сам возьмёт origin страницы и приклеит
 * basePath. Абсолютный baseURL нужен только в деве, где Vite и api на разных портах.
 */
export function authClientOptions(apiUrl: string | undefined): AuthClientOptions {
  const origin = apiUrl?.trim() ?? '';
  return {
    ...(origin ? { baseURL: origin } : {}),
    basePath: AUTH_BASE_PATH,
    fetchOptions: { credentials: 'include' },
  };
}
