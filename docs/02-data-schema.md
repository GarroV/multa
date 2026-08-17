# Multa — Схема данных (self-hosted Postgres 16)

> Self-hosted Postgres в docker-compose, без BaaS — решение от 19.07.2026 (см. CLAUDE.md §Стек).
> Упоминание Supabase в заголовке было следом отменённого варианта.
>
> **Что уже существует, а что запланировано.** Разделы до «Billing» описывают работающую схему —
> её можно сверить с `apps/api/src/db/schema/`. Разделы «Billing», «Админка» и «Правовое» — план
> следующих фаз: этих таблиц в базе НЕТ (см. CLAUDE.md §Режим: dogfooding-first).

Правила: деньги — `bigint` minor units; курсы — `numeric(20,10)`; валюты — `char(3)` ISO 4217; изоляция workspace — в API-middleware (RLS опционально как вторая линия). Все таблицы: `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at`. Таблицы пользователей/сессий создает better-auth (users, sessions, accounts...).

```sql
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null references "user"(id) on delete cascade, -- better-auth: user.id text (не uuid)
  base_currency char(3) not null default 'RUB',
  timezone text not null default 'Europe/Belgrade',
  locale text not null default 'ru',
  period_anchors jsonb,           -- ритм планирования: PeriodConfig (@multa/core), задаёт ГРАНИЦЫ периодов
  payday_weekend_rule text not null default 'before'
    check (payday_weekend_rule in ('as-is','before','after')),  -- перенос выплаты с выходного; влияет на границы
  onboarding_skipped boolean not null default false,            -- «пропустить настройку»: в приложение с пустым планом
  settings jsonb,                   -- настройки поведения (#49): буфер темпа, порядок сжатия, горизонт медианы; форма — в zod-схеме
  onboarding_completed_at timestamptz,  -- момент первого завершения; НЕ перезаписывается, иначе это не воронка
  last_active_on date,              -- последняя активность: пишется при чтении плана, не чаще раза в сутки
  created_at timestamptz not null default now()
);
-- Ожидаемый доход периода здесь НЕ живёт: он считается по income_sources и хранится в pay_periods.

create table income_sources (      -- только деньги: сколько и когда приходит (правило «ритм ≠ деньги»)
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  label text not null,             -- «Аванс», «Зарплата», «Подработка»
  currency char(3) not null,       -- фриланс в USD — не обязательно базовая
  schedule jsonb not null,         -- IncomeSchedule: monthly-days | every-weeks | daily | weekly | one-off | irregular
  amount jsonb not null,           -- IncomeAmount: absolute{amountMinor} | percent{percent, ofMinor}; суммы — строки-целые
  stability text not null default 'fixed' check (stability in ('fixed','variable')),
  active boolean not null default true,
  starts_on date,                  -- источник появился (новая работа)
  ends_on date,                    -- источник кончился (уволился) — это знает прогноз
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index income_sources_ws_idx on income_sources (workspace_id, sort);

create table income_receipts (     -- подтверждённые поступления: факт важнее плана
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  source_id uuid not null references income_sources on delete cascade,
  occurred_on date not null,       -- фактическая дата: зарплату могли выдать раньше плановой
  amount_minor bigint not null,    -- сколько пришло в валюте прихода
  currency char(3) not null,
  base_amount_minor bigint not null,
  rate numeric(20,10) not null,    -- иммутабельный снапшот (правило 2): позже не пересчитывается
  rate_source text not null,       -- 'manual' — курс дня выплаты, введённый руками
  rate_date date not null,
  note text,
  created_at timestamptz not null default now(),
  unique (workspace_id, source_id, occurred_on)  -- одно подтверждение на выплату
);
create index income_receipts_ws_day_idx on income_receipts (workspace_id, occurred_on);

create table workspace_members (   -- закладка под семейный режим (v2); в MVP только owner
  workspace_id uuid not null references workspaces on delete cascade,
  user_id uuid not null references users(id),
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
-- транзакции уже несут авторство: add column created_by uuid references users(id)

create table accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name text not null,
  currency char(3) not null,
  kind text not null check (kind in ('cash','card','savings','other')),
  balance_minor bigint not null default 0,
  archived boolean not null default false
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  parent_id uuid references categories on delete set null, -- 2 уровня max (проверка в API)
  name text not null,
  icon text,
  is_system boolean not null default false, -- 'Общее'
  protected boolean not null default false, -- не предлагается в автопересборке (пример: Ребенок)
  sort int not null default 0,
  archived boolean not null default false
);

create table pay_periods (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  starts_on date not null,
  ends_on date not null,
  expected_income_minor bigint not null default 0, -- в базовой валюте
  status text not null default 'planned' check (status in ('planned','active','closed')),
  unique (workspace_id, starts_on)
);

create table debts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name text not null,                -- 'Озон', 'Сбер', 'Долг Мише'
  currency char(3) not null,
  principal_minor bigint not null,   -- исходная сумма
  remaining_minor bigint not null,
  payment_minor bigint not null,     -- платеж за период
  due_date date,                     -- расчетная дата закрытия
  amount_steps jsonb,                -- «с такой-то даты платёж другой»; правило в core/amountOn
  payments_by_source jsonb,          -- «5 000 с аванса, 15 000 с зарплаты»: [{source_id, amount_minor}] (#117)
                                     -- сильнее amount_steps: складывать их = заплатить дважды
  pays_from date,                    -- окно платежей, границы ВКЛЮЧИТЕЛЬНЫЕ; вне окна платёж 0 (#117)
  pays_until date,                   -- новый долг по умолчанию стартует со следующей выплаты (#121)
  direction text not null default 'owed_by_me',  -- owed_to_me = заём: в каскад НЕ идёт (#94)
  counterparty text,
  agreed_rate numeric(20,10),        -- договорный курс для p2p-долгов
  closed_at timestamptz
);

create table envelopes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name text not null,                -- 'Инвестиции'
  currency char(3) not null,
  rule_kind text not null check (rule_kind in ('fixed','percent')),
  rule_value numeric(12,4) not null, -- сумма minor (fixed) или % от выплаты
  balance_minor bigint not null default 0
);

create table goals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name text not null,                -- 'Мотоцикл'
  currency char(3) not null,
  target_minor bigint not null,
  saved_minor bigint not null default 0,
  planned_per_period_minor bigint not null default 0,
  achieved_at timestamptz
);

create table currency_buckets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  name text not null,                -- 'EUR на аренду'
  from_currency char(3) not null,    -- RUB
  to_currency char(3) not null,      -- EUR
  amount_minor bigint not null,      -- сколько from-валюты закладываем на период
  active boolean not null default true
);

create table planned_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  period_id uuid not null references pay_periods on delete cascade,
  target_kind text not null check (target_kind in ('category','debt','envelope','goal','bucket')),
  target_id uuid not null,
  planned_minor bigint not null,     -- в базовой валюте
  execution_status text not null default 'pending'
    check (execution_status in ('pending','confirmed','partial','skipped','n_a')), -- n_a для категорий
  executed_minor bigint not null default 0,  -- подтвержденная сумма (для partial)
  auto boolean not null default false,       -- автоплатеж: подтверждается сам в дату
  frozen boolean not null default false,  -- осознанный пропуск взноса в цель на этот период (#54)
  overridden boolean not null default false, -- сумму правил человек (пересборка): сборка её не пересчитывает (#52)
  unique (period_id, target_kind, target_id)
);
-- транзакция подтверждения ссылается на строку плана:
-- alter table transactions add column planned_item_id uuid references planned_items;

create table plan_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  period_id uuid not null references pay_periods on delete cascade,
  reason text not null check (reason in ('overspend','manual','income_change','auto_suggest')),
  moves jsonb not null,  -- [{from:{kind,id}, to:{kind,id}, amount_minor}]
  accepted boolean not null default true,
  created_at timestamptz not null default now()
);

-- Предложения правок от участника совместного доступа (#83).
-- Правит строку только владелец — это правило продукта, поэтому участник не пишет в план, а
-- создаёт предложение со своим жизненным циклом. Принятие выполняет ТУ ЖЕ операцию, что правка
-- ячейки (core/setGridCell): второй дороги к деньгам не появляется.
create table edit_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  author_id text not null references "user" on delete cascade,
  target_kind text not null check (target_kind in ('category','debt','envelope','goal')),
  target_id uuid not null,
  starts_on date not null,           -- период, которому адресована правка
  planned_minor bigint not null,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text references "user" on delete set null
);
-- Скрытый раздел отвечает «не найдено», а не «нельзя»: отказ по существу подтверждал бы, что
-- строка существует, и участник узнавал бы о скрытой цели через форму предложения.
create index edit_proposals_ws_status_idx on edit_proposals (workspace_id, status);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  account_id uuid references accounts,
  period_id uuid references pay_periods,
  kind text not null check (kind in ('expense','income','transfer_out','transfer_in','exchange')),
  target_kind text check (target_kind in ('category','debt','envelope','goal')),
  target_id uuid,
  amount_minor bigint not null,
  currency char(3) not null,
  base_amount_minor bigint not null,   -- снапшот конвертации
  rate numeric(20,10) not null,
  rate_source text not null,           -- 'cbr'|'ecb'|'frankfurter'|'manual'
  rate_date date not null,
  occurred_on date not null,
  source text not null default 'manual' check (source in ('manual','text','voice','receipt','recurring','import')),
  note text,
  raw_input text,                      -- исходный текст/строка чека
  receipt_id uuid references receipts,
  transfer_pair_id uuid                -- связь двух ног перевода/обмена
);

create table receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  status text not null default 'pending' check (status in ('pending','parsed','fallback','failed')),
  method text check (method in ('qr_fns','qr_rs','vision')),
  merchant text,
  total_minor bigint,
  currency char(3),
  purchased_at timestamptz,
  items jsonb,        -- [{name, qty, price_minor, category_id, confidence}]
  image_path text,    -- storage
  qr_payload text
);

create table exchange_ops (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  bucket_id uuid references currency_buckets,   -- принадлежность корзины проверяет роут (правило 7)
  from_account uuid references accounts,        -- nullable: счета появились позже разменов (#45)
  to_account uuid references accounts,
  from_currency char(3) not null,               -- валюты пары: размен возможен и без счетов
  to_currency char(3) not null,
  from_minor bigint not null,
  to_minor bigint not null,
  actual_rate numeric(20,10) not null,     -- вычислен из сумм
  official_rate numeric(20,10),            -- снапшот на дату; null, если котировки на неё нет
  official_source text,
  spread_pct numeric(8,4),                 -- (actual/official - 1) * 100; null без официального курса
  spread_minor bigint,                     -- потеря в валюте получения; отрицательная = выиграл
  occurred_on date not null,
  provider text,                           -- где меняли: по этому полю считается сравнение провайдеров (#53)
  note text                                -- комментарий к сделке, в сравнении не участвует
);

create table workspace_members (   -- совместный доступ (#46): владелец правит, участник смотрит
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  user_id text not null references "user" on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)        -- один человек не состоит в воркспейсе дважды
);

create table workspace_invites (  -- приглашение кодом: почтового провайдера в профиле $0 нет
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now(),
  accepted_by text references "user" on delete set null,
  accepted_at timestamptz          -- заполнено = код сгорел, повторно не впускает
);

create table recurring_items (     -- расходы и взносы; доходы живут в income_sources (одна правда о доходах)
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  kind text not null check (kind in ('expense','envelope','goal','debt')),
  target_id uuid,
  name text not null,
  amount_minor bigint not null,
  currency char(3) not null,
  -- Правило повтора (RecurringSchedule в packages/core/src/recurring.ts). Виды никогда не
  -- переименовываются: jsonb хранит их как есть, и смена имени сделала бы старые строки нечитаемыми.
  --   {kind:'monthly-days', days:[10,25]}
  --   {kind:'every-weeks', weeks:2, startsOn:'2026-07-01'}
  --   {kind:'monthly-nth-weekday', nth:2, weekday:2}   -- nth = -1 «последний»; «пятого» не бывает
  --   {kind:'yearly', month:9, day:12}                 -- 29 февраля клампится к концу месяца
  --   {kind:'each-payout'}                             -- ровно одна дата: начало периода
  --   {kind:'one-off', date:'2026-08-01'} | {kind:'irregular'}
  schedule jsonb not null,
  starts_on date,            -- первая дата платежа: до неё событий нет
  ends_on date,              -- отменённая подписка перестаёт быть событием, но остаётся в истории
  show_on_map boolean not null default true,  -- метка на карте периода; событие в прогнозе остаётся
  amount_steps jsonb,        -- «с такой-то даты сумма другая»: интернет 2 500 до октября, потом 4 000
  reserve boolean not null default false,  -- откладывать в этом периоде под платёж следующего
                             -- (выключено по умолчанию: иначе деньги посчитались бы дважды)
  next_on date,              -- НЕ ЧИТАЕТСЯ ни одним хендлером (техдолг, не оживлять вслепую)
  escalation jsonb,          -- {percent: 10, from: '2026-06-01'} — аренда растет; тоже не читается
  active boolean not null default true
);

create table import_batches (     -- пачка импорта: нужна, чтобы перенос можно было откатить целиком
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  filename text not null,
  sheet text not null,             -- лист книги: в одном файле их несколько (журнал, словарь, сводки)
  rows_total int not null default 0,
  rows_imported int not null default 0,
  rows_duplicated int not null default 0,
  status text not null default 'committed' check (status in ('committed','rolled_back')),
  created_at timestamptz not null default now()
);
create index import_batches_ws_idx on import_batches (workspace_id, created_at);
-- transactions: import_batch_id uuid references import_batches on delete set null,
--               import_key text  -- отпечаток строки исходной таблицы, unique (workspace_id, import_key)
--               client_key text  -- ключ попытки записи из офлайн-очереди; unique (workspace_id, client_key):
--                                -- повтор отправки не создаёт вторую трату

create table fx_rates (
  source text not null,      -- 'cbr' | 'ecb' | 'frankfurter' (только публичные источники)
  base char(3) not null,
  quote char(3) not null,
  on_date date not null,
  rate numeric(20,10) not null,
  primary key (source, base, quote, on_date)
); -- глобальная, без RLS (публичные данные), запись только сервисной ролью

create table fx_manual_rates (   -- личные курсы: курс дня выплаты, введённый руками
  workspace_id uuid not null references workspaces on delete cascade,
  base char(3) not null,
  quote char(3) not null,
  on_date date not null,
  rate numeric(20,10) not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, base, quote, on_date)
); -- отдельно от fx_rates: там публичные котировки, и личный курс протекал бы в чужие планы
```

