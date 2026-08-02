import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor } from 'better-auth/plugins';
import { db } from './db/client.ts';
import { env } from './env.ts';

/**
 * Auth = email + password + TOTP (twoFactor). Без email-провайдера/magic-link/Google
 * (профиль $0, dogfooding). Telegram Login — в фазе бота. Секрет — из env.
 */
export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/v1/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.WEB_ORIGIN],
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  /*
   * Встроенное ограничение частоты выключено намеренно (публичный доступ, 2026-08-02). Оно
   * ключуется по IP, а за Tailscale адрес клиента до приложения не доходит: туннель проксирует на
   * localhost, и все посетители выглядят как docker-шлюз. В таком виде правило better-auth «три
   * входа за десять секунд» становится общим на весь интернет — два человека, входящие
   * одновременно, мешают друг другу.
   *
   * Частоту держит наш `apps/api/src/http/rateLimit.ts`: он умеет отличать клиентов не только по
   * адресу и, кроме персонального лимита, имеет общий потолок правила.
   */
  rateLimit: { enabled: false },
  plugins: [twoFactor()],
  // $0/приватность: не отправляем телеметрию.
  telemetry: { enabled: false },
});

export type Session = typeof auth.$Infer.Session;
