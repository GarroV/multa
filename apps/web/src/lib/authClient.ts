import { createAuthClient } from 'better-auth/react';
import { twoFactorClient } from 'better-auth/client/plugins';
import { API_ORIGIN } from './apiUrl.ts';
import { authClientOptions } from './authClientOptions.ts';

/**
 * Клиент better-auth. Резолв baseURL/basePath — в authClientOptions (там же почему).
 *
 * Плагин twoFactor нужен и для включения 2FA в настройках, и для шага проверки при входе (issue
 * #19). Колбэк `onTwoFactorRedirect` не задаём: экран входа сам показывает поле кода по флагу
 * `twoFactorRedirect` в ответе, а редирект в SPA увёл бы человека с формы, где он уже стоит.
 */
export const authClient = createAuthClient({
  ...authClientOptions(API_ORIGIN),
  plugins: [twoFactorClient()],
});
