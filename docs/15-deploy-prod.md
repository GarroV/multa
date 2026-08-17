# 15. Прод-деплой на MUSPELHEIM (рудбук)

> Ручной документ. Единственное каноническое описание того, как Multa живёт в проде и как её туда доставить. Автоматизация деплоя — issue #14.

## Что и где лежит

| Что             | Где                                | Примечание                                                                    |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| Код             | `C:\projects\multa` на MUSPELHEIM  | **Не git-репозиторий**: код доставляется архивом (см. ниже)                   |
| Секреты         | `C:\projects\multa\.env`           | Не в git; сгенерирован при первом деплое                                      |
| Данные Postgres | `C:\projects\multa\.data\postgres` | Bind-mount контейнера, переживает пересборку                                  |
| Скрипт деплоя   | `C:\projects\multa\deploy.cmd`     | `docker compose -f docker-compose.prod.yml up -d --build`, лог → `deploy.log` |
| Бэкапы          | `C:\backups\multa-postgres-1\`     | Задача «PG Docker Backup», 03:30 ежедневно, ретеншн 14 дней                   |

Контейнеры (`docker-compose.prod.yml`): `multa-postgres-1` (16-alpine, метка `backup.pgdump=true`), `multa-api-1` (порт 3000 только внутри сети), `multa-web-1` (Caddy, `0.0.0.0:80`).

Точка входа: **https://muspelheim.tail48dfee.ts.net** — **публичный адрес в интернете** (решение владельца 2026-08-02: продукт нужно давать знакомым на тест). Терминацию TLS делает сам Tailscale, внешнего домена и платного сертификата нет — профиль нулевой стоимости сохранён.

Раньше тот же адрес жил только внутри tailnet (`tailscale serve`). Теперь включён Funnel:

```bash
ssh muspelheim 'powershell -NoProfile -Command "tailscale funnel --bg --https=443 http://localhost:80"'
# проверка: tailscale funnel status → «Funnel on»
# выключить: tailscale funnel --https=443 off
```

**Проверять доступность нужно снаружи тайлнета.** С машины, входящей в tailnet, адрес отвечает и без Funnel — то есть локальный `curl` ничего не доказывает. Годится любой сторонний ретранслятор, например `curl "https://r.jina.ai/https://muspelheim.tail48dfee.ts.net/v1/health"`.

`BETTER_AUTH_URL` и `WEB_ORIGIN` в `.env` обязаны совпадать с фактической схемой и хостом (`https://muspelheim.tail48dfee.ts.net`): иначе better-auth зарежет origin. Именно https включает `Secure`-куку сессии (`__Secure-better-auth.session_token`) — по http браузер её просто не сохранит.

Порт 80 остаётся открытым в tailnet и продолжает отвечать: это запасной вход, если туннель слетит. Он же — источник рассинхрона: при заходе по http кука будет с другим именем и логин не переживёт переход на https, поэтому в закладках держим https-адрес.

**Включение HTTPS с нуля** (нужно один раз на тайлнет; повторять при переезде на другую машину):

1. В админке тайлнета включить HTTPS-сертификаты: <https://login.tailscale.com/admin/dns> → «HTTPS Certificates» → Enable. Без этого `tailscale serve` падает с «HTTPS is not enabled in the admin panel».
2. `ssh muspelheim 'tailscale serve --bg --https=443 http://localhost:80'` — конфиг переживает перезагрузку, проверяется через `tailscale serve status`.
3. Переписать в `C:\projects\multa\.env` обе переменные на `https://…` и перезапустить api (`docker compose -f docker-compose.prod.yml up -d`). Перезапуск обязателен: origin читается при старте процесса.

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
curl -s https://muspelheim.tail48dfee.ts.net/v1/health                    # {"ok":true,...}
curl -sI https://muspelheim.tail48dfee.ts.net/ | grep -i cache-control     # no-cache
curl -s https://muspelheim.tail48dfee.ts.net/ | grep -o '/assets/[^"]*js'  # имя бандла = локальной сборке
# origin принят и кука Secure — иначе логин не сохранится:
curl -s -i -X POST https://muspelheim.tail48dfee.ts.net/v1/demo/enter \
  -H 'content-type: application/json' -H 'origin: https://muspelheim.tail48dfee.ts.net' \
  -d '{}' | grep -i 'set-cookie\|allow-origin'
