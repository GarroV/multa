# 15. Прод-деплой на MUSPELHEIM (рудбук)

> Ручной документ. Единственное каноническое описание того, как Multa живёт в проде и как её туда доставить. Автоматизация деплоя — issue #14, HTTPS — issue #12.

## Что и где лежит

| Что             | Где                                | Примечание                                                                    |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| Код             | `C:\projects\multa` на MUSPELHEIM  | **Не git-репозиторий**: код доставляется архивом (см. ниже)                   |
| Секреты         | `C:\projects\multa\.env`           | Не в git; сгенерирован при первом деплое                                      |
| Данные Postgres | `C:\projects\multa\.data\postgres` | Bind-mount контейнера, переживает пересборку                                  |
| Скрипт деплоя   | `C:\projects\multa\deploy.cmd`     | `docker compose -f docker-compose.prod.yml up -d --build`, лог → `deploy.log` |
| Бэкапы          | `C:\backups\multa-postgres-1\`     | Задача «PG Docker Backup», 03:30 ежедневно, ретеншн 14 дней                   |

Контейнеры (`docker-compose.prod.yml`): `multa-postgres-1` (16-alpine, метка `backup.pgdump=true`), `multa-api-1` (порт 3000 только внутри сети), `multa-web-1` (Caddy, `0.0.0.0:80`).

Точка входа: **http://muspelheim.tail48dfee.ts.net** — по Tailscale, напрямую в порт 80 web-контейнера. `tailscale serve` **не настроен**, поэтому схема именно `http` (и `BETTER_AUTH_URL`/`WEB_ORIGIN` в `.env` тоже `http://...` — они обязаны совпадать с фактической схемой и хостом, иначе better-auth зарежет origin).

Маршрутизация внутри `multa-web-1` (`Caddyfile.prod`): `/v1/*` → `reverse_proxy api:3000`; `/assets/*` → файлы с `immutable` (и 404, если файла нет); остальное → SPA-fallback на `index.html` с `Cache-Control: no-cache`.

## Процедура деплоя

1. **Бэкап БД** (перед каждым деплоем, который трогает миграции):
   ```bash
   ssh muspelheim 'powershell -NoProfile -Command "docker exec multa-postgres-1 pg_dump -U multa -d multa | Out-File -Encoding utf8 C:\backups\multa-manual\multa_before_deploy.sql"'
   ```