## Billing (см. 08-billing.md)

```sql
create table plans (
  id text primary key,              -- 'free' | 'pro' | 'lifetime'
  name jsonb not null,              -- {ru, en}
  entitlements jsonb not null,      -- {max_currencies, max_accounts, ai_ops_month, exchange_planner, forecast_months, family}
  active boolean not null default true
);

create table plan_prices (
  id uuid primary key default gen_random_uuid(),
  plan_id text not null references plans,
  provider text not null check (provider in ('stripe','tg_stars','manual')),
  region text not null default 'default',   -- PPP-корзина
  currency char(3) not null,
  amount_minor bigint not null,
  period text not null check (period in ('month','year','lifetime')),
  external_id text                           -- stripe price id
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  plan_id text not null references plans,
  status text not null check (status in ('trialing','active','past_due','canceled','expired','lifetime')),
  provider text not null,
  external_id text,                          -- stripe subscription id
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  granted_by uuid,                           -- admin comp
  created_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscriptions,
  provider text not null, external_id text,
  amount_minor bigint not null, currency char(3) not null,
  status text not null check (status in ('paid','refunded','failed','disputed')),
  paid_at timestamptz, raw jsonb
);

create table ai_usage (
  workspace_id uuid not null references workspaces on delete cascade,
  month date not null,                       -- первое число месяца
  ops int not null default 0,                -- vision + llm + whisper вызовы
  cost_usd_micros bigint not null default 0,
  primary key (workspace_id, month)
);
```