```

### Если деплой трогал миграции — дёрнуть НОВУЮ ручку, а не только health

`{"ok":true}` и строка `[api] миграции применены` НЕ доказывают, что миграция накатилась. Проверено
на себе 16.08.2026: миграция `0022_edit_proposals` была в образе, запись о ней — в журнале, лог
чистый, деплой зелёный, а таблицы в базе нет.

Причина: drizzle применяет миграцию, только если её метка `when` больше времени последней
применённой записи. Рукописные миграции проставили себе метки на день-два вперёд, `drizzle-kit`
выдал новой настоящее время — и оно оказалось МЕНЬШЕ. Миграция пропускается **молча**, без ошибки.

Поэтому после деплоя с миграцией:

```bash
# 1. Живой запрос к ручке, которую добавили (401 без входа НЕ считается — он отдаётся
#    до обращения к таблице; нужен ответ с данными):
curl -s -X POST $URL/v1/demo/enter -c /tmp/j -b /tmp/j >/dev/null
curl -s -b /tmp/j $URL/v1/proposals      # {"proposals":[]} — таблица есть
# 2. Сверка счётчика применённых с журналом:
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U multa -d multa -t -c 'select count(*) from drizzle.__drizzle_migrations;'
```

Числа должны совпадать с числом записей в `migrations/meta/_journal.json`. Локально то же ловит
`apps/api/test/migrations-journal.test.ts`: метки обязаны идти строго по возрастанию.

### Перезапускать только прод-файлом

`docker compose up -d --build api` без `-f docker-compose.prod.yml` подхватывает файл по умолчанию —
другой конфиг с тем же именем контейнера. Внешне всё поднимается, но это не прод-сборка. Ошибка
дорогая тем, что не выглядит ошибкой: контейнер `multa-api-1` жив и отвечает.

Затем — **обязательно в браузере**, не только curl: открыть страницу и убедиться, что рендерится экран входа и в консоли нет ошибок. Оба прод-бага, найденных 2026-07-29, curl-ом не ловились: сервер отдавал корректный HTML, а падало исполнение JS в браузере.

## Что защищает публичный адрес

Регистрация открыта намеренно (продуктом пользуются владелец и его знакомые), поэтому защита —
не в закрытой двери, а в ограничениях:

- **Ограничение частоты** на весь `/v1` (`apps/api/src/http/rateLimit.ts`). Строже там, где запрос
  дорогой: регистрация 10/час на клиента и 60/час на всех, пересев демо 5 и 20, фото чека и
  голос 30 и 120 — эти два уходят в платный OpenAI.
- **Лимитер не вмешивается в ответы `/v1/auth/*`.** better-auth возвращает свой объект Response со
  своими `Set-Cookie`, и кука клиента, поставленная нами на контекст Hono, его заголовок вытесняла:
  регистрация отвечала 200, сессионной куки в ответе не оказывалось, следующий запрос получал 401.
  В браузере это не проявлялось (интерфейс дёргает `/v1/me` при загрузке и получает метку там),
  поэтому поймано только смоуком на живом api. Клиент без метки на этих путях попадает в общую
  корзину — грубее, но безопаснее.
- **Клиент определяется не по IP.** За Tailscale адрес клиента до приложения не доходит: туннель
  проксирует на localhost, и Caddy видит docker-шлюз. Первая версия лимитера писала в лог ключ
  `172.21.0.1`, то есть считала всех одним человеком. Теперь порядок такой: `x-forwarded-for` (если
  однажды появится настоящий обратный прокси) → личность tailnet (`tailscale-user-login`, есть у
  своих устройств) → собственная метка в cookie. Метка сбрасывается в один клик, поэтому от
  злоупотребления держит не она, а общий потолок правила.
- **Встроенный лимитер better-auth выключен** (`rateLimit: { enabled: false }` в `auth.ts`): он
  ключуется по IP и на этой площадке страдал ровно тем же — одна корзина на весь интернет.
- **`POST /v1/demo/reset` требует сессию демо.** Раньше не требовал ничего, а один запрос
  переписывает всю демо-базу.
- **Сброс демо ограничен пятью в час — и молчаливый `429` похож на успешный смоук.** Ловушка не
  продукта, а того, кто проверяет: если гасить ответ (`curl ... >/dev/null`), шестой сброс за час
  вернёт `429`, демо останется с прежними данными, и сверка «что в демо» покажет наведённый мусор
  как штатное состояние. Проверять код ответа сброса, а не только то, что команда не упала:

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL/v1/demo/reset -b /tmp/j   # ждём 200
  ```

  Лимит осмысленный (один запрос переписывает всю демо-базу), снимать его не надо — надо смотреть на
  ответ.

- **Заголовки** (`Caddyfile.prod`): HSTS на год без preload, `X-Frame-Options: DENY`,
  `Permissions-Policy` без камеры и микрофона, CSP под фактическую сборку.

Чего пока нет и о чём стоит помнить, отдавая ссылку людям: правового раздела (docs/10-legal не
делался) и самовосстановления машины после холодного ребута (issue #13) — в этот момент ссылка
просто не отвечает.

## Грабли

- **Проброс портов Docker Desktop залипает после рестарта WSL.** Симптом: TCP-соединение устанавливается, но сервер сразу закрывает его («Empty reply from server») — и снаружи, и с самого сервера через `localhost`; при этом `docker exec <web> wget http://localhost/` внутри контейнера отвечает 200. Причина: `com.docker.backend` держит слушателя на `0.0.0.0:80`, но форвардинг в пересозданный контейнер не восстановился. Лечение: `docker restart multa-web-1`. Проверять после любого рестарта WSL/Docker.
- **`VITE_API_URL` в проде пустой** (`apps/web/Dockerfile`) — фронт и api за одним Caddy. Пустое значение обязано оставаться валидным: better-auth падает на относительном `baseURL`, поэтому клиент собирается через `authClientOptions()` (`apps/web/src/lib/`), а не прямой подстановкой.
- **`index.html` нельзя кэшировать.** Иначе после деплоя браузер грузит старый html со ссылкой на исчезнувший бандл и показывает белый экран. Заголовки заданы в `Caddyfile.prod`; при отладке проверяй, какой бандл реально исполнился (`document.scripts`), а не какой отдаёт сервер.
- **`-e` в docker-командах через ssh → powershell превращается в «Access is denied».** PowerShell забирает `-e` себе как сокращение `-EncodedCommand` (кавычки съедаются слоями), и вместо контейнера получается попытка декодировать мусор. Писать `--env KEY=value` полностью. Там же: `docker run -d` из SSH-сессии капризничает — надёжнее `docker create ... ; docker start <name>`.
- **Квотинг через ssh → cmd/powershell.** Кавычки в SQL и `-N ""` у `ssh-keygen` съедаются слоями. Надёжный путь для SQL — stdin: `ssh muspelheim 'docker exec -i multa-postgres-1 psql -U multa -d multa' < script.sql`. Для остального — `powershell -NoProfile -Command "..."` и минимум вложенных кавычек.
- **Долгие процессы из SSH умирают вместе с сессией** (см. CLAUDE.md по MUSPELHEIM). Сборку держать в живой сессии (`ServerAliveInterval`) или запускать одноразовой `schtasks`-задачей.
- **Бэкап-задача сервера ругается на `supabase-meta`/`supabase-rest`** («2 failed» в отчёте) — это чужие контейнеры с меткой `backup.pgdump`, к Multa отношения не имеют. `multa-postgres-1` дампится штатно.
