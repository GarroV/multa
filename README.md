# Multa

Мультивалютный планировщик личного бюджета для тех, кто живёт между валютами: доход в одной, жизнь в другой, накопления в третьей. Планируешь крупными мазками по периодам выплат — система распределяет выплату каскадом, охраняет от перерасхода и учится на твоих решениях.

Не трекер трат — **распределитель дохода**. Главная ценность: «цифра дня» (сколько можно тратить до следующей выплаты) и планировщик размена валют.

Визуальный эталон — исполняемый макет `design/prototype.html` (обновлён 31.07.2026): пять поверхностей, тёмная и светлая темы, ru/en. Словарь токенов — `docs/06-design-system.md`.

## Статус

Ранняя разработка, **dogfooding-first**: первый пользователь — основатель. Работаем по спринтам из `docs/07-roadmap.md`. Спринты 1–5 (фундамент, план и каскад, факт и размен, сигналы и пересборка, чеки и AI) сделаны; сейчас: **Спринт 6 — новый интерфейс по прототипу, демо-доступ и полировка**.

Прод крутится на домашнем сервере MUSPELHEIM: http://muspelheim.tail48dfee.ts.net (доступ по Tailscale). Как деплоить и что проверять после — `docs/15-deploy-prod.md`.

## Стек

pnpm + Turborepo монорепо. Всё self-hosted, профиль **$0 + один ключ OpenAI** (см. `docs/03-architecture.md`).

- `apps/web` — Vite + React + TypeScript + TanStack Router/Query + Tailwind
- `apps/api` — Node 22 + Hono + Drizzle + better-auth
- `apps/bot` — grammY, long polling (фаза 2)
- `packages/core` — чистое доменное ядро (money, periods, cascade, fx, forecast, parser), без зависимостей
- `packages/i18n` — словари ru/en, типобезопасные ключи
- Postgres 16 + Caddy — через `docker-compose`

## Разработка

```bash
pnpm install
docker compose up -d        # postgres + api + caddy
pnpm dev                    # web + api
pnpm typecheck
pnpm test                   # юниты ядра/api/web + интеграционные тесты api
```

Требуется: Node ≥ 22, pnpm 11, Docker (OrbStack на macOS).

Интеграционные тесты api ходят в настоящий Postgres — перед первым прогоном нужна пустая база
`multa_test` (миграции накатятся сами):

```bash
createdb -O multa multa_test          # один раз; адрес можно задать через TEST_DATABASE_URL
pnpm --filter @multa/api test
```

Смоук прод-сборки web (ловит падения на уровне модуля, которых не видно на исходниках):

```bash
pnpm --filter @multa/web build
pnpm --filter @multa/web test:bundle
```

Подробнее об уровнях тестов — `docs/03-architecture.md` §Тестовый контур.

## Документация

Вся правда — в `docs/`. Порядок чтения: `00-vision` → `01-domain-model` → `02-data-schema` → `03-architecture` → `04-web-ux` → `06-design-system` → `07-roadmap`. Правила и грабли — в `CLAUDE.md`.

## Железные правила

- Деньги — только integer minor units (`packages/core/money.ts`). Float в деньгах = баг.
- Курс — иммутабельный снапшот в транзакции. История не пересчитывается.
- Каскад: долги → корзины → конверты → категории → цели; сжатие в обратном порядке; долги неприкосновенны.
- Доменная логика — только в `packages/core` и `apps/api`, не в компонентах.
- Строки UI — через i18n-ключи (ru+en). Цвета — только семантические CSS-переменные.
- Изоляция workspace — в API-middleware; клиент не ходит в БД напрямую.