2. **Доставить код.** Репозиторий приватный, а git на сервере в SSH-сессии не умеет авторизоваться (credential store `wincredman` требует интерактивной сессии). Пока доставка — архивом от нужного коммита:
   ```bash
   git archive --format=zip -o /tmp/multa-src.zip HEAD
   scp /tmp/multa-src.zip muspelheim:multa-src.zip
   ssh muspelheim 'powershell -NoProfile -Command "Expand-Archive -Path C:\Users\vasil\multa-src.zip -DestinationPath C:\projects\multa -Force"'
   ```
   Архив содержит только версионированные файлы, поэтому `.env` и `.data\` не затрагиваются. Минус способа: файлы, удалённые в новых коммитах, остаются лежать на диске — на сборку не влияет, но при переезде на git это исчезнет.
3. **Собрать и поднять:**

   ```bash
   ssh -o ServerAliveInterval=30 muspelheim 'C:\projects\multa\deploy.cmd'
   ```

   Миграции Drizzle применяются самим api при старте (он ждёт healthy-postgres): в логах видно `[api] миграции применены (migrations)`, и только после этого поднимается сервер. Первые строки логов api могут содержать `the database system is starting up` — это нормальный retry, не ошибка.

   Готовность api видна по healthcheck: `docker ps` показывает `health: starting` пока идут миграции и `healthy` после. `multa-web-1` ждёт именно healthy-api, поэтому первый заход не отдаёт 502.

### Что внутри прод-образа api

Образ двухстейджевый (`apps/api/Dockerfile`): в сборочном стейдже ставится весь монорепо и собирается бандл (`node build.mjs` → `dist/server.js`, `dist/migrate.js`), в рантайм уезжают только `dist/`, SQL-миграции и прод-зависимости (`pnpm deploy --prod --legacy`). В рантайме нет ни devDependencies, ни `tsx`, ни `drizzle-kit`, ни исходников; процесс работает под пользователем `node`.

Внутрь бандла вбираются только наши workspace-пакеты (`@multa/core`, `@multa/i18n`). Полный бандлинг зависимостей не годится: `pg` — CJS и падает в ESM-бандле как `Dynamic require of "events" is not supported`.

Миграции накатывает `dist/migrate.js` (тот же `drizzle-orm`-мигратор, что в интеграционных тестах), а не `drizzle-kit` — сборочный инструмент в прод-образе не нужен. Генерация новых миграций осталась локальной: `pnpm --filter @multa/api db:generate`.

## Смоук после деплоя (обязательный)

```bash
curl -s http://muspelheim.tail48dfee.ts.net/v1/health                    # {"ok":true,...}
curl -sI http://muspelheim.tail48dfee.ts.net/ | grep -i cache-control     # no-cache
curl -s http://muspelheim.tail48dfee.ts.net/ | grep -o '/assets/[^"]*js'  # имя бандла = локальной сборке
```

Затем — **обязательно в браузере**, не только curl: открыть страницу и убедиться, что рендерится экран входа и в консоли нет ошибок. Оба прод-бага, найденных 2026-07-29, curl-ом не ловились: сервер отдавал корректный HTML, а падало исполнение JS в браузере.

## Грабли

- **Проброс портов Docker Desktop залипает после рестарта WSL.** Симптом: TCP-соединение устанавливается, но сервер сразу закрывает его («Empty reply from server») — и снаружи, и с самого сервера через `localhost`; при этом `docker exec <web> wget http://localhost/` внутри контейнера отвечает 200. Причина: `com.docker.backend` держит слушателя на `0.0.0.0:80`, но форвардинг в пересозданный контейнер не восстановился. Лечение: `docker restart multa-web-1`. Проверять после любого рестарта WSL/Docker.
- **`VITE_API_URL` в проде пустой** (`apps/web/Dockerfile`) — фронт и api за одним Caddy. Пустое значение обязано оставаться валидным: better-auth падает на относительном `baseURL`, поэтому клиент собирается через `authClientOptions()` (`apps/web/src/lib/`), а не прямой подстановкой.
- **`index.html` нельзя кэшировать.** Иначе после деплоя браузер грузит старый html со ссылкой на исчезнувший бандл и показывает белый экран. Заголовки заданы в `Caddyfile.prod`; при отладке проверяй, какой бандл реально исполнился (`document.scripts`), а не какой отдаёт сервер.
- **`-e` в docker-командах через ssh → powershell превращается в «Access is denied».** PowerShell забирает `-e` себе как сокращение `-EncodedCommand` (кавычки съедаются слоями), и вместо контейнера получается попытка декодировать мусор. Писать `--env KEY=value` полностью. Там же: `docker run -d` из SSH-сессии капризничает — надёжнее `docker create ... ; docker start <name>`.
- **Квотинг через ssh → cmd/powershell.** Кавычки в SQL и `-N ""` у `ssh-keygen` съедаются слоями. Надёжный путь для SQL — stdin: `ssh muspelheim 'docker exec -i multa-postgres-1 psql -U multa -d multa' < script.sql`. Для остального — `powershell -NoProfile -Command "..."` и минимум вложенных кавычек.
- **Долгие процессы из SSH умирают вместе с сессией** (см. CLAUDE.md по MUSPELHEIM). Сборку держать в живой сессии (`ServerAliveInterval`) или запускать одноразовой `schtasks`-задачей.
- **Бэкап-задача сервера ругается на `supabase-meta`/`supabase-rest`** («2 failed» в отчёте) — это чужие контейнеры с меткой `backup.pgdump`, к Multa отношения не имеют. `multa-postgres-1` дампится штатно.
