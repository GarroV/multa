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
  plugins: [twoFactor()],
  // $0/приватность: не отправляем телеметрию.
  telemetry: { enabled: false },
});

export type Session = typeof auth.$Infer.Session;
