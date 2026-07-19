# Multa web — сборка статики + Caddy (статика + reverse-proxy /v1). Контекст = корень монорепо.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Пусто = относительные пути → фронт бьёт в тот же origin, /v1 проксирует Caddy.
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @multa/web build

FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY Caddyfile.prod /etc/caddy/Caddyfile
