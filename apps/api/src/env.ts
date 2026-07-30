import { existsSync } from 'node:fs';
import { z } from 'zod';

// Node 22: грузим .env из CWD (apps/api), если переменные ещё не заданы.
if (!process.env.DATABASE_URL && existsSync('.env')) {
  process.loadEnvFile('.env');
}

const schema = z.object({
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(16, 'BETTER_AUTH_SECRET обязателен (openssl rand -base64 32)'),
  BETTER_AUTH_URL: z.string().url().default('http://localhost:3000'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  // Единственный платный ключ в продукте (CLAUDE.md): vision-фоллбэк чеков и позже Whisper.
  // Не обязателен: без него QR-путь работает, а нераспознанный чек уходит в «Общее».
  OPENAI_API_KEY: z.string().min(20).optional(),
});

export const env = schema.parse(process.env);