## Admin (см. 09-admin.md)

```sql
create table admin_users (
  user_id uuid primary key references users(id),
  role text not null check (role in ('owner','admin','support')),
  totp_enabled boolean not null default false
);

create table audit_log (              -- append-only, без update/delete
  id bigserial primary key,
  actor_id uuid not null,
  actor_role text not null,
  action text not null,               -- 'subscription.grant', 'user.block', 'support_access.enter'...
  object_type text not null, object_id text not null,
  reason text, meta jsonb,
  created_at timestamptz not null default now()
);

create table feature_flags (
  key text primary key,
  description text,
  rules jsonb not null default '{}', -- {workspaces:[...], percent: 10}
  active boolean not null default false
);

create table support_access (         -- явное согласие на диагностический доступ
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces,
  granted_by_user boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

## Legal (см. 10-legal.md)

```sql
create table legal_documents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('terms','privacy','cookies','subprocessors')),
  locale text not null, version int not null,
  body_md text not null, published_at timestamptz,
  unique (kind, locale, version)
);

create table legal_acceptances (
  user_id uuid not null references users(id),
  kind text not null, version int not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, kind, version)
);
```

## Замечания для имплементации

- **Изоляция**: API-middleware резолвит workspace по токену и скоупит каждый запрос; ни один хендлер не принимает workspace_id от клиента.
- **fx-пайплайн**: cron (pg_cron или node-cron) ежедневно тянет ЦБ РФ (XML_daily, кодировка windows-1251, курс публикуется накануне «на завтра»), ЕЦБ/Frankfurter. Запрос курса на дату: своя таблица → лениво дотянуть из API → фоллбек на последний рабочий день (выходные) → 'manual'.
- **Кросс-курсы**: хранить исходные котировки к базе источника (ЦБ: всё к RUB), кросс вычислять: `USD→RSD = (RUB/USD)/(RUB/RSD)`.
- Баланс счета — денормализация; пересчитывается триггером/сервисом из транзакций, сверка — фоновым джобом.
- ETA цели: `ceil((target - saved) / planned_per_period)` периодов → месяцы и «зарплаты».
