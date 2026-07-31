# syntax=docker/dockerfile:1
# Multa API — прод-образ. Контекст сборки = корень монорепо.
#
# Два стейджа: в первом ставится весь монорепо и собирается бандл, во второй уезжают только
# `dist/`, SQL-миграции и прод-зависимости. Так в рантайме нет ни devDependencies, ни
# компиляции на старте, ни исходников.

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# Бандл сервера и наката миграций. Внутрь вбираются только workspace-пакеты (@multa/*);
# npm-зависимости остаются внешними — pg и better-auth не переживают полный бандлинг в ESM
# (CJS-require внутри pg падает как «Dynamic require of "events" is not supported»).
RUN cd apps/api && node build.mjs

# Изолированный прод-набор зависимостей: без devDependencies и без симлинков на воркспейс.
# `--legacy`, потому что с pnpm 10 обычный deploy требует inject-workspace-packages.
RUN pnpm deploy --filter @multa/api --prod --legacy /deploy

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/migrations ./migrations
COPY --from=build /app/apps/api/package.json ./package.json

# Непривилегированный пользователь: образ ничего не пишет в файловую систему, права root не нужны.
USER node
EXPOSE 3000

# Живость проверяет сам образ — compose и `docker ps` показывают состояние без внешних утилит.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Миграции при старте (postgres уже healthy по depends_on), затем сервер как PID 1 —
# через exec, чтобы SIGTERM доходил до Node, а не оставался в шелле.
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/server.js"]
