# Multa API — прод-образ. Контекст сборки = корень монорепо.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
WORKDIR /app/apps/api
ENV NODE_ENV=production
# Миграции при старте (postgres уже healthy по depends_on), затем сервер.
CMD ["sh", "-c", "pnpm exec drizzle-kit migrate && pnpm start"]
