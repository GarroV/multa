# Модель дохода: ритм отдельно от источников — план имплементации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ритм планирования (границы периодов) и источники денег становятся двумя независимыми вещами: ритм — настройка воркспейса с превью реальных дат, доход периода — сумма событий всех активных источников внутри `[startsOn, endsOn)`.

**Architecture:** `packages/core` получает `income.ts` (чистые функции: события источника внутри периода, сумма в базовой валюте) и правило выходных в `periods.ts`. `apps/api` получает таблицу `income_sources`, CRUD, атомарный эндпоинт онбординга и считает доход **для конкретного периода** вместо чтения скалярной колонки воркспейса. `apps/web` получает шаг «Когда приходят деньги» из двух блоков (ритм с превью дат → суммы выплат) и тот же редактор в настройках.

**Tech Stack:** pnpm + Turborepo; vitest; Node 22 + Hono + Drizzle + Postgres 16; Vite + React 18 + TanStack Query; zod на границах.

**Спека:** [2026-07-30-income-sources-design.md](../specs/2026-07-30-income-sources-design.md). **Issue:** [#26](https://github.com/GarroV/multa/issues/26), закрывает [#27](https://github.com/GarroV/multa/issues/27).

## Global Constraints

- **Деньги — только integer minor units** (`bigint`). Float в денежных значениях = баг. Хелперы — `packages/core/src/money.ts`.
- **В jsonb деньги хранятся строками-целыми** и парсятся в bigint на границе: `JSON.stringify` не умеет bigint.
- **Никакой доменной логики в компонентах React** — только `packages/core` (чистые функции) и `apps/api`.
- **Все строки UI — через i18n-ключи** (`packages/i18n`, ru + en). Хардкод строк — баг. Ключи: `area.screen.element`.
- **Цвета — только семантические CSS-переменные**, существующие классы `.chip/.field/.mono/.btn/.row/.card/.note-band/.micro/.dim`. Хардкод hex — баг.
- **Изоляция workspace — в API-middleware.** Ни один хендлер не принимает `workspace_id` от клиента; скоуп только из токена (`requireWorkspace`).
- **TS strict, ESM everywhere.** Импорты внутри пакетов — с расширением `.ts`/`.tsx`.
- **Zod-схемы на границах API.** Невалидный ввод → `ZodError` → 400, не 500.
- **Миграции — Drizzle:** `schema.ts` → `drizzle-kit generate --name <verb_noun>` → `apps/api/migrations/NNNN_verb_noun.sql`. Руками SQL не писать.
- **Коммиты — conventional**, по одному на задачу: `feat(core): …`, `feat(api): …`, `feat(web): …`, `docs: …`.
- **Тон текстов — штурман, не учитель.** Без «Вы превысили!», без вины.
- **Dev-окружение:** Postgres — локальный Homebrew (не docker), `postgres://multa:multa_dev_password@localhost:5432/multa`. `.env` в `apps/api` нет — переменные передаются инлайном (см. Task 13).

**Команды проверки** (из корня репозитория):

```bash
pnpm --filter @multa/core test          # vitest ядра
pnpm --filter @multa/api test           # vitest api
pnpm --filter @multa/web test           # vitest web (jsdom)
pnpm --filter @multa/i18n test          # vitest словарей
pnpm typecheck                          # tsc --noEmit во всех воркспейсах
```

**Отклонения от текста спеки** (осознанные, зафиксированы здесь):

| Спека | План | Почему |
|---|---|---|
| «web e2e Playwright» | vitest на чистые хелперы формы + браузерный смоук через chrome-devtools MCP | Playwright-харнеса в репозитории нет, он живёт в [#17](https://github.com/GarroV/multa/issues/17). Заводить его внутри этой задачи — отдельный кусок работы, не относящийся к модели дохода. |
| `income: { expectedMinor, events, unresolved }` в `PlanDto` | `incomeMinor` (как сейчас) + `income: { events, unresolved }` | `plan.incomeMinor` уже читают [Today.tsx:78](../../../apps/web/src/screens/Today.tsx#L78) и [Plan.tsx:81](../../../apps/web/src/screens/Plan.tsx#L81). Два поля с одним фактом (`expectedMinor` и `incomeMinor`) — дрейф; оставляем одно имя. |

---

## File Structure

**Создать:**

| Файл | Ответственность |
|---|---|
| `packages/core/src/income.ts` | Типы `IncomeSource`/`IncomeSchedule`/`IncomeAmount`/`IncomeEvent`, `amountOfSource`, `incomeEventsIn`, `expectedIncomeForPeriod`, `rhythmMismatches`. Чистые функции, без FX и БД. |
| `packages/core/src/income.test.ts` | Тесты ядра дохода. |
| `apps/api/src/income/store.ts` | Доступ к `income_sources`: список, вставка, правка, удаление, атомарная замена набора; маппинг строка БД ↔ домен (bigint ↔ строка). |
| `apps/api/src/routes/income.ts` | HTTP: `GET/POST/PATCH/DELETE /v1/income-sources`, `POST /v1/onboarding/income`. |
| `apps/web/src/lib/income.ts` | Чистые хелперы формы: состояние формы → payload API, превью дат через `@multa/core`, разбор источника в состояние формы. |
| `apps/web/src/lib/income.test.ts` | Тесты хелперов формы. |
| `apps/web/src/components/RhythmPicker.tsx` | Выбор ритма: три варианта, редактируемые дни/дата, превью реальных дат, правило выходных. |
| `apps/web/src/components/IncomeSourceList.tsx` | Список выплат/источников: метка, расписание, сумма или % от оклада, удаление, добавление. |

**Изменить:**

| Файл | Что |
|---|---|
| `packages/core/src/periods.ts` | `WeekendRule`, `shiftForWeekend`, `addDays`, `monthlyDatesBetween`, `everyWeeksDatesBetween`, необязательный `weekendRule` в `PeriodConfig`. |
| `packages/core/src/index.ts` | Экспорт `./income.ts`. |
| `packages/core/package.json` | `exports` → `"./income": "./src/income.ts"`. |
| `apps/api/src/db/schema/domain.ts` | Таблица `incomeSources`; `workspaces.paydayWeekendRule`; удалить `workspaces.expectedIncomeMinor`; `recurringItems.kind` без `'income'`. |
| `apps/api/src/validation.ts` | Схемы источников/ритма/правила выходных; удалить `anchorsSchema` и `paydaySchema`. |
| `apps/api/src/validation.test.ts` | Тесты новых схем; убрать тесты `paydaySchema`. |
| `apps/api/src/app.ts` | `serializeWorkspace`, `/v1/me` с `onboardingComplete`, `PATCH /v1/workspace` (ритм + правило), подключение роута источников, удаление `POST /v1/onboarding/payday`. |
| `apps/api/src/plan/assemble.ts` | Доход периода из событий, блок `income` в DTO, предзагрузка курсов, `percentOfMinor` из ядра вместо локального `pctOfMinor`. |
| `apps/web/src/lib/queries.ts` | `WorkspaceDto` (`rhythm`, `weekendRule`, без `expectedIncomeMinor`), `MeDto.onboardingComplete`, DTO источников, хуки CRUD. |
| `apps/web/src/App.tsx` | Гейт по `onboardingComplete`. |
| `apps/web/src/screens/Onboarding.tsx` | `PaydayStep` → `IncomeStep`. |
| `apps/web/src/screens/Settings.tsx` | Редактор ритма + источников вместо пресетов. |
| `packages/i18n/src/en.ts`, `ru.ts` | Ключи `income.*`; удалить `onboarding.payday.preset.*`, `onboarding.payday.expectedAmount`, `settings.income`, `settings.anchors`. |
| `docs/01-domain-model.md`, `02-data-schema.md`, `04-web-ux.md` | Синхронизация с кодом (Task 12). |

**Удалить:** `apps/web/src/lib/paydayPresets.ts`.

---

## Task 1: Правило выходных и оконные генераторы дат в `periods.ts`

Даты и границы — предметная область `periods.ts`. `income.ts` будет импортировать эти примитивы оттуда: обратный импорт создал бы цикл.

**Files:**
- Modify: `packages/core/src/periods.ts`
- Test: `packages/core/src/periods.test.ts`

**Interfaces:**
- Consumes: ничего (первая задача).
- Produces:
  - `export type WeekendRule = 'as-is' | 'before' | 'after'`
  - `export function shiftForWeekend(iso: string, rule?: WeekendRule): string`
  - `export function addDays(iso: string, n: number): string`
  - `export function monthlyDatesBetween(days: readonly number[], fromIso: string, toIso: string): string[]`
  - `export function everyWeeksDatesBetween(weeks: number, anchorStart: string, fromIso: string, toIso: string): string[]`
  - `PeriodConfig` варианты `monthly-days` и `every-weeks` получают необязательное `weekendRule?: WeekendRule`

- [ ] **Step 1: Написать падающие тесты**

Дописать в конец `packages/core/src/periods.test.ts` (импорт наверху файла расширить: `addDays, everyWeeksDatesBetween, monthlyDatesBetween, shiftForWeekend`):

```ts
describe('shiftForWeekend', () => {
  it('as-is не двигает дату', () => {
    expect(shiftForWeekend('2026-07-25', 'as-is')).toBe('2026-07-25'); // суббота
  });

  it('before уводит субботу на пятницу, воскресенье — на пятницу', () => {
    expect(shiftForWeekend('2026-07-25', 'before')).toBe('2026-07-24');
    expect(shiftForWeekend('2026-07-26', 'before')).toBe('2026-07-24');
  });

  it('after уводит субботу и воскресенье на понедельник', () => {
    expect(shiftForWeekend('2026-07-25', 'after')).toBe('2026-07-27');
    expect(shiftForWeekend('2026-07-26', 'after')).toBe('2026-07-27');
  });

  it('рабочий день не двигает ни одним правилом', () => {
    expect(shiftForWeekend('2026-07-24', 'before')).toBe('2026-07-24'); // пятница
    expect(shiftForWeekend('2026-07-24', 'after')).toBe('2026-07-24');
  });
});

describe('generatePeriods — правило выходных', () => {
  it('сдвигает границу периода, когда выплата попала на субботу', () => {
    const cfg: PeriodConfig = { kind: 'monthly-days', days: [25], weekendRule: 'before' };
    // 25 июля 2026 — суббота → выплата 24-го, значит и период начинается 24-го.
    expect(generatePeriods(cfg, '2026-07-26', 1)).toEqual([
      { startsOn: '2026-07-24', endsOn: '2026-08-25' },
    ]);
  });

  it('склеивает две выплаты, сдвинутые на одну дату (25 сб и 26 вс → 24 пт)', () => {
    const cfg: PeriodConfig = { kind: 'monthly-days', days: [25, 26], weekendRule: 'before' };
    expect(generatePeriods(cfg, '2026-07-27', 1)).toEqual([
      { startsOn: '2026-07-24', endsOn: '2026-08-25' },
    ]);
  });

  it('без weekendRule поведение не меняется (дефолт as-is)', () => {
    const cfg: PeriodConfig = { kind: 'monthly-days', days: [25] };
    expect(generatePeriods(cfg, '2026-07-26', 1)).toEqual([
      { startsOn: '2026-07-25', endsOn: '2026-08-25' },
    ]);
  });
});

describe('оконные генераторы дат', () => {
  it('addDays двигает дату в обе стороны через границу месяца', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
  });

  it('monthlyDatesBetween отдаёт даты окна с клампом к длине месяца', () => {
    expect(monthlyDatesBetween([10, 25], '2026-07-05', '2026-08-12')).toEqual([
      '2026-07-10',
      '2026-07-25',
      '2026-08-10',
    ]);
    expect(monthlyDatesBetween([31], '2026-02-01', '2026-02-28')).toEqual(['2026-02-28']);
  });

  it('monthlyDatesBetween дедупит даты, схлопнувшиеся клампом (30 и 31 в феврале)', () => {
    expect(monthlyDatesBetween([30, 31], '2026-02-01', '2026-02-28')).toEqual(['2026-02-28']);
  });

  it('everyWeeksDatesBetween шагает от якоря и не выходит за окно', () => {
    expect(everyWeeksDatesBetween(2, '2026-07-03', '2026-07-10', '2026-08-05')).toEqual([
      '2026-07-17',
      '2026-07-31',
    ]);
  });

  it('everyWeeksDatesBetween не отдаёт дат до якоря', () => {
    expect(everyWeeksDatesBetween(1, '2026-07-10', '2026-07-01', '2026-07-15')).toEqual([
      '2026-07-10',
    ]);
  });
});
```

- [ ] **Step 2: Прогнать тесты — должны падать**

Run: `pnpm --filter @multa/core test`
Expected: FAIL — `shiftForWeekend is not a function` / `addDays is not exported` и падения трёх тестов `generatePeriods — правило выходных`.

- [ ] **Step 3: Реализовать примитивы в `periods.ts`**

Заменить объявление `PeriodConfig` (строки 18–21):

```ts
/** Правило переноса выплаты, попавшей на выходной. В РФ и Сербии обычно платят раньше. */
export type WeekendRule = 'as-is' | 'before' | 'after';

export type PeriodConfig =
  | { kind: 'monthly-days'; days: number[]; weekendRule?: WeekendRule } // «10 и 25»
  | { kind: 'every-weeks'; weeks: number; startsOn: string; weekendRule?: WeekendRule } // «каждые N недель» от даты
  | { kind: 'custom'; dates: string[] }; // явные даты выплат
```

Добавить после `diffDays` (после строки 41):

```ts
/** Сдвиг ISO-даты на n дней (n может быть отрицательным). */
export function addDays(iso: string, n: number): string {
  return fromUTC(toUTC(iso) + n * MS_PER_DAY);
}

/**
 * Дата выплаты с учётом правила выходных: 'before' — предшествующая пятница,
 * 'after' — следующий понедельник. Влияет на границы периодов, поэтому применяется
 * до сборки периодов, а не при отображении.
 */
export function shiftForWeekend(iso: string, rule: WeekendRule = 'as-is'): string {
  if (rule === 'as-is') return iso;
  const weekday = new Date(toUTC(iso)).getUTCDay(); // 0 = вс, 6 = сб
  if (weekday !== 0 && weekday !== 6) return iso;
  const delta = rule === 'before' ? (weekday === 6 ? -1 : -2) : weekday === 6 ? 2 : 1;
  return addDays(iso, delta);
}

/** Сортировка + дедуп: сдвиг по выходным и кламп коротких месяцев могут дать одну дату из двух. */
function normalizeDates(dates: readonly string[]): string[] {
  const sorted = [...dates].sort();
  return sorted.filter((d, i) => i === 0 || d !== sorted[i - 1]);
}

/** Даты «дней месяца» внутри окна [fromIso, toIso] с клампом к длине месяца. Отсортированы, без дублей. */
export function monthlyDatesBetween(days: readonly number[], fromIso: string, toIso: string): string[] {
  const sortedDays = [...new Set(days)].sort((a, b) => a - b);
  const start = new Date(toUTC(fromIso));
  const end = new Date(toUTC(toIso));
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  const lastYear = end.getUTCFullYear();
  const lastMonth = end.getUTCMonth() + 1;
  const out: string[] = [];
  while (year * 12 + month <= lastYear * 12 + lastMonth) {
    const dim = daysInMonth(year, month);
    for (const day of sortedDays) {
      out.push(fromUTC(Date.UTC(year, month - 1, Math.min(day, dim))));
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return normalizeDates(out).filter((d) => d >= fromIso && d <= toIso);
}

/** Даты цикла «каждые N недель» от якорной даты внутри окна [fromIso, toIso]. Дат до якоря не бывает. */
export function everyWeeksDatesBetween(
  weeks: number,
  anchorStart: string,
  fromIso: string,
  toIso: string,
): string[] {
  const stepDays = weeks * 7;
  const out: string[] = [];
  let current = anchorStart;
  // Прыжок к началу окна, чтобы не шагать по одному дню от далёкого якоря.
  const gap = diffDays(anchorStart, fromIso);
  if (gap > 0) current = addDays(anchorStart, Math.floor(gap / stepDays) * stepDays);
  while (current <= toIso) {
    if (current >= fromIso) out.push(current);
    current = addDays(current, stepDays);
  }
  return out;
}
```

- [ ] **Step 4: Применить правило выходных в `generatePeriods`**

`monthlyPaydays` переписать на общий примитив (кламп больше не дублируется), заменив тело функции (строки 44–70):

```ts
/** Список дат выплат для monthly-days: от месяца до `around` и на count+3 месяца вперёд. */
function monthlyPaydays(days: number[], around: string, count: number): string[] {
  const from = addDays(around, -62); // месяц назад с запасом на любую длину месяца
  const to = addDays(around, 31 * (count + 3));
  return monthlyDatesBetween(days, from, to);
}
```

В `generatePeriods` (строки 105–116) применить сдвиг к датам выплат до сборки периодов:

```ts
/** Генерит `count` периодов начиная с периода, содержащего `from`. */
export function generatePeriods(config: PeriodConfig, from: string, count: number): PayPeriod[] {
  switch (config.kind) {
    case 'monthly-days':
      return buildFrom(withWeekendRule(monthlyPaydays(config.days, from, count), config.weekendRule), from, count);
    case 'every-weeks':
      return buildFrom(
        withWeekendRule(everyWeeksPaydays(config.weeks, config.startsOn, from, count), config.weekendRule),
        from,
        count,
      );
    case 'custom':
      return buildFrom(normalizeDates(config.dates), from, count);
  }
}
```

И вспомогательная функция рядом с `buildFrom`:

```ts
/** Сдвигает даты выплат по правилу выходных и нормализует (сдвиг может склеить две даты в одну). */
function withWeekendRule(paydays: string[], rule: WeekendRule | undefined): string[] {
  if (!rule || rule === 'as-is') return paydays;
  return normalizeDates(paydays.map((d) => shiftForWeekend(d, rule)));
}
```

- [ ] **Step 5: Прогнать тесты — новые проходят, старые не сломались**

Run: `pnpm --filter @multa/core test`
Expected: PASS всех тестов `periods.test.ts`, включая ранее существовавшие (`monthly-days`, `every-weeks`, `custom`, `daysInPeriod`, `daysLeftInPeriod`) — они и есть страховка того, что дефолт `'as-is'` ничего не сдвинул.

- [ ] **Step 6: Typecheck и коммит**

```bash
pnpm typecheck
git add packages/core/src/periods.ts packages/core/src/periods.test.ts
git commit -m "feat(core): правило выходных и оконные генераторы дат в periods"
```

---

## Task 2: События источников внутри периода (`income.ts`)

**Files:**
- Create: `packages/core/src/income.ts`
- Create: `packages/core/src/income.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json`

**Interfaces:**
- Consumes: из Task 1 — `addDays`, `shiftForWeekend`, `monthlyDatesBetween`, `everyWeeksDatesBetween`, `WeekendRule`, `PayPeriod`.
- Produces:
  - типы `IncomeSchedule`, `IncomeAmount`, `IncomeSource`, `IncomeEvent`
  - `export function percentOfMinor(ofMinor: bigint, percent: string): bigint`
  - `export function amountOfSource(amount: IncomeAmount): bigint`
  - `export function incomeEventsIn(sources: readonly IncomeSource[], period: PayPeriod, weekendRule?: WeekendRule): IncomeEvent[]`

- [ ] **Step 1: Написать падающие тесты**

Создать `packages/core/src/income.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { amountOfSource, incomeEventsIn, percentOfMinor, type IncomeSource } from './income.ts';
import type { PayPeriod } from './periods.ts';

/** Источник по умолчанию: RUB, активный, фиксированный. Тесты переопределяют нужные поля. */
function source(over: Partial<IncomeSource> & Pick<IncomeSource, 'id' | 'label' | 'schedule' | 'amount'>): IncomeSource {
  return { currency: 'RUB', stability: 'fixed', active: true, ...over };
}

const salary = source({
  id: 's1',
  label: 'Зарплата',
  schedule: { kind: 'monthly-days', days: [25] },
  amount: { kind: 'absolute', amountMinor: 12_000_000n },
});
const advance = source({
  id: 's2',
  label: 'Аванс',
  schedule: { kind: 'monthly-days', days: [10] },
  amount: { kind: 'absolute', amountMinor: 8_000_000n },
});
const sideGig = source({
  id: 's3',
  label: 'Подработка',
  schedule: { kind: 'every-weeks', weeks: 1, startsOn: '2026-07-03' }, // пятницы
  amount: { kind: 'absolute', amountMinor: 1_500_000n },
  stability: 'variable',
});

const july: PayPeriod = { startsOn: '2026-07-10', endsOn: '2026-07-25' };

describe('percentOfMinor', () => {
  it('считает процент в BigInt без float', () => {
    expect(percentOfMinor(20_000_000n, '40')).toBe(8_000_000n);
    expect(percentOfMinor(20_000_000n, '60')).toBe(12_000_000n);
  });

  it('поддерживает дробный процент и округляет вниз', () => {
    expect(percentOfMinor(10_000_001n, '12.5')).toBe(1_250_000n);
  });
});

describe('amountOfSource', () => {
  it('absolute отдаёт сумму как есть', () => {
    expect(amountOfSource({ kind: 'absolute', amountMinor: 8_000_000n })).toBe(8_000_000n);
  });

  it('percent считает от оклада источника', () => {
    expect(amountOfSource({ kind: 'percent', percent: '40', ofMinor: 20_000_000n })).toBe(8_000_000n);
  });
});

describe('incomeEventsIn', () => {
  it('берёт только приходы внутри полуоткрытого интервала', () => {
    const events = incomeEventsIn([advance, salary], july);
    expect(events.map((e) => [e.date, e.label])).toEqual([['2026-07-10', 'Аванс']]);
  });

  it('приход в день endsOn относится к следующему периоду', () => {
    const next: PayPeriod = { startsOn: '2026-07-25', endsOn: '2026-08-10' };
    expect(incomeEventsIn([advance, salary], next).map((e) => e.date)).toEqual(['2026-07-25']);
  });

  it('смешивает расписания: недельная подработка добавляет приходы внутрь периода', () => {
    // Якорь подработки — пятница 3 июля, значит платит и 10-го (тоже пятница, совпадает с началом периода).
    const events = incomeEventsIn([advance, sideGig], july);
    expect(events.map((e) => [e.date, e.label])).toEqual([
      ['2026-07-10', 'Аванс'],
      ['2026-07-10', 'Подработка'],
      ['2026-07-17', 'Подработка'],
      ['2026-07-24', 'Подработка'],
    ]);
  });

  it('складывает приходы, схлопнувшиеся клампом короткого месяца', () => {
    const feb: PayPeriod = { startsOn: '2026-02-15', endsOn: '2026-03-15' };
    const s30 = source({ id: 'a', label: '30-го', schedule: { kind: 'monthly-days', days: [30] }, amount: { kind: 'absolute', amountMinor: 100n } });
    const s31 = source({ id: 'b', label: '31-го', schedule: { kind: 'monthly-days', days: [31] }, amount: { kind: 'absolute', amountMinor: 200n } });
    const events = incomeEventsIn([s30, s31], feb);
    expect(events.map((e) => [e.date, e.amountMinor])).toEqual([
      ['2026-02-28', 100n],
      ['2026-02-28', 200n],
    ]);
  });

  it('правило выходных двигает дату прихода', () => {
    const period: PayPeriod = { startsOn: '2026-07-20', endsOn: '2026-08-20' };
    expect(incomeEventsIn([salary], period, 'before').map((e) => e.date)).toEqual(['2026-07-24']);
    expect(incomeEventsIn([salary], period, 'after').map((e) => e.date)).toEqual(['2026-07-27']);
  });

  it('затягивает приход, который правило выходных перенесло в период извне', () => {
    // 1 марта 2026 — воскресенье; при 'before' выплата приходит 27 февраля.
    const first = source({ id: 'c', label: '1-го', schedule: { kind: 'monthly-days', days: [1] }, amount: { kind: 'absolute', amountMinor: 500n } });
    const feb: PayPeriod = { startsOn: '2026-02-20', endsOn: '2026-03-01' };
    expect(incomeEventsIn([first], feb, 'before').map((e) => e.date)).toEqual(['2026-02-27']);
  });

  it('irregular не даёт событий', () => {
    const chaos = source({ id: 'd', label: 'Когда как', schedule: { kind: 'irregular' }, amount: { kind: 'absolute', amountMinor: 999n } });
    expect(incomeEventsIn([chaos], july)).toEqual([]);
  });

  it('one-off даёт событие только внутри своего периода', () => {
    const bonus = source({ id: 'e', label: 'Гонорар', schedule: { kind: 'one-off', date: '2026-07-15' }, amount: { kind: 'absolute', amountMinor: 5_000_000n } });
    expect(incomeEventsIn([bonus], july).map((e) => e.date)).toEqual(['2026-07-15']);
    expect(incomeEventsIn([bonus], { startsOn: '2026-07-25', endsOn: '2026-08-10' })).toEqual([]);
  });

  it('active: false исключает источник', () => {
    expect(incomeEventsIn([{ ...advance, active: false }], july)).toEqual([]);
  });

  it('startsOn и endsOn источника обрезают события', () => {
    const started = { ...sideGig, startsOn: '2026-07-18' };
    expect(incomeEventsIn([started], july).map((e) => e.date)).toEqual(['2026-07-24']);
    const ended = { ...sideGig, endsOn: '2026-07-18' };
    expect(incomeEventsIn([ended], july).map((e) => e.date)).toEqual(['2026-07-10', '2026-07-17']);
  });

  it('нулевая сумма в план не идёт', () => {
    expect(incomeEventsIn([{ ...advance, amount: { kind: 'absolute', amountMinor: 0n } }], july)).toEqual([]);
  });

  it('события отсортированы по дате', () => {
    const events = incomeEventsIn([sideGig, advance], july);
    expect(events.map((e) => e.date)).toEqual([...events.map((e) => e.date)].sort());
  });
});
```

- [ ] **Step 2: Прогнать тесты — должны падать**

Run: `pnpm --filter @multa/core test income`
Expected: FAIL — `Cannot find module './income.ts'`.

- [ ] **Step 3: Реализовать `income.ts`**

Создать `packages/core/src/income.ts`:

```ts
/**
 * Источники дохода: сколько и когда приходит. Границы периодов задаёт РИТМ (PeriodConfig,
 * настройка воркспейса) — источники их не двигают. Ожидаемый доход периода = сумма событий
 * всех активных источников внутри [startsOn, endsOn).
 *
 * Даты — строки 'YYYY-MM-DD', арифметика в UTC (см. periods.ts). Деньги — integer minor units.
 */

import {
  addDays,
  everyWeeksDatesBetween,
  monthlyDatesBetween,
  shiftForWeekend,
  type PayPeriod,
  type WeekendRule,
} from './periods.ts';
import { money, type Money } from './money.ts';

export type IncomeSchedule =
  | { kind: 'monthly-days'; days: number[] } // «10 и 25»
  | { kind: 'every-weeks'; weeks: number; startsOn: string } // цикл от реальной даты выплаты
  | { kind: 'one-off'; date: string } // разовый гонорар
  | { kind: 'irregular' }; // «когда как» — в план не идёт, только факт

export type IncomeAmount =
  | { kind: 'absolute'; amountMinor: bigint }
  | { kind: 'percent'; percent: string; ofMinor: bigint }; // аванс 40% от оклада

export interface IncomeSource {
  readonly id: string;
  readonly label: string;
  readonly currency: string;
  readonly schedule: IncomeSchedule;
  readonly amount: IncomeAmount;
  readonly stability: 'fixed' | 'variable';
  readonly active: boolean;
  readonly startsOn?: string;
  readonly endsOn?: string;
}

export interface IncomeEvent {
  readonly sourceId: string;
  readonly label: string;
  /** Фактическая дата прихода — после применения правила выходных. */
  readonly date: string;
  /** Сумма в валюте источника. */
  readonly amountMinor: bigint;
  readonly currency: string;
}

/**
 * Процент от суммы в BigInt с округлением вниз: "40" от 20 000 00 → 8 000 00.
 * Планирование, не платёж — поэтому floor, а не half-up.
 */
export function percentOfMinor(ofMinor: bigint, percent: string): bigint {
  const [intPart = '0', fracPart = ''] = percent.trim().split('.');
  const scaled = BigInt((intPart || '0') + fracPart); // "12.5" → 125
  const denom = 100n * 10n ** BigInt(fracPart.length);
  return (ofMinor * scaled) / denom;
}

/** Сумма одного прихода источника в его валюте. */
export function amountOfSource(amount: IncomeAmount): bigint {
  return amount.kind === 'absolute' ? amount.amountMinor : percentOfMinor(amount.ofMinor, amount.percent);
}

/**
 * Максимальный сдвиг по правилу выходных — 2 дня, поэтому окно расширяем на 3:
 * приход из-за границы периода может попасть внутрь после сдвига (1 марта вс → 27 фев).
 */
const SHIFT_MARGIN_DAYS = 3;

/** Сырые даты расписания в окне вокруг периода, до применения правила выходных. */
function rawDatesAround(schedule: IncomeSchedule, period: PayPeriod): string[] {
  const from = addDays(period.startsOn, -SHIFT_MARGIN_DAYS);
  const to = addDays(period.endsOn, SHIFT_MARGIN_DAYS);
  switch (schedule.kind) {
    case 'monthly-days':
      return monthlyDatesBetween(schedule.days, from, to);
    case 'every-weeks':
      return everyWeeksDatesBetween(schedule.weeks, schedule.startsOn, from, to);
    case 'one-off':
      return schedule.date >= from && schedule.date <= to ? [schedule.date] : [];
    case 'irregular':
      return []; // в план не идёт по инварианту
  }
}

/** Даты прихода источника внутри [startsOn, endsOn) с учётом правила выходных и срока жизни источника. */
function datesIn(source: IncomeSource, period: PayPeriod, weekendRule: WeekendRule): string[] {
  return rawDatesAround(source.schedule, period)
    .map((date) => shiftForWeekend(date, weekendRule))
    .filter((date) => date >= period.startsOn && date < period.endsOn)
    .filter((date) => (source.startsOn === undefined || date >= source.startsOn))
    .filter((date) => (source.endsOn === undefined || date <= source.endsOn))
    .sort();
}

/** Приходы всех активных источников внутри периода, отсортированные по дате. */
export function incomeEventsIn(
  sources: readonly IncomeSource[],
  period: PayPeriod,
  weekendRule: WeekendRule = 'as-is',
): IncomeEvent[] {
  const events: IncomeEvent[] = [];
  for (const source of sources) {
    if (!source.active) continue;
    const amountMinor = amountOfSource(source.amount);
    if (amountMinor <= 0n) continue; // пустой источник в план не тянем
    for (const date of datesIn(source, period, weekendRule)) {
      events.push({ sourceId: source.id, label: source.label, date, amountMinor, currency: source.currency });
    }
  }
  return events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
```

Импорт `money`/`Money` понадобится в Task 3 — если линтер ругается на неиспользуемый импорт, добавить его в Task 3, а не сейчас.

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter @multa/core test income`
Expected: PASS — 14 тестов.

- [ ] **Step 5: Подключить модуль к экспортам пакета**

`packages/core/src/index.ts`:

```ts
export * from './money.ts';
export * from './periods.ts';
export * from './cascade.ts';
export * from './plan.ts';
export * from './fx.ts';
export * from './income.ts';
```

`packages/core/package.json` — в `exports` добавить строку после `"./periods"`:

```json
    "./income": "./src/income.ts",
```

- [ ] **Step 6: Typecheck и коммит**

```bash
pnpm typecheck && pnpm --filter @multa/core test
git add packages/core/src/income.ts packages/core/src/income.test.ts packages/core/src/index.ts packages/core/package.json
git commit -m "feat(core): события источников дохода внутри периода"
```

---

## Task 3: Доход периода в базовой валюте и рассинхрон ритма

**Files:**
- Modify: `packages/core/src/income.ts`
- Test: `packages/core/src/income.test.ts`

**Interfaces:**
- Consumes: из Task 2 — `IncomeEvent`, `IncomeSource`, `incomeEventsIn`; из `money.ts` — `money`, `Money`.
- Produces:
  - `export interface IncomeTotal { readonly incomeMinor: bigint; readonly events: readonly IncomeEvent[]; readonly unresolved: readonly IncomeEvent[] }`
  - `export function expectedIncomeForPeriod(events: readonly IncomeEvent[], base: string, toBase: (m: Money) => Money | null): IncomeTotal`
  - `export function rhythmMismatches(rhythm: PeriodConfig, sources: readonly IncomeSource[], weekendRule: WeekendRule, from: string, count?: number): string[]`

- [ ] **Step 1: Написать падающие тесты**

Дописать в `packages/core/src/income.test.ts` (импорт расширить: `expectedIncomeForPeriod, rhythmMismatches`; из `money.ts` — `money`, тип `Money`):

```ts
describe('expectedIncomeForPeriod', () => {
  // Аванс 80 000,00 + подработка 15 000,00 × 3 (10, 17, 24 июля).
  const events = incomeEventsIn([advance, sideGig], july);

  it('суммирует приходы в базовой валюте', () => {
    const total = expectedIncomeForPeriod(events, 'RUB', () => null);
    expect(total.incomeMinor).toBe(8_000_000n + 3n * 1_500_000n);
    expect(total.unresolved).toEqual([]);
  });

  it('конвертирует не-базовую валюту переданным конвертером', () => {
    const usd = source({
      id: 'f',
      label: 'Фриланс',
      currency: 'USD',
      schedule: { kind: 'one-off', date: '2026-07-15' },
      amount: { kind: 'absolute', amountMinor: 50_000n }, // 500.00 USD
    });
    const withUsd = incomeEventsIn([advance, usd], july);
    const toBase = (m: Money): Money => money(m.minor * 80n, 'RUB'); // условный курс 80
    const total = expectedIncomeForPeriod(withUsd, 'RUB', toBase);
    expect(total.incomeMinor).toBe(8_000_000n + 4_000_000n);
  });

  it('недоступный курс уводит приход в unresolved, а не в ноль', () => {
    const usd = source({
      id: 'g',
      label: 'Фриланс',
      currency: 'USD',
      schedule: { kind: 'one-off', date: '2026-07-15' },
      amount: { kind: 'absolute', amountMinor: 50_000n },
    });
    const total = expectedIncomeForPeriod(incomeEventsIn([advance, usd], july), 'RUB', () => null);
    expect(total.incomeMinor).toBe(8_000_000n);
    expect(total.unresolved.map((e) => e.label)).toEqual(['Фриланс']);
  });

  it('инвариант: сумма равна сумме событий той же валюты', () => {
    const total = expectedIncomeForPeriod(events, 'RUB', () => null);
    const manual = events.reduce((acc, e) => acc + e.amountMinor, 0n);
    expect(total.incomeMinor).toBe(manual);
  });
});

describe('rhythmMismatches', () => {
  it('молчит, когда в день начала периода есть приход', () => {
    const rhythm = { kind: 'monthly-days', days: [10, 25] } as const;
    expect(rhythmMismatches(rhythm, [advance, salary], 'as-is', '2026-07-12', 2)).toEqual([]);
  });

  it('сообщает границу периода, в которую ни один источник не платит', () => {
    const rhythm = { kind: 'monthly-days', days: [10, 25] } as const;
    expect(rhythmMismatches(rhythm, [advance], 'as-is', '2026-07-12', 2)).toEqual(['2026-07-25']);
  });
});
```

- [ ] **Step 2: Прогнать тесты — должны падать**

Run: `pnpm --filter @multa/core test income`
Expected: FAIL — `expectedIncomeForPeriod is not a function`.

- [ ] **Step 3: Реализовать**

Дописать в конец `packages/core/src/income.ts` (и убедиться, что импорт `generatePeriods`, `PeriodConfig`, `money`, `Money` присутствует наверху файла):

```ts
export interface IncomeTotal {
  /** Сумма приходов в базовой валюте. */
  readonly incomeMinor: bigint;
  readonly events: readonly IncomeEvent[];
  /** Приходы, которые не удалось привести к базовой валюте (курс недоступен). */
  readonly unresolved: readonly IncomeEvent[];
}

/**
 * Ожидаемый доход периода в базовой валюте. Конвертация — инъекцией: ядро не знает
 * про БД и кеш курсов. Недоступный курс уводит приход в `unresolved`, а не в молчаливый
 * ноль: заниженный доход раздувает сжатие каскада.
 */
export function expectedIncomeForPeriod(
  events: readonly IncomeEvent[],
  base: string,
  toBase: (m: Money) => Money | null,
): IncomeTotal {
  let incomeMinor = 0n;
  const unresolved: IncomeEvent[] = [];
  for (const event of events) {
    if (event.currency === base) {
      incomeMinor += event.amountMinor;
      continue;
    }
    const converted = toBase(money(event.amountMinor, event.currency));
    if (converted === null) {
      unresolved.push(event);
      continue;
    }
    incomeMinor += converted.minor;
  }
  return { incomeMinor, events, unresolved };
}

/**
 * Границы периодов, в которые ни один источник не платит. Информационно: ритм задаёт
 * пользователь, и «период начинается 10-го, а зарплата приходит 12-го» — его право,
 * но об этом стоит сказать.
 */
export function rhythmMismatches(
  rhythm: PeriodConfig,
  sources: readonly IncomeSource[],
  weekendRule: WeekendRule,
  from: string,
  count = 2,
): string[] {
  return generatePeriods(rhythm, from, count)
    .filter((period) => !incomeEventsIn(sources, period, weekendRule).some((e) => e.date === period.startsOn))
    .map((period) => period.startsOn);
}
```

Импорт наверху файла привести к виду:

```ts
import {
  addDays,
  everyWeeksDatesBetween,
  generatePeriods,
  monthlyDatesBetween,
  shiftForWeekend,
  type PayPeriod,
  type PeriodConfig,
  type WeekendRule,
} from './periods.ts';
import { money, type Money } from './money.ts';
```

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter @multa/core test`
Expected: PASS — весь `core`, 20 тестов в `income.test.ts`.

- [ ] **Step 5: Typecheck и коммит**

```bash
pnpm typecheck
git add packages/core/src/income.ts packages/core/src/income.test.ts
git commit -m "feat(core): доход периода в базовой валюте и проверка рассинхрона ритма"
```

---

## Task 4: Схема БД и миграция

**Files:**
- Modify: `apps/api/src/db/schema/domain.ts`
- Create: `apps/api/migrations/0001_add_income_sources.sql` (генерируется `drizzle-kit`, руками не писать)

**Interfaces:**
- Consumes: ничего из предыдущих задач.
- Produces:
  - `export const incomeSources` (drizzle-таблица; `typeof incomeSources.$inferSelect` — строка БД)
  - `workspaces.paydayWeekendRule: text` (not null, default `'before'`)
  - `workspaces.expectedIncomeMinor` — **удалена**
  - `recurringItems.kind` — без `'income'`

- [ ] **Step 1: Правка схемы**

В `apps/api/src/db/schema/domain.ts` расширить импорт из `drizzle-orm/pg-core` полем `index`, затем заменить блок `workspaces` (строки 25–37):

```ts
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    baseCurrency: ccy('base_currency').notNull().default('RUB'),
    timezone: text('timezone').notNull().default('Europe/Belgrade'),
    locale: text('locale').notNull().default('ru'),
    // Ритм планирования: PeriodConfig из @multa/core. Задаёт ГРАНИЦЫ периодов.
    // Деньги здесь не живут — они в income_sources (правило «ритм ≠ деньги»).
    periodAnchors: jsonb('period_anchors'),
    // Правило переноса выплаты, попавшей на выходной. Влияет на границы периодов.
    paydayWeekendRule: text('payday_weekend_rule').notNull().default('before'),
    createdAt: createdAt(),
  },
  (t) => [
    check('workspaces_weekend_rule_ck', sql`${t.paydayWeekendRule} in ('as-is','before','after')`),
  ],
);
```

Добавить таблицу источников сразу после `workspaces`:

```ts
/**
 * Источники дохода: только деньги (сколько и когда приходит). Границы периодов задаёт
 * ритм воркспейса (workspaces.period_anchors), поэтому здесь нет ни якорей, ни флагов.
 * schedule/amount — jsonb с типами IncomeSchedule/IncomeAmount из @multa/core;
 * суммы внутри jsonb — строки-целые minor units (bigint в JSON не кладём).
 */
export const incomeSources = pgTable(
  'income_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    currency: ccy('currency').notNull(),
    schedule: jsonb('schedule').notNull(),
    amount: jsonb('amount').notNull(),
    stability: text('stability').notNull().default('fixed'),
    active: boolean('active').notNull().default(true),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    sort: integer('sort').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('income_sources_stability_ck', sql`${t.stability} in ('fixed','variable')`),
    index('income_sources_ws_idx').on(t.workspaceId, t.sort),
  ],
);
```

В `recurringItems` заменить check (строка 292) — каноническая правда о доходах теперь одна:

```ts
  (t) => [check('recurring_items_kind_ck', sql`${t.kind} in ('expense','envelope','goal','debt')`)],
```

- [ ] **Step 2: Сгенерировать миграцию**

```bash
cd apps/api && DATABASE_URL='postgres://multa:multa_dev_password@localhost:5432/multa' npx drizzle-kit generate --name add_income_sources
```

Expected: создан `apps/api/migrations/0001_add_income_sources.sql`.

- [ ] **Step 3: Проверить содержимое миграции глазами**

Run: `cat apps/api/migrations/0001_add_income_sources.sql`

В файле должны быть: `CREATE TABLE "income_sources"`, `CREATE INDEX "income_sources_ws_idx"`, `ALTER TABLE "workspaces" ADD COLUMN "payday_weekend_rule"`, `ALTER TABLE "workspaces" DROP COLUMN "expected_income_minor"`, пересоздание check-констрейнта `recurring_items_kind_ck`. Если `DROP COLUMN` отсутствует — колонка не удалена из схемы, вернуться к Step 1.

- [ ] **Step 4: Накатить миграцию на локальный Postgres**

```bash
cd apps/api && DATABASE_URL='postgres://multa:multa_dev_password@localhost:5432/multa' npx drizzle-kit migrate
PGPASSWORD=multa_dev_password psql -h localhost -U multa -d multa -c "\d income_sources"
```

Expected: таблица существует, колонки совпадают со схемой; `\d workspaces` больше не показывает `expected_income_minor`.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: FAIL в `apps/api` — `assemble.ts` и `app.ts` ещё читают `ws.expectedIncomeMinor`. Это ожидаемо и лечится в Task 6–7; на этом шаге фиксируем только список мест: вывод `tsc` и есть чек-лист.

- [ ] **Step 6: Коммит**

```bash
git add apps/api/src/db/schema/domain.ts apps/api/migrations
git commit -m "feat(api): таблица income_sources, правило выходных на воркспейсе, миграция"
```

---

## Task 5: Zod-схемы источников и ритма

**Files:**
- Modify: `apps/api/src/validation.ts`
- Test: `apps/api/src/validation.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `export const weekendRuleSchema` → `'as-is' | 'before' | 'after'`
  - `export const rhythmSchema` → `{ kind: 'monthly-days'; days: number[] } | { kind: 'every-weeks'; weeks: number; startsOn: string }`
  - `export const incomeSourceSchema` → `{ label, currency, schedule: IncomeSchedule, amount: IncomeAmount, stability, active, startsOn?, endsOn?, sort? }` (суммы — `bigint`)
  - `export const incomeSourcePatchSchema` (частичная)
  - `export const incomeSourceRowSchema` (= `incomeSourceSchema` + `id: string`) — используется и для строк БД
  - `export const onboardingIncomeSchema` → `{ rhythm, weekendRule, sources: [...] }`
  - `patchWorkspaceSchema` дополнена `rhythm?`, `weekendRule?`
  - `anchorsSchema`, `paydaySchema` — **удалены**

- [ ] **Step 1: Написать падающие тесты**

В `apps/api/src/validation.test.ts` удалить блок тестов `paydaySchema` (строки 64–66 и относящиеся к нему импорты) и дописать:

```ts
import {
  incomeSourcePatchSchema,
  incomeSourceRowSchema,
  incomeSourceSchema,
  onboardingIncomeSchema,
  rhythmSchema,
} from './validation.ts';

describe('incomeSourceSchema', () => {
  const base = {
    label: 'Аванс',
    currency: 'rub',
    schedule: { kind: 'monthly-days', days: [10] },
    amount: { kind: 'absolute', amountMinor: '8000000' },
  };

  it('парсит абсолютную сумму в bigint и валюту в верхний регистр', () => {
    const parsed = incomeSourceSchema.parse(base);
    expect(parsed.amount).toEqual({ kind: 'absolute', amountMinor: 8000000n });
    expect(parsed.currency).toBe('RUB');
    expect(parsed.stability).toBe('fixed');
    expect(parsed.active).toBe(true);
  });

  it('парсит процент от оклада', () => {
    const parsed = incomeSourceSchema.parse({
      ...base,
      amount: { kind: 'percent', percent: '40', ofMinor: '20000000' },
    });
    expect(parsed.amount).toEqual({ kind: 'percent', percent: '40', ofMinor: 20000000n });
  });

  it('сортирует и дедупит дни месяца', () => {
    const parsed = incomeSourceSchema.parse({ ...base, schedule: { kind: 'monthly-days', days: [25, 10, 10] } });
    expect(parsed.schedule).toEqual({ kind: 'monthly-days', days: [10, 25] });
  });

  it('отвергает день вне 1..31', () => {
    expect(incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'monthly-days', days: [0] } }).success).toBe(false);
    expect(incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'monthly-days', days: [32] } }).success).toBe(false);
  });

  it('отвергает процент вне (0, 100]', () => {
    const percent = (p: string) => incomeSourceSchema.safeParse({ ...base, amount: { kind: 'percent', percent: p, ofMinor: '1' } }).success;
    expect(percent('0')).toBe(false);
    expect(percent('100.1')).toBe(false);
    expect(percent('100')).toBe(true);
  });

  it('отвергает нецелую сумму и нулевую сумму', () => {
    expect(incomeSourceSchema.safeParse({ ...base, amount: { kind: 'absolute', amountMinor: '80.5' } }).success).toBe(false);
    expect(incomeSourceSchema.safeParse({ ...base, amount: { kind: 'absolute', amountMinor: '0' } }).success).toBe(false);
  });

  it('отвергает неизвестный вид расписания', () => {
    expect(incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'lunar' } }).success).toBe(false);
  });

  it('требует дату в формате YYYY-MM-DD', () => {
    expect(incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'one-off', date: '15.07.2026' } }).success).toBe(false);
    expect(incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'one-off', date: '2026-07-15' } }).success).toBe(true);
  });

  it('принимает irregular без дополнительных полей', () => {
    expect(incomeSourceSchema.safeParse({ ...base, schedule: { kind: 'irregular' } }).success).toBe(true);
  });

  it('rowSchema парсит строку БД вместе с id', () => {
    const parsed = incomeSourceRowSchema.parse({ ...base, id: '11111111-1111-1111-1111-111111111111' });
    expect(parsed.id).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('patchSchema допускает частичное обновление', () => {
    expect(incomeSourcePatchSchema.parse({ label: 'Зарплата' })).toEqual({ label: 'Зарплата' });
  });
});

describe('rhythmSchema', () => {
  it('принимает дни месяца и цикл недель', () => {
    expect(rhythmSchema.parse({ kind: 'monthly-days', days: [10, 25] })).toEqual({ kind: 'monthly-days', days: [10, 25] });
    expect(rhythmSchema.parse({ kind: 'every-weeks', weeks: 2, startsOn: '2026-08-07' })).toEqual({
      kind: 'every-weeks',
      weeks: 2,
      startsOn: '2026-08-07',
    });
  });

  it('не принимает one-off и irregular как ритм', () => {
    expect(rhythmSchema.safeParse({ kind: 'one-off', date: '2026-08-07' }).success).toBe(false);
    expect(rhythmSchema.safeParse({ kind: 'irregular' }).success).toBe(false);
  });

  it('требует дату якоря для цикла недель', () => {
    expect(rhythmSchema.safeParse({ kind: 'every-weeks', weeks: 2 }).success).toBe(false);
  });
});

describe('onboardingIncomeSchema', () => {
  const source = {
    label: 'Зарплата',
    currency: 'RUB',
    schedule: { kind: 'monthly-days', days: [25] },
    amount: { kind: 'absolute', amountMinor: '12000000' },
  };

  it('требует хотя бы один источник', () => {
    expect(onboardingIncomeSchema.safeParse({ rhythm: { kind: 'monthly-days', days: [25] }, sources: [] }).success).toBe(false);
  });

  it('дефолтит правило выходных на before', () => {
    const parsed = onboardingIncomeSchema.parse({ rhythm: { kind: 'monthly-days', days: [25] }, sources: [source] });
    expect(parsed.weekendRule).toBe('before');
  });
});
```

- [ ] **Step 2: Прогнать тесты — должны падать**

Run: `pnpm --filter @multa/api test`
Expected: FAIL — `incomeSourceSchema` не экспортирован.

- [ ] **Step 3: Реализовать схемы**

В `apps/api/src/validation.ts` удалить `anchorsSchema` и `paydaySchema` (строки 22–31) и добавить после `patchWorkspaceSchema`:

```ts
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'ожидается дата YYYY-MM-DD');

/** Процент — десятичная строка в диапазоне (0, 100]. Считается в BigInt, не во float. */
const percent = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^\d+(\.\d+)?$/.test(s), 'процент — десятичное число')
  .refine((s) => Number(s) > 0 && Number(s) <= 100, 'процент в диапазоне (0, 100]');

const positiveMinor = minor.refine((v) => v > 0n, 'сумма должна быть положительной');

const monthDays = z
  .array(z.number().int().min(1).max(31))
  .min(1)
  .max(4)
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));

export const weekendRuleSchema = z.enum(['as-is', 'before', 'after']);

/** Ритм планирования: только регулярные виды — из ритма выводятся границы периодов. */
export const rhythmSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monthly-days'), days: monthDays }),
  z.object({ kind: z.literal('every-weeks'), weeks: z.number().int().min(1).max(12), startsOn: isoDate }),
]);

export const incomeScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monthly-days'), days: monthDays }),
  z.object({ kind: z.literal('every-weeks'), weeks: z.number().int().min(1).max(12), startsOn: isoDate }),
  z.object({ kind: z.literal('one-off'), date: isoDate }),
  z.object({ kind: z.literal('irregular') }),
]);

export const incomeAmountSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absolute'), amountMinor: positiveMinor }),
  z.object({ kind: z.literal('percent'), percent, ofMinor: positiveMinor }),
]);

export const incomeSourceSchema = z.object({
  label: z.string().min(1).max(60),
  currency: ccy,
  schedule: incomeScheduleSchema,
  amount: incomeAmountSchema,
  stability: z.enum(['fixed', 'variable']).default('fixed'),
  active: z.boolean().default(true),
  startsOn: isoDate.optional(),
  endsOn: isoDate.optional(),
  sort: z.number().int().min(0).optional(),
});

/** Та же схема плюс id — ею же разбираются строки БД (jsonb-суммы приходят строками). */
export const incomeSourceRowSchema = incomeSourceSchema.extend({ id: z.string().uuid() });

export const incomeSourcePatchSchema = incomeSourceSchema.partial();

/** Онбординг: ритм + правило выходных + набор источников одним запросом (атомарно). */
export const onboardingIncomeSchema = z.object({
  rhythm: rhythmSchema,
  weekendRule: weekendRuleSchema.default('before'),
  sources: z.array(incomeSourceSchema).min(1),
});
```

`ccy` объявлена ниже в файле (строка 41) — перенести её объявление выше блока онбординга, чтобы не ссылаться на переменную до инициализации:

```ts
const ccy = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase());
```

`patchWorkspaceSchema` расширить:

```ts
export const patchWorkspaceSchema = createWorkspaceSchema.partial().extend({
  rhythm: rhythmSchema.optional(),
  weekendRule: weekendRuleSchema.optional(),
});
```

- [ ] **Step 4: Прогнать тесты**

Run: `pnpm --filter @multa/api test`
Expected: PASS — включая существующие тесты `createWorkspaceSchema` и `categoryBudgetSchema`.

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/validation.ts apps/api/src/validation.test.ts
git commit -m "feat(api): zod-схемы источников дохода и ритма планирования"
```

---

## Task 6: Хранилище и роуты источников

**Files:**
- Create: `apps/api/src/income/store.ts`
- Create: `apps/api/src/routes/income.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: Task 4 (`incomeSources`, `workspaces`), Task 5 (`incomeSourceSchema`, `incomeSourceRowSchema`, `incomeSourcePatchSchema`, `onboardingIncomeSchema`, `patchWorkspaceSchema`), Task 2 (`IncomeSource`).
- Produces:
  - `listSources(workspaceId: string): Promise<IncomeSource[]>`
  - `serializeSource(row: typeof incomeSources.$inferSelect): Record<string, unknown>`
  - `insertSource(workspaceId: string, input: z.infer<typeof incomeSourceSchema>)`
  - `patchSourceById(workspaceId: string, id: string, patch: z.infer<typeof incomeSourcePatchSchema>)`
  - `deleteSourceById(workspaceId: string, id: string): Promise<boolean>`
  - `replaceOnboardingIncome(workspaceId: string, body: z.infer<typeof onboardingIncomeSchema>)`
  - `hasActiveIncome(workspaceId: string): Promise<boolean>`
  - роут `incomeRoute` (Hono), смонтированный на `/v1`

- [ ] **Step 1: Реализовать хранилище**

Создать `apps/api/src/income/store.ts`:

```ts
/**
 * Доступ к income_sources. Границы: bigint ↔ строка (jsonb не умеет bigint),
 * строка БД разбирается той же zod-схемой, что и HTTP-тело — одна правда о форме данных.
 */

import type { IncomeSource } from '@multa/core';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { db } from '../db/client.ts';
import { incomeSources, workspaces } from '../db/schema/domain.ts';
import {
  incomeSourcePatchSchema,
  incomeSourceRowSchema,
  incomeSourceSchema,
  onboardingIncomeSchema,
} from '../validation.ts';

type SourceRow = typeof incomeSources.$inferSelect;
type SourceInput = z.infer<typeof incomeSourceSchema>;
type SourcePatch = z.infer<typeof incomeSourcePatchSchema>;
type OnboardingIncome = z.infer<typeof onboardingIncomeSchema>;

/** Суммы в jsonb — строки-целые: JSON.stringify падает на bigint. */
function amountToJson(amount: SourceInput['amount']): Record<string, unknown> {
  return amount.kind === 'absolute'
    ? { kind: 'absolute', amountMinor: amount.amountMinor.toString() }
    : { kind: 'percent', percent: amount.percent, ofMinor: amount.ofMinor.toString() };
}

/** Строка БД → домен (@multa/core). Валидируем на выходе из БД: jsonb не типизирован. */
function rowToSource(row: SourceRow): IncomeSource {
  return incomeSourceRowSchema.parse({
    id: row.id,
    label: row.label,
    currency: row.currency,
    schedule: row.schedule,
    amount: row.amount,
    stability: row.stability,
    active: row.active,
    ...(row.startsOn ? { startsOn: row.startsOn } : {}),
    ...(row.endsOn ? { endsOn: row.endsOn } : {}),
    ...(row.sort != null ? { sort: row.sort } : {}),
  });
}

/** Строка БД → JSON для клиента (суммы строками). */
export function serializeSource(row: SourceRow): Record<string, unknown> {
  return {
    id: row.id,
    label: row.label,
    currency: row.currency,
    schedule: row.schedule,
    amount: row.amount,
    stability: row.stability,
    active: row.active,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    sort: row.sort,
  };
}

function toValues(workspaceId: string, input: SourceInput) {
  return {
    workspaceId,
    label: input.label,
    currency: input.currency,
    schedule: input.schedule,
    amount: amountToJson(input.amount),
    stability: input.stability,
    active: input.active,
    startsOn: input.startsOn ?? null,
    endsOn: input.endsOn ?? null,
    sort: input.sort ?? 0,
  };
}

export async function listSourceRows(workspaceId: string): Promise<SourceRow[]> {
  return db.select().from(incomeSources).where(eq(incomeSources.workspaceId, workspaceId)).orderBy(incomeSources.sort);
}

/** Источники воркспейса в доменном виде — для сборки плана. */
export async function listSources(workspaceId: string): Promise<IncomeSource[]> {
  return (await listSourceRows(workspaceId)).map(rowToSource);
}

export async function hasActiveIncome(workspaceId: string): Promise<boolean> {
  const rows = await db
    .select({ id: incomeSources.id })
    .from(incomeSources)
    .where(and(eq(incomeSources.workspaceId, workspaceId), eq(incomeSources.active, true)))
    .limit(1);
  return rows.length > 0;
}

export async function insertSource(workspaceId: string, input: SourceInput): Promise<SourceRow> {
  const inserted = await db.insert(incomeSources).values(toValues(workspaceId, input)).returning();
  return inserted[0]!;
}

/** Правка с проверкой принадлежности воркспейсу (изоляция, правило 7). null → не найдено. */
export async function patchSourceById(
  workspaceId: string,
  id: string,
  patch: SourcePatch,
): Promise<SourceRow | null> {
  const updated = await db
    .update(incomeSources)
    .set({
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.currency !== undefined ? { currency: patch.currency } : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.amount !== undefined ? { amount: amountToJson(patch.amount) } : {}),
      ...(patch.stability !== undefined ? { stability: patch.stability } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.startsOn !== undefined ? { startsOn: patch.startsOn } : {}),
      ...(patch.endsOn !== undefined ? { endsOn: patch.endsOn } : {}),
      ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
    })
    .where(and(eq(incomeSources.id, id), eq(incomeSources.workspaceId, workspaceId)))
    .returning();
  return updated[0] ?? null;
}

export async function deleteSourceById(workspaceId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(incomeSources)
    .where(and(eq(incomeSources.id, id), eq(incomeSources.workspaceId, workspaceId)))
    .returning({ id: incomeSources.id });
  return deleted.length > 0;
}

/**
 * Онбординг: ритм + правило выходных + набор источников одной транзакцией.
 * Полусостояния быть не должно: либо шаг пройден целиком, либо ничего не изменилось.
 */
export async function replaceOnboardingIncome(workspaceId: string, body: OnboardingIncome): Promise<SourceRow[]> {
  return db.transaction(async (tx) => {
    await tx
      .update(workspaces)
      .set({ periodAnchors: { ...body.rhythm, weekendRule: body.weekendRule }, paydayWeekendRule: body.weekendRule })
      .where(eq(workspaces.id, workspaceId));
    await tx.delete(incomeSources).where(eq(incomeSources.workspaceId, workspaceId));
    return tx
      .insert(incomeSources)
      .values(body.sources.map((s, i) => ({ ...toValues(workspaceId, s), sort: s.sort ?? i })))
      .returning();
  });
}
```

Обрати внимание на `periodAnchors`: в jsonb ритма правило выходных пишется **внутрь** конфига (`PeriodConfig.weekendRule` из Task 1), чтобы `generatePeriods` получал его без отдельной склейки, и **дублируется** в колонку `payday_weekend_rule` для запросов и настроек. Единственный писатель обоих — эта функция и `PATCH /v1/workspace`, поэтому расхождения не будет.

- [ ] **Step 2: Реализовать роут**

Создать `apps/api/src/routes/income.ts`:

```ts
import { Hono } from 'hono';
import { requireWorkspace, type AppVariables } from '../middleware.ts';
import {
  incomeSourcePatchSchema,
  incomeSourceSchema,
  onboardingIncomeSchema,
} from '../validation.ts';
import {
  deleteSourceById,
  insertSource,
  listSourceRows,
  patchSourceById,
  replaceOnboardingIncome,
  serializeSource,
} from '../income/store.ts';

export const incomeRoute = new Hono<{ Variables: AppVariables }>();
incomeRoute.use('*', requireWorkspace);

incomeRoute.get('/income-sources', async (c) => {
  const ws = c.get('workspace')!;
  return c.json((await listSourceRows(ws.id)).map(serializeSource));
});

incomeRoute.post('/income-sources', async (c) => {
  const ws = c.get('workspace')!;
  const body = incomeSourceSchema.parse(await c.req.json());
  return c.json(serializeSource(await insertSource(ws.id, body)), 201);
});

incomeRoute.patch('/income-sources/:id', async (c) => {
  const ws = c.get('workspace')!;
  const patch = incomeSourcePatchSchema.parse(await c.req.json());
  const row = await patchSourceById(ws.id, c.req.param('id'), patch);
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(serializeSource(row));
});

incomeRoute.delete('/income-sources/:id', async (c) => {
  const ws = c.get('workspace')!;
  const removed = await deleteSourceById(ws.id, c.req.param('id'));
  if (!removed) return c.json({ error: 'not_found' }, 404);
  return c.body(null, 204);
});

/** Шаг онбординга «когда приходят деньги»: ритм и источники за один атомарный запрос. */
incomeRoute.post('/onboarding/income', async (c) => {
  const ws = c.get('workspace')!;
  const body = onboardingIncomeSchema.parse(await c.req.json());
  const rows = await replaceOnboardingIncome(ws.id, body);
  return c.json({ sources: rows.map(serializeSource) }, 201);
});
```

- [ ] **Step 3: Подключить роут и починить `app.ts`**

В `apps/api/src/app.ts`:

1. Импорт `paydaySchema` удалить, добавить `import { incomeRoute } from './routes/income.ts';` и `import { hasActiveIncome } from './income/store.ts';`.
2. `serializeWorkspace` (строки 27–36) заменить:

```ts
/** bigint нельзя сериализовать в JSON — отдаём minor-суммы строками. */
function serializeWorkspace(ws: Workspace) {
  return {
    id: ws.id,
    baseCurrency: ws.baseCurrency,
    timezone: ws.timezone,
    locale: ws.locale,
    // Ритм планирования (PeriodConfig) — задаёт границы периодов, не суммы.
    rhythm: ws.periodAnchors,
    weekendRule: ws.paydayWeekendRule,
  };
}
```

3. `/v1/me` (строки 59–67) — гейт онбординга теперь «есть ритм И есть активный источник»:

```ts
app.get('/v1/me', requireAuth, async (c) => {
  const user = c.get('user')!;
  const rows = await db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).limit(1);
  const ws = rows[0];
  const onboardingComplete = ws ? ws.periodAnchors != null && (await hasActiveIncome(ws.id)) : false;
  return c.json({
    user: { id: user.id, email: user.email, name: user.name },
    workspace: ws ? serializeWorkspace(ws) : null,
    onboardingComplete,
  });
});
```

4. `PATCH /v1/workspace` — добавить ритм и правило выходных в `set`:

```ts
  const updated = await db
    .update(workspaces)
    .set({
      ...(body.baseCurrency ? { baseCurrency: body.baseCurrency.toUpperCase() } : {}),
      ...(body.timezone ? { timezone: body.timezone } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
      ...(body.weekendRule ? { paydayWeekendRule: body.weekendRule } : {}),
      ...(body.rhythm
        ? { periodAnchors: { ...body.rhythm, weekendRule: body.weekendRule ?? ws.paydayWeekendRule } }
        : {}),
    })
    .where(eq(workspaces.id, ws.id))
    .returning();
```

5. Удалить хендлер `POST /v1/onboarding/payday` целиком (строки 106–115).
6. Смонтировать роут рядом с остальными: `app.route('/v1', incomeRoute);`

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: остаётся только ошибка в `apps/api/src/plan/assemble.ts` (`ws.expectedIncomeMinor` не существует) — она лечится в Task 7. Ошибок в `app.ts`, `routes/income.ts`, `income/store.ts` быть не должно.

- [ ] **Step 5: Коммит**

```bash
git add apps/api/src/income apps/api/src/routes/income.ts apps/api/src/app.ts
git commit -m "feat(api): CRUD источников дохода и атомарный шаг онбординга"
```

---

## Task 7: Доход периода в сборке плана

**Files:**
- Modify: `apps/api/src/plan/assemble.ts`

**Interfaces:**
- Consumes: Task 2–3 (`incomeEventsIn`, `expectedIncomeForPeriod`, `percentOfMinor`, `IncomeSource`), Task 6 (`listSources`).
- Produces:
  - `PlanDto.income: { events: IncomeEventDto[]; unresolved: IncomeUnresolvedDto[] }`
  - `PlanDto.incomeMinor` — теперь доход **этого** периода, а не скаляр воркспейса

- [ ] **Step 1: Заменить источник дохода в сборке**

В `apps/api/src/plan/assemble.ts`:

1. Импорт из `@multa/core` расширить: `expectedIncomeForPeriod, incomeEventsIn, percentOfMinor, type IncomeSource, type WeekendRule`.
2. Удалить локальный `pctOfMinor` (строки 148–154) и заменить его вызов в `resolveObligations` (строка 216) на `percentOfMinor(incomeMinor, e.ruleValue)` — процент конверта считается тем же хелпером, что и процент выплаты, одной реализацией.
3. Добавить загрузку курсов и расчёт дохода периода:

```ts
export interface IncomeEventDto {
  sourceId: string;
  label: string;
  date: string;
  amountMinor: string;
  currency: string;
}

export interface IncomeUnresolvedDto extends IncomeEventDto {
  reason: 'rate_unavailable';
}

/**
 * Доход периода: события источников внутри [startsOn, endsOn), приведённые к базовой валюте.
 * Курсы подгружаются одним пакетом по валютам событий, чтобы ядро осталось чистым и синхронным.
 */
async function incomeForPeriod(
  ws: Workspace,
  sources: readonly IncomeSource[],
  period: PayPeriod,
  asOf: string,
): Promise<{ incomeMinor: bigint; events: IncomeEventDto[]; unresolved: IncomeUnresolvedDto[] }> {
  const events = incomeEventsIn(sources, period, ws.paydayWeekendRule as WeekendRule);
  const foreign = [...new Set(events.map((e) => e.currency).filter((ccy) => ccy !== ws.baseCurrency))];
  const snapshots = await Promise.all(foreign.map(async (ccy) => [ccy, await getRate(ccy, ws.baseCurrency, asOf)] as const));
  const rates = new Map(snapshots);
  const total = expectedIncomeForPeriod(events, ws.baseCurrency, (m) => {
    const snap = rates.get(m.currency);
    return snap ? convert(m, snap) : null;
  });
  const toDto = (e: (typeof events)[number]): IncomeEventDto => ({
    sourceId: e.sourceId,
    label: e.label,
    date: e.date,
    amountMinor: e.amountMinor.toString(),
    currency: e.currency,
  });
  return {
    incomeMinor: total.incomeMinor,
    events: events.map(toDto),
    unresolved: total.unresolved.map((e) => ({ ...toDto(e), reason: 'rate_unavailable' as const })),
  };
}
```

4. `assembleForPeriod` — принять источники и считать доход по периоду. Заменить строки 305–312:

```ts
async function assembleForPeriod(
  ws: Workspace,
  sources: readonly IncomeSource[],
  period: PayPeriod,
  asOf: string,
): Promise<PlanDto> {
  const income = await incomeForPeriod(ws, sources, period, asOf);
  const incomeMinor = income.incomeMinor;
  const { id: periodId, created } = await ensurePeriodRow(ws, period, incomeMinor);
  // Перенос — только при рождении периода: очистку бюджетов в существующем периоде не затираем.
  if (created) await carryOverCategories(ws, periodId, period.startsOn);
  // План — проекция «на момент сборки»: конвертируем по курсу на asOf (сегодня), а не на
  // дату старта периода. Иммутабельный снапшот курса важен для транзакций-фактов, не для плана.
  const { resolved, unresolved } = await resolveObligations(ws, incomeMinor, asOf);
```

5. В `PlanDto` добавить поле и вернуть его:

```ts
export interface PlanDto {
  // …существующие поля…
  allocations: PlanAllocationDto[];
  unresolved: UnresolvedItem[];
  /** Разбивка ожидаемого дохода периода по источникам (для дашборда и чеклиста дня выплаты). */
  income: { events: IncomeEventDto[]; unresolved: IncomeUnresolvedDto[] };
}
```

в `return` `assembleForPeriod` добавить последней строкой: `income: { events: income.events, unresolved: income.unresolved },`

6. `currentPeriod` и `getCurrentPlan` — источники грузятся один раз, отсутствие активных источников = незавершённый онбординг:

```ts
/** Текущий период по ритму воркспейса. Бросает при незавершённом онбординге. */
function currentPeriod(ws: Workspace, asOf: string): PayPeriod {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const [current] = generatePeriods(ws.periodAnchors as PeriodConfig, asOf, 2);
  if (!current) throw new Error('period_undeterminable');
  return current;
}

/**
 * План текущего периода: гарантирует и собирает текущий + следующий периоды,
 * возвращает DTO текущего. Бросает, если онбординг не завершён (нет ритма или источников).
 */
export async function getCurrentPlan(ws: Workspace, asOf: string): Promise<PlanDto> {
  if (!ws.periodAnchors) throw new Error('onboarding_incomplete');
  const sources = await listSources(ws.id);
  if (sources.filter((s) => s.active).length === 0) throw new Error('onboarding_incomplete');
  const anchors = ws.periodAnchors as PeriodConfig;
  const [current, next] = generatePeriods(anchors, asOf, 2);
  if (!current) throw new Error('period_undeterminable');
  const dto = await assembleForPeriod(ws, sources, current, asOf);
  // Следующий период тоже собираем «вперёд» (DoD), но в ответ не кладём.
  if (next) await assembleForPeriod(ws, sources, next, asOf);
  return dto;
}
```

7. `setCategoryBudget` (строка 411) — `ensurePeriodRow` больше не может брать доход из воркспейса. Заменить на пересчёт по источникам:

```ts
  const period = currentPeriod(ws, asOf);
  const sources = await listSources(ws.id);
  const { incomeMinor } = await incomeForPeriod(ws, sources, period, asOf);
  const { id: periodId } = await ensurePeriodRow(ws, period, incomeMinor);
```

8. Импорт `listSources` добавить: `import { listSources } from '../income/store.ts';`

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS во всех воркспейсах (`apps/web` ещё ссылается на старый DTO — если tsc ругается на `expectedIncomeMinor`/`periodAnchors` в web, это Task 8–11; сюда добавляй только правки api).

- [ ] **Step 3: Проверить фактом — план двух периодов различается**

Смоук-скрипт (одноразовый, в `apps/api/`, чтобы резолвились bare-импорты). Создать `apps/api/smoke-income.ts`:

```ts
import { db } from './src/db/client.ts';
import { incomeSources, workspaces } from './src/db/schema/domain.ts';
import { user } from './src/db/schema/auth.ts';
import { getCurrentPlan } from './src/plan/assemble.ts';
import { eq } from 'drizzle-orm';

const owner = (await db.select().from(user).limit(1))[0]!;
const [ws] = await db
  .insert(workspaces)
  .values({ ownerId: owner.id, baseCurrency: 'RUB', periodAnchors: { kind: 'monthly-days', days: [10, 25], weekendRule: 'as-is' }, paydayWeekendRule: 'as-is' })
  .returning();
await db.insert(incomeSources).values([
  { workspaceId: ws!.id, label: 'Аванс', currency: 'RUB', schedule: { kind: 'monthly-days', days: [10] }, amount: { kind: 'absolute', amountMinor: '8000000' } },
  { workspaceId: ws!.id, label: 'Зарплата', currency: 'RUB', schedule: { kind: 'monthly-days', days: [25] }, amount: { kind: 'absolute', amountMinor: '12000000' } },
  { workspaceId: ws!.id, label: 'Подработка', currency: 'RUB', schedule: { kind: 'every-weeks', weeks: 1, startsOn: '2026-07-03' }, amount: { kind: 'absolute', amountMinor: '1500000' }, stability: 'variable' },
]);

const first = await getCurrentPlan(ws!, '2026-07-12');
const second = await getCurrentPlan(ws!, '2026-07-27');
console.log('период', first.period, 'доход', first.incomeMinor, 'событий', first.income.events.length);
console.log('период', second.period, 'доход', second.incomeMinor, 'событий', second.income.events.length);

await db.delete(workspaces).where(eq(workspaces.id, ws!.id)); // cascade уносит источники и периоды
```

Run:

```bash
cd apps/api && DATABASE_URL='postgres://multa:multa_dev_password@localhost:5432/multa' BETTER_AUTH_SECRET='dev_secret_at_least_16_chars_xx' npx tsx smoke-income.ts
```

Expected: два периода `10→25` и `25→10` с **разным** доходом (аванс + 2 подработки против зарплаты + 2 подработки). Затем удалить скрипт: `rm apps/api/smoke-income.ts`.

- [ ] **Step 4: Прогнать тесты и коммит**

```bash
pnpm --filter @multa/api test && pnpm --filter @multa/core test
git add apps/api/src/plan/assemble.ts
git commit -m "feat(api): доход периода считается по событиям источников"
```

---

## Task 8: Строки интерфейса (ru + en)

**Files:**
- Modify: `packages/i18n/src/en.ts`, `packages/i18n/src/ru.ts`
- Test: `packages/i18n/src/i18n.test.ts`

**Interfaces:**
- Consumes: ничего.
- Produces: ключи `income.*`, `settings.rhythm`, `settings.sources`; удалены `onboarding.payday.preset.*`, `onboarding.payday.expectedAmount`, `settings.income`, `settings.anchors`.

- [ ] **Step 1: Написать падающий тест**

Дописать в `packages/i18n/src/i18n.test.ts`:

```ts
describe('ключи шага дохода', () => {
  it('есть в обеих локалях', () => {
    expect(translate('ru', 'income.rhythm.title')).toBe('Как часто приходят деньги?');
    expect(translate('en', 'income.rhythm.title')).toBe('How often does money arrive?');
  });

  it('превью дат интерполирует список', () => {
    expect(translate('ru', 'income.rhythm.preview', { dates: '10 авг · 25 авг' })).toBe(
      'Ближайшие: 10 авг · 25 авг',
    );
  });
});
```

- [ ] **Step 2: Прогнать — падает**

Run: `pnpm --filter @multa/i18n test`
Expected: FAIL — ключа `income.rhythm.title` нет (тип `TranslationKey` его не знает, tsc тоже ругнётся).

- [ ] **Step 3: Добавить ключи в `en.ts`**

Заменить блок «Онбординг — шаг 2» (строки 21–27) на:

```ts
  // Онбординг — шаг 2: ритм планирования + источники дохода
  'onboarding.payday.title': 'When does the money come?',
  'onboarding.payday.subtitle': 'We plan by your real payout dates, not the calendar month.',
  'income.rhythm.title': 'How often does money arrive?',
  'income.rhythm.hint': 'This sets the stretch you plan for — from one payout to the next.',
  'income.rhythm.twiceMonthly': 'Twice a month',
  'income.rhythm.monthly': 'Once a month',
  'income.rhythm.everyWeeks': 'Every N weeks',
  'income.rhythm.days': 'Days',
  'income.rhythm.day': 'Day',
  'income.rhythm.weeks': 'Weeks',
  'income.rhythm.anchorDate': 'Date of the last or next payout',
  'income.rhythm.preview': 'Next: {dates}',
  'income.weekend.label': 'If the payout lands on a weekend',
  'income.weekend.asIs': 'pay as-is',
  'income.weekend.before': 'previous business day',
  'income.weekend.after': 'next business day',
  'income.amounts.title': 'How much arrives?',
  'income.amounts.hint': 'Lower estimate for anything that floats — an inflated daily number is the costliest error here.',
  'income.amounts.label': 'Label',
  'income.amounts.day': 'Day',
  'income.amounts.amount': 'Amount',
  'income.amounts.percentToggle': 'as % of gross',
  'income.amounts.gross': 'Gross',
  'income.amounts.percent': '%',
  'income.amounts.percentSum': 'Percentages add up to {sum}% of {gross}',
  'income.amounts.add': 'Add payout',
  'income.amounts.mismatch': 'Period starts on {date}, but nothing arrives that day.',
  'income.extra.title': 'Any other income?',
  'income.extra.hint': 'Side gig, one-off fee, or irregular — optional, can be added later.',
  'income.extra.sideGig': 'Side gig, weekly',
  'income.extra.oneOff': 'One-off fee',
  'income.extra.irregular': 'Comes irregularly',
  'income.extra.irregularNote': 'Irregular income stays out of the plan — only recorded as fact.',
  'income.variable': 'floats',
```

Также заменить ключи настроек (`settings.income`, `settings.anchors`) на:

```ts
  'settings.rhythm': 'Planning rhythm',
  'settings.sources': 'Income sources',
```

- [ ] **Step 4: Зеркально в `ru.ts`**

```ts
  // Онбординг — шаг 2: ритм планирования + источники дохода
  'onboarding.payday.title': 'Когда приходят деньги?',
  'onboarding.payday.subtitle': 'Планируем по датам выплат, а не по календарному месяцу.',
  'income.rhythm.title': 'Как часто приходят деньги?',
  'income.rhythm.hint': 'Это задаёт отрезок, на который планируем — от выплаты до выплаты.',
  'income.rhythm.twiceMonthly': 'Два раза в месяц',
  'income.rhythm.monthly': 'Раз в месяц',
  'income.rhythm.everyWeeks': 'Цикл в N недель',
  'income.rhythm.days': 'Числа',
  'income.rhythm.day': 'Число',
  'income.rhythm.weeks': 'Недель',
  'income.rhythm.anchorDate': 'Дата последней или ближайшей выплаты',
  'income.rhythm.preview': 'Ближайшие: {dates}',
  'income.weekend.label': 'Если выплата попала на выходной',
  'income.weekend.asIs': 'приходит как есть',
  'income.weekend.before': 'в предшествующий рабочий день',
  'income.weekend.after': 'в следующий рабочий день',
  'income.amounts.title': 'Сколько приходит?',
  'income.amounts.hint': 'Для плавающего ставь нижнюю оценку — завышенная цифра дня обходится дороже всего.',
  'income.amounts.label': 'Метка',
  'income.amounts.day': 'Число',
  'income.amounts.amount': 'Сумма',
  'income.amounts.percentToggle': 'процентом от оклада',
  'income.amounts.gross': 'Оклад',
  'income.amounts.percent': '%',
  'income.amounts.percentSum': 'Проценты дают {sum}% от {gross}',
  'income.amounts.add': 'Добавить выплату',
  'income.amounts.mismatch': 'Период начинается {date}, но в этот день ничего не приходит.',
  'income.extra.title': 'Есть ещё источники дохода?',
  'income.extra.hint': 'Подработка, разовый гонорар или «когда как» — можно пропустить и добавить позже.',
  'income.extra.sideGig': 'Подработка, каждую неделю',
  'income.extra.oneOff': 'Разовый гонорар',
  'income.extra.irregular': 'Приходит когда как',
  'income.extra.irregularNote': 'Нерегулярный доход в план не идёт — только в факт.',
  'income.variable': 'плавает',
  'settings.rhythm': 'Ритм планирования',
  'settings.sources': 'Источники дохода',
```

- [ ] **Step 5: Прогнать тесты**

Run: `pnpm --filter @multa/i18n test && pnpm typecheck`
Expected: тесты PASS; `tsc` в `apps/web` покажет ошибки на удалённых ключах в `Onboarding.tsx`/`Settings.tsx`/`paydayPresets.ts` — это список работ Task 9–11.

- [ ] **Step 6: Коммит**

```bash
git add packages/i18n/src
git commit -m "feat(i18n): строки шага дохода, удалены ключи пресетов выплат"
```

---

## Task 9: DTO, хуки и чистые хелперы формы

**Files:**
- Modify: `apps/web/src/lib/queries.ts`, `apps/web/src/App.tsx`
- Create: `apps/web/src/lib/income.ts`, `apps/web/src/lib/income.test.ts`

**Interfaces:**
- Consumes: Task 6–7 (форма ответов API), Task 1–3 (`generatePeriods`, `incomeEventsIn`, `rhythmMismatches`).
- Produces:
  - `WorkspaceDto { id, baseCurrency, timezone, locale, rhythm, weekendRule }`, `MeDto { user, workspace, onboardingComplete }`
  - `IncomeSourceDto`, `useIncomeSources()`, `useSaveOnboardingIncome()`, `useCreateIncomeSource()`, `useDeleteIncomeSource()`
  - `apps/web/src/lib/income.ts`:
    - `type RhythmKind = 'twiceMonthly' | 'monthly' | 'everyWeeks'`
    - `interface RhythmForm { kind: RhythmKind; days: number[]; weeks: number; anchorDate: string; weekendRule: WeekendRule }`
    - `interface PayoutForm { label: string; day: number; amount: string; percent: string }`
    - `rhythmToConfig(form: RhythmForm): PeriodConfig`
    - `previewDates(form: RhythmForm, from: string, count?: number): string[]`
    - `payoutsToSources(payouts: PayoutForm[], opts: { currency: string; usePercent: boolean; gross: string }): SourcePayload[]`
    - `percentSum(payouts: PayoutForm[]): number`

- [ ] **Step 1: Написать падающие тесты хелперов**

Создать `apps/web/src/lib/income.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { payoutsToSources, percentSum, previewDates, rhythmToConfig, type RhythmForm } from './income.ts';

const twiceMonthly: RhythmForm = {
  kind: 'twiceMonthly',
  days: [10, 25],
  weeks: 2,
  anchorDate: '2026-08-07',
  weekendRule: 'as-is',
};

describe('rhythmToConfig', () => {
  it('два раза в месяц → monthly-days с обоими числами', () => {
    expect(rhythmToConfig(twiceMonthly)).toEqual({
      kind: 'monthly-days',
      days: [10, 25],
      weekendRule: 'as-is',
    });
  });

  it('раз в месяц → monthly-days с одним числом', () => {
    expect(rhythmToConfig({ ...twiceMonthly, kind: 'monthly', days: [5] })).toEqual({
      kind: 'monthly-days',
      days: [5],
      weekendRule: 'as-is',
    });
  });

  it('цикл недель → every-weeks от указанной даты, а не от сегодня', () => {
    expect(rhythmToConfig({ ...twiceMonthly, kind: 'everyWeeks' })).toEqual({
      kind: 'every-weeks',
      weeks: 2,
      startsOn: '2026-08-07',
      weekendRule: 'as-is',
    });
  });
});

describe('previewDates', () => {
  it('показывает ближайшие даты выплат для «два раза в месяц»', () => {
    expect(previewDates(twiceMonthly, '2026-08-01', 3)).toEqual(['2026-08-10', '2026-08-25', '2026-09-10']);
  });

  it('для цикла в две недели даты плывут по календарю', () => {
    expect(previewDates({ ...twiceMonthly, kind: 'everyWeeks' }, '2026-08-01', 3)).toEqual([
      '2026-08-07',
      '2026-08-21',
      '2026-09-04',
    ]);
  });

  it('учитывает правило выходных', () => {
    // 25 июля 2026 — суббота.
    expect(previewDates({ ...twiceMonthly, kind: 'monthly', days: [25], weekendRule: 'before' }, '2026-07-01', 1)).toEqual([
      '2026-07-24',
    ]);
  });
});

describe('payoutsToSources', () => {
  const payouts = [
    { label: 'Аванс', day: 10, amount: '80000', percent: '40' },
    { label: 'Зарплата', day: 25, amount: '120000', percent: '60' },
  ];

  it('абсолютные суммы → источники с monthly-days и minor units', () => {
    const sources = payoutsToSources(payouts, { currency: 'RUB', usePercent: false, gross: '' });
    expect(sources).toEqual([
      { label: 'Аванс', currency: 'RUB', schedule: { kind: 'monthly-days', days: [10] }, amount: { kind: 'absolute', amountMinor: '8000000' }, stability: 'fixed', active: true, sort: 0 },
      { label: 'Зарплата', currency: 'RUB', schedule: { kind: 'monthly-days', days: [25] }, amount: { kind: 'absolute', amountMinor: '12000000' }, stability: 'fixed', active: true, sort: 1 },
    ]);
  });

  it('проценты → amount percent с окладом в minor units', () => {
    const sources = payoutsToSources(payouts, { currency: 'RUB', usePercent: true, gross: '200000' });
    expect(sources[0]!.amount).toEqual({ kind: 'percent', percent: '40', ofMinor: '20000000' });
  });

  it('пропускает выплаты без валидной суммы', () => {
    const sources = payoutsToSources([{ label: 'Аванс', day: 10, amount: '', percent: '' }], {
      currency: 'RUB',
      usePercent: false,
      gross: '',
    });
    expect(sources).toEqual([]);
  });
});

describe('percentSum', () => {
  it('складывает проценты выплат', () => {
    expect(percentSum([
      { label: 'a', day: 10, amount: '', percent: '40' },
      { label: 'b', day: 25, amount: '', percent: '60' },
    ])).toBe(100);
  });

  it('пустой процент считает нулём', () => {
    expect(percentSum([{ label: 'a', day: 10, amount: '', percent: '' }])).toBe(0);
  });
});
```

- [ ] **Step 2: Прогнать — падает**

Run: `pnpm --filter @multa/web test income`
Expected: FAIL — `Cannot find module './income.ts'`.

- [ ] **Step 3: Реализовать хелперы**

Создать `apps/web/src/lib/income.ts`:

```ts
/**
 * Чистые хелперы формы дохода: состояние формы → payload API, превью реальных дат.
 * Доменной логики в компонентах не держим (железное правило 4) — даты считает @multa/core
 * теми же функциями, что и сервер, поэтому превью не может расходиться с планом.
 */

import { fromMajor, generatePeriods, type PeriodConfig, type WeekendRule } from '@multa/core';

export type RhythmKind = 'twiceMonthly' | 'monthly' | 'everyWeeks';

export interface RhythmForm {
  kind: RhythmKind;
  days: number[];
  weeks: number;
  anchorDate: string;
  weekendRule: WeekendRule;
}

export interface PayoutForm {
  label: string;
  day: number;
  amount: string;
  percent: string;
}

export interface SourcePayload {
  label: string;
  currency: string;
  schedule: unknown;
  amount: unknown;
  stability: 'fixed' | 'variable';
  active: boolean;
  sort: number;
}

/** Форма ритма → PeriodConfig ядра. Дата якоря для цикла недель — ввод пользователя, не «сегодня». */
export function rhythmToConfig(form: RhythmForm): PeriodConfig {
  if (form.kind === 'everyWeeks') {
    return { kind: 'every-weeks', weeks: form.weeks, startsOn: form.anchorDate, weekendRule: form.weekendRule };
  }
  const days = form.kind === 'monthly' ? form.days.slice(0, 1) : form.days;
  return { kind: 'monthly-days', days: [...new Set(days)].sort((a, b) => a - b), weekendRule: form.weekendRule };
}

/**
 * Ближайшие даты выплат, которые реально сгенерит планировщик.
 * Границы периодов и есть даты выплат; первый период содержит `from` и начинается раньше него,
 * поэтому берём все границы и отбрасываем прошедшие — превью про будущее, а не про историю.
 */
export function previewDates(form: RhythmForm, from: string, count = 3): string[] {
  const periods = generatePeriods(rhythmToConfig(form), from, count + 2);
  const boundaries = periods.flatMap((p) => [p.startsOn, p.endsOn]);
  return [...new Set(boundaries)].filter((d) => d >= from).slice(0, count);
}

/** major-строка → minor units или null (не подставляем 0 молча). */
function toMinor(value: string, currency: string): string | null {
  const s = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    return fromMajor(s, currency).minor.toString();
  } catch {
    return null;
  }
}

/** Выплаты формы → источники дохода. Невалидные строки отбрасываются, а не превращаются в нули. */
export function payoutsToSources(
  payouts: readonly PayoutForm[],
  opts: { currency: string; usePercent: boolean; gross: string },
): SourcePayload[] {
  const grossMinor = opts.usePercent ? toMinor(opts.gross, opts.currency) : null;
  const out: SourcePayload[] = [];
  for (const payout of payouts) {
    const label = payout.label.trim();
    if (!label) continue;
    let amount: unknown = null;
    if (opts.usePercent) {
      const pct = payout.percent.trim().replace(',', '.');
      if (!grossMinor || !/^\d+(\.\d+)?$/.test(pct) || Number(pct) <= 0 || Number(pct) > 100) continue;
      amount = { kind: 'percent', percent: pct, ofMinor: grossMinor };
    } else {
      const amountMinor = toMinor(payout.amount, opts.currency);
      if (!amountMinor || amountMinor === '0') continue;
      amount = { kind: 'absolute', amountMinor };
    }
    out.push({
      label,
      currency: opts.currency,
      schedule: { kind: 'monthly-days', days: [payout.day] },
      amount,
      stability: 'fixed',
      active: true,
      sort: out.length,
    });
  }
  return out;
}

/** Сумма процентов выплат — для информационной подсказки (жёсткой валидации нет). */
export function percentSum(payouts: readonly PayoutForm[]): number {
  return payouts.reduce((acc, p) => {
    const pct = Number(p.percent.trim().replace(',', '.'));
    return acc + (Number.isFinite(pct) ? pct : 0);
  }, 0);
}
```

- [ ] **Step 4: Прогнать тесты хелперов**

Run: `pnpm --filter @multa/web test income`
Expected: PASS — 10 тестов.

- [ ] **Step 5: Обновить DTO и хуки**

В `apps/web/src/lib/queries.ts`:

```ts
export interface WorkspaceDto {
  id: string;
  baseCurrency: string;
  timezone: string;
  locale: 'ru' | 'en';
  /** Ритм планирования (PeriodConfig). Задаёт границы периодов, не суммы. */
  rhythm: unknown | null;
  weekendRule: 'as-is' | 'before' | 'after';
}

export interface MeDto {
  user: { id: string; email: string; name: string } | null;
  workspace: WorkspaceDto | null;
  /** Есть ритм и хотя бы один активный источник дохода. */
  onboardingComplete: boolean;
}

export interface IncomeSourceDto {
  id: string;
  label: string;
  currency: string;
  schedule: unknown;
  amount: unknown;
  stability: 'fixed' | 'variable';
  active: boolean;
  startsOn: string | null;
  endsOn: string | null;
  sort: number;
}

export interface IncomeEventDto {
  sourceId: string;
  label: string;
  date: string;
  amountMinor: string;
  currency: string;
}
```

В `PlanDto` добавить поле:

```ts
  income: { events: IncomeEventDto[]; unresolved: (IncomeEventDto & { reason: 'rate_unavailable' })[] };
```

Хуки в конец файла:

```ts
// --- Источники дохода ---

export function useIncomeSources(enabled = true) {
  return useQuery({
    queryKey: ['income-sources'],
    enabled,
    retry: false,
    queryFn: () => api<IncomeSourceDto[]>('/v1/income-sources'),
  });
}

/** Шаг онбординга: ритм + источники одним запросом. 'me' инвалидирует вызывающий. */
export function useSaveOnboardingIncome() {
  return useMutation({
    mutationFn: (body: unknown) =>
      api('/v1/onboarding/income', { method: 'POST', body: JSON.stringify(body) }),
  });
}

export function useCreateIncomeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) =>
      api<IncomeSourceDto>('/v1/income-sources', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['income-sources'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}

export function useDeleteIncomeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/v1/income-sources/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['income-sources'] });
      void qc.invalidateQueries({ queryKey: ['plan'] });
    },
  });
}
```

- [ ] **Step 6: Гейт онбординга в `App.tsx`**

Заменить строку 22:

```tsx
  if (!me.onboardingComplete) return <Onboarding workspace={me.workspace} />;
```

- [ ] **Step 7: Коммит**

```bash
pnpm --filter @multa/web test
git add apps/web/src/lib apps/web/src/App.tsx
git commit -m "feat(web): DTO источников дохода, хуки и чистые хелперы формы"
```

---

## Task 10: Шаг «Когда приходят деньги»

**Files:**
- Create: `apps/web/src/components/RhythmPicker.tsx`, `apps/web/src/components/IncomeSourceList.tsx`
- Modify: `apps/web/src/screens/Onboarding.tsx`
- Delete: `apps/web/src/lib/paydayPresets.ts`

**Interfaces:**
- Consumes: Task 8 (ключи `income.*`), Task 9 (`RhythmForm`, `PayoutForm`, `previewDates`, `payoutsToSources`, `percentSum`, `rhythmToConfig`, `useSaveOnboardingIncome`).
- Produces:
  - `<RhythmPicker value={RhythmForm} onChange={(next: RhythmForm) => void} />`
  - `<IncomeSourceList payouts={PayoutForm[]} usePercent gross currency onChange={...} onToggglePercent={...} onGrossChange={...} />`

- [ ] **Step 1: Реализовать `RhythmPicker`**

Создать `apps/web/src/components/RhythmPicker.tsx`:

```tsx
import { useI18n } from '../lib/i18n.tsx';
import { previewDates, type RhythmForm, type RhythmKind } from '../lib/income.ts';
import type { WeekendRule } from '@multa/core';

const KINDS: { kind: RhythmKind; key: 'income.rhythm.twiceMonthly' | 'income.rhythm.monthly' | 'income.rhythm.everyWeeks' }[] = [
  { kind: 'twiceMonthly', key: 'income.rhythm.twiceMonthly' },
  { kind: 'monthly', key: 'income.rhythm.monthly' },
  { kind: 'everyWeeks', key: 'income.rhythm.everyWeeks' },
];

const WEEKEND_RULES: { rule: WeekendRule; key: 'income.weekend.asIs' | 'income.weekend.before' | 'income.weekend.after' }[] = [
  { rule: 'before', key: 'income.weekend.before' },
  { rule: 'after', key: 'income.weekend.after' },
  { rule: 'as-is', key: 'income.weekend.asIs' },
];

/** Число 1..31 из строки ввода; вне диапазона — прежнее значение (без молчаливой подмены). */
function clampDay(raw: string, fallback: number): number {
  const n = Number(raw.replace(/\D/g, ''));
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : fallback;
}

export function RhythmPicker({
  value,
  onChange,
  today,
}: {
  value: RhythmForm;
  onChange: (next: RhythmForm) => void;
  today: string;
}) {
  const { t, locale } = useI18n();
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const dates = previewDates(value, today, 3)
    .map((iso) => fmt.format(new Date(`${iso}T00:00:00Z`)))
    .join(' · ');

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('income.rhythm.title')}</label>
        <div className="row">
          {KINDS.map(({ kind, key }) => (
            <button
              key={kind}
              type="button"
              className="chip"
              aria-pressed={value.kind === kind}
              onClick={() => onChange({ ...value, kind })}
            >
              {t(key)}
            </button>
          ))}
        </div>
        <p className="dim micro" style={{ marginTop: 8 }}>{t('income.rhythm.hint')}</p>
      </div>

      {value.kind === 'twiceMonthly' && (
        <div className="row">
          <label className="micro">{t('income.rhythm.days')}</label>
          {[0, 1].map((i) => (
            <input
              key={i}
              className="field mono"
              style={{ width: 64 }}
              inputMode="numeric"
              value={value.days[i] ?? ''}
              onChange={(e) => {
                const days = [...value.days];
                days[i] = clampDay(e.target.value, value.days[i] ?? 1);
                onChange({ ...value, days });
              }}
            />
          ))}
        </div>
      )}

      {value.kind === 'monthly' && (
        <div className="row">
          <label className="micro">{t('income.rhythm.day')}</label>
          <input
            className="field mono"
            style={{ width: 64 }}
            inputMode="numeric"
            value={value.days[0] ?? ''}
            onChange={(e) => onChange({ ...value, days: [clampDay(e.target.value, value.days[0] ?? 1)] })}
          />
        </div>
      )}

      {value.kind === 'everyWeeks' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="row">
            <label className="micro">{t('income.rhythm.weeks')}</label>
            <input
              className="field mono"
              style={{ width: 64 }}
              inputMode="numeric"
              value={value.weeks}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                onChange({ ...value, weeks: n >= 1 && n <= 12 ? n : value.weeks });
              }}
            />
          </div>
          <div>
            <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('income.rhythm.anchorDate')}</label>
            <input
              className="field mono"
              type="date"
              value={value.anchorDate}
              onChange={(e) => onChange({ ...value, anchorDate: e.target.value })}
            />
          </div>
        </div>
      )}

      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('income.weekend.label')}</label>
        <div className="row">
          {WEEKEND_RULES.map(({ rule, key }) => (
            <button
              key={rule}
              type="button"
              className="chip"
              aria-pressed={value.weekendRule === rule}
              onClick={() => onChange({ ...value, weekendRule: rule })}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      <div className="note-band mono">{t('income.rhythm.preview', { dates })}</div>
    </div>
  );
}
```

`useI18n()` отдаёт `{ locale, setLocale, t }` ([i18n.tsx:22](../../../apps/web/src/lib/i18n.tsx#L22)), поэтому `locale` для `Intl.DateTimeFormat` берётся оттуда — пропом прокидывать не нужно.

- [ ] **Step 2: Реализовать `IncomeSourceList`**

Создать `apps/web/src/components/IncomeSourceList.tsx`:

```tsx
import { useI18n } from '../lib/i18n.tsx';
import { percentSum, type PayoutForm } from '../lib/income.ts';

export function IncomeSourceList({
  payouts,
  usePercent,
  gross,
  currency,
  onChange,
  onTogglePercent,
  onGrossChange,
}: {
  payouts: PayoutForm[];
  usePercent: boolean;
  gross: string;
  currency: string;
  onChange: (next: PayoutForm[]) => void;
  onTogglePercent: (next: boolean) => void;
  onGrossChange: (next: string) => void;
}) {
  const { t } = useI18n();
  const patch = (i: number, field: Partial<PayoutForm>) =>
    onChange(payouts.map((p, idx) => (idx === i ? { ...p, ...field } : p)));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('income.amounts.title')}</label>
        <p className="dim micro">{t('income.amounts.hint')}</p>
      </div>

      <div className="row">
        <button type="button" className="chip" aria-pressed={usePercent} onClick={() => onTogglePercent(!usePercent)}>
          {t('income.amounts.percentToggle')}
        </button>
        {usePercent && (
          <input
            className="field mono"
            style={{ width: 140 }}
            inputMode="decimal"
            placeholder={`${t('income.amounts.gross')} · ${currency}`}
            value={gross}
            onChange={(e) => onGrossChange(e.target.value.replace(',', '.'))}
          />
        )}
      </div>

      <div className="card" style={{ display: 'grid', gap: 8 }}>
        {payouts.map((payout, i) => (
          <div className="row" key={i}>
            <input
              className="field"
              style={{ flex: 2, minWidth: 110 }}
              placeholder={t('income.amounts.label')}
              value={payout.label}
              onChange={(e) => patch(i, { label: e.target.value })}
            />
            <input
              className="field mono"
              style={{ width: 64 }}
              inputMode="numeric"
              title={t('income.amounts.day')}
              value={payout.day}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                patch(i, { day: n >= 1 && n <= 31 ? n : payout.day });
              }}
            />
            {usePercent ? (
              <input
                className="field mono"
                style={{ width: 90 }}
                inputMode="decimal"
                placeholder={t('income.amounts.percent')}
                value={payout.percent}
                onChange={(e) => patch(i, { percent: e.target.value.replace(',', '.') })}
              />
            ) : (
              <input
                className="field mono"
                style={{ flex: 1, minWidth: 100 }}
                inputMode="decimal"
                placeholder={`${t('income.amounts.amount')} · ${currency}`}
                value={payout.amount}
                onChange={(e) => patch(i, { amount: e.target.value.replace(',', '.') })}
              />
            )}
            {payouts.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost"
                aria-label={t('common.cancel')}
                onClick={() => onChange(payouts.filter((_, idx) => idx !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <div className="row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onChange([...payouts, { label: '', day: 15, amount: '', percent: '' }])}
          >
            {t('income.amounts.add')}
          </button>
        </div>
      </div>

      {usePercent && (
        <p className="dim micro">{t('income.amounts.percentSum', { sum: percentSum(payouts), gross: gross || '—' })}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Заменить `PaydayStep` на `IncomeStep`**

В `apps/web/src/screens/Onboarding.tsx` удалить импорт `PAYDAY_PRESETS` и функцию `PaydayStep` (строки 21–64), добавить:

```tsx
import { RhythmPicker } from '../components/RhythmPicker.tsx';
import { IncomeSourceList } from '../components/IncomeSourceList.tsx';
import { payoutsToSources, rhythmToConfig, type PayoutForm, type RhythmForm } from '../lib/income.ts';
import { rhythmMismatches } from '@multa/core';
import { useSaveOnboardingIncome } from '../lib/queries.ts';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

// --- Шаг 2: ритм планирования + источники дохода ---

/**
 * Сид меток выплат — ДАННЫЕ пользователя, не строки интерфейса, поэтому i18n-ключей у них нет:
 * подставляем на языке локали и даём переписать.
 */
const SEED_LABELS: Record<'ru' | 'en', [string, string]> = {
  ru: ['Аванс', 'Зарплата'],
  en: ['Advance', 'Salary'],
};

function IncomeStep({ base, onDone }: { base: string; onDone: () => void }) {
  const { t, locale } = useI18n();
  const today = todayISO();
  const [rhythm, setRhythm] = useState<RhythmForm>({
    kind: 'twiceMonthly',
    days: [10, 25],
    weeks: 2,
    anchorDate: today,
    weekendRule: 'before',
  });
  const [payouts, setPayouts] = useState<PayoutForm[]>(() => {
    const [first, second] = SEED_LABELS[locale];
    return [
      { label: first, day: 10, amount: '', percent: '' },
      { label: second, day: 25, amount: '', percent: '' },
    ];
  });
  const [usePercent, setUsePercent] = useState(false);
  const [gross, setGross] = useState('');
  const save = useSaveOnboardingIncome();

  const sources = payoutsToSources(payouts, { currency: base, usePercent, gross });
  const canContinue = sources.length > 0 && (rhythm.kind !== 'everyWeeks' || rhythm.anchorDate !== '');
  const mismatches = canContinue
    ? rhythmMismatches(
        rhythmToConfig(rhythm),
        sources.map((s, i) => ({
          id: String(i),
          label: s.label,
          currency: s.currency,
          schedule: s.schedule as never,
          amount: { kind: 'absolute', amountMinor: 1n },
          stability: 'fixed',
          active: true,
        })),
        rhythm.weekendRule,
        today,
        2,
      )
    : [];

  return (
    <OnboardingShell step={2}>
      <div>
        <h1 style={{ margin: 0, fontSize: 32 }}>{t('onboarding.payday.title')}</h1>
        <p className="dim" style={{ marginTop: 8 }}>{t('onboarding.payday.subtitle')}</p>
      </div>
      <RhythmPicker value={rhythm} onChange={setRhythm} today={today} />
      <IncomeSourceList
        payouts={payouts}
        usePercent={usePercent}
        gross={gross}
        currency={base}
        onChange={setPayouts}
        onTogglePercent={setUsePercent}
        onGrossChange={setGross}
      />
      {mismatches.map((date) => (
        <div className="note-band" key={date}>{t('income.amounts.mismatch', { date })}</div>
      ))}
      {save.isError && <div className="note-band">{t('common.error')}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {/* Доход обязателен: без валидной суммы план собрался бы на нуле. */}
        <button
          className="btn"
          disabled={save.isPending || !canContinue}
          onClick={() =>
            save.mutate(
              { rhythm: rhythmToConfig(rhythm), weekendRule: rhythm.weekendRule, sources },
              { onSuccess: onDone },
            )
          }
        >
          {t('common.next')}
        </button>
      </div>
    </OnboardingShell>
  );
}
```

В нижней части файла заменить рендер шага 2: `if (step === 2) return <IncomeStep base={base} onDone={() => setStep(3)} />;`

- [ ] **Step 4: Удалить пресеты**

```bash
git rm apps/web/src/lib/paydayPresets.ts
grep -rn "paydayPresets\|PAYDAY_PRESETS" apps/web/src || echo "ссылок не осталось"
```

Expected: вторая команда печатает «ссылок не осталось» (иначе останется `Settings.tsx` — он в Task 11, тогда сначала сделать Task 11).

- [ ] **Step 5: Typecheck и тесты**

Run: `pnpm typecheck && pnpm --filter @multa/web test`
Expected: PASS. Ошибка про `rhythmMismatches` с фиктивной суммой (`amountMinor: 1n`) означает, что тип `IncomeSource` требует иных полей — сверить с Task 2.

- [ ] **Step 6: Коммит**

```bash
git add apps/web/src
git commit -m "feat(web): шаг дохода — ритм с превью дат и выплаты вместо пресетов"
```

---

## Task 11: Редактор дохода в настройках

**Files:**
- Modify: `apps/web/src/screens/Settings.tsx`

**Interfaces:**
- Consumes: Task 9 (`useIncomeSources`, `useCreateIncomeSource`, `useDeleteIncomeSource`, `WorkspaceDto.rhythm`), Task 10 (`RhythmPicker`).
- Produces: экран настроек без пресетов; правка ритма через `PATCH /v1/workspace`.

- [ ] **Step 1: Переписать экран**

`apps/web/src/screens/Settings.tsx` целиком:

```tsx
import { money, toMajorString } from '@multa/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RhythmPicker } from '../components/RhythmPicker.tsx';
import { api } from '../lib/api.ts';
import { useI18n } from '../lib/i18n.tsx';
import { type RhythmForm } from '../lib/income.ts';
import { useDeleteIncomeSource, useIncomeSources, useMe } from '../lib/queries.ts';

const todayISO = (): string => new Date().toISOString().slice(0, 10);

/** Ритм из воркспейса → состояние формы. Незнакомый вид → дефолт «два раза в месяц». */
function toRhythmForm(rhythm: unknown, weekendRule: RhythmForm['weekendRule']): RhythmForm {
  const r = rhythm as { kind?: string; days?: number[]; weeks?: number; startsOn?: string } | null;
  const today = todayISO();
  if (r?.kind === 'every-weeks') {
    return { kind: 'everyWeeks', days: [10, 25], weeks: r.weeks ?? 2, anchorDate: r.startsOn ?? today, weekendRule };
  }
  if (r?.kind === 'monthly-days' && r.days?.length === 1) {
    return { kind: 'monthly', days: r.days, weeks: 2, anchorDate: today, weekendRule };
  }
  return { kind: 'twiceMonthly', days: r?.days ?? [10, 25], weeks: 2, anchorDate: today, weekendRule };
}

/** Сумма источника в major-строке — для отображения в списке. */
function amountLabel(amount: unknown, currency: string): string {
  const a = amount as { kind?: string; amountMinor?: string; percent?: string; ofMinor?: string };
  if (a?.kind === 'percent') return `${a.percent}%`;
  if (a?.kind === 'absolute' && a.amountMinor) return toMajorString(money(BigInt(a.amountMinor), currency));
  return '—';
}

/** Читаемое расписание источника. */
function scheduleLabel(schedule: unknown): string {
  const s = schedule as { kind?: string; days?: number[]; weeks?: number; date?: string };
  if (s?.kind === 'monthly-days') return (s.days ?? []).join(', ');
  if (s?.kind === 'every-weeks') return `×${s.weeks}`;
  if (s?.kind === 'one-off') return s.date ?? '—';
  return '—';
}

export function Settings() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const ws = me?.workspace;
  const { data: sources = [] } = useIncomeSources(Boolean(ws));
  const removeSource = useDeleteIncomeSource();

  const [currency, setCurrency] = useState(ws?.baseCurrency ?? 'RUB');
  const [rhythm, setRhythm] = useState<RhythmForm>(toRhythmForm(ws?.rhythm ?? null, ws?.weekendRule ?? 'before'));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api('/v1/workspace', {
        method: 'PATCH',
        body: JSON.stringify({
          baseCurrency: currency.toUpperCase().slice(0, 3),
          rhythm: rhythmToPayload(rhythm),
          weekendRule: rhythm.weekendRule,
        }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['plan'] });
      setSaved(true);
    },
  });

  if (!ws) return <div style={{ padding: 24 }} className="dim">{t('common.loading')}</div>;

  return (
    <div style={{ padding: 24, maxWidth: 560, display: 'grid', gap: 20 }}>
      <h1 className="section-title">{t('settings.title')}</h1>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('settings.currency')}</label>
        <input
          className="field mono"
          value={currency}
          maxLength={3}
          onChange={(e) => { setCurrency(e.target.value.toUpperCase()); setSaved(false); }}
        />
      </div>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('settings.rhythm')}</label>
        <RhythmPicker value={rhythm} onChange={(next) => { setRhythm(next); setSaved(false); }} today={todayISO()} />
      </div>
      <div>
        <label className="micro" style={{ display: 'block', marginBottom: 8 }}>{t('settings.sources')}</label>
        <div className="card" style={{ display: 'grid', gap: 4 }}>
          {sources.map((s) => (
            <div key={s.id} className="list-item">
              <span>
                {s.label} <span className="dim">· {scheduleLabel(s.schedule)}</span>
                {s.stability === 'variable' && <span className="dim"> · {t('income.variable')}</span>}
              </span>
              <span className="row">
                <span className="mono dim">{amountLabel(s.amount, s.currency)} {s.currency}</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={t('common.cancel')}
                  disabled={removeSource.isPending}
                  onClick={() => removeSource.mutate(s.id)}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {saved && <span className="dim">{t('common.saved')}</span>}
        <button className="btn" disabled={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</button>
      </div>
    </div>
  );
}
```

`rhythmToPayload` — тонкая обёртка над `rhythmToConfig` без поля `weekendRule` (сервер собирает его сам из `weekendRule` тела запроса). Добавить в `apps/web/src/lib/income.ts`:

```ts
/** Ритм для API: без weekendRule — сервер склеивает его сам, чтобы правило жило в одном месте. */
export function rhythmToPayload(form: RhythmForm): Record<string, unknown> {
  const config = rhythmToConfig(form);
  const { weekendRule: _ignored, ...rest } = config as Record<string, unknown> & { weekendRule?: unknown };
  return rest;
}
```

и импортировать её в `Settings.tsx` рядом с `RhythmForm`.

- [ ] **Step 2: Typecheck и тесты**

Run: `pnpm typecheck && pnpm --filter @multa/web test && grep -rn "PAYDAY_PRESETS" apps/web/src || echo "пресетов не осталось"`
Expected: PASS, пресетов не осталось.

- [ ] **Step 3: Коммит**

```bash
git add apps/web/src
git commit -m "feat(web): настройки — редактор ритма и список источников дохода"
```

---

## Task 12: Документация

Изменение не готово, пока доки описывают старую модель (правило №4: доки — часть Definition of Done, сверять с кодом, а не по памяти).

**Files:**
- Modify: `docs/01-domain-model.md`, `docs/02-data-schema.md`, `docs/04-web-ux.md`

- [ ] **Step 1: `02-data-schema.md` — сверить с `domain.ts`**

В блоке `create table workspaces` заменить две строки:

```sql
  period_anchors jsonb,           -- ритм планирования: PeriodConfig (@multa/core), задаёт границы периодов
  payday_weekend_rule text not null default 'before' check (payday_weekend_rule in ('as-is','before','after')),
```

(строка `expected_income_minor bigint` удаляется — доход периода живёт в `pay_periods.expected_income_minor`).

Добавить таблицу после `workspaces`:

```sql
create table income_sources (      -- только деньги: сколько и когда приходит; границы периодов задаёт ритм
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces on delete cascade,
  label text not null,             -- «Аванс», «Зарплата», «Подработка»
  currency char(3) not null,
  schedule jsonb not null,         -- IncomeSchedule: monthly-days | every-weeks | one-off | irregular
  amount jsonb not null,           -- IncomeAmount: absolute{amountMinor} | percent{percent, ofMinor}; суммы — строки-целые
  stability text not null default 'fixed' check (stability in ('fixed','variable')),
  active boolean not null default true,
  starts_on date,                  -- источник появился (новая работа)
  ends_on date,                    -- источник кончился (уволился) — это знает прогноз
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create index income_sources_ws_idx on income_sources (workspace_id, sort);
```

В `recurring_items` заменить check: `check (kind in ('expense','envelope','goal','debt'))` и дописать комментарий `-- доходы живут в income_sources: одна правда о доходах`.

- [ ] **Step 2: `01-domain-model.md`**

Добавить раздел `### IncomeSource` перед `### RecurringItem`:

```markdown
### IncomeSource
Источник дохода: метка, расписание (дни месяца | цикл в N недель | разово | «когда как»), сумма или процент от оклада, валюта, `fixed`/`variable`, срок жизни (`startsOn`/`endsOn`). Только деньги — **границы периодов задаёт ритм** (`workspaces.period_anchors`), и правка источника их не двигает. Ожидаемый доход периода = сумма событий всех активных источников внутри `[startsOn, endsOn)`; недельная подработка добавляет приходы внутрь периода, а не режет его на куски. `irregular` в план не идёт вообще (только факт), `variable` планируется по нижней оценке: завышенная цифра дня — самая дорогая ошибка продукта.

**Доходы живут только здесь.** `RecurringItem` описывает регулярные расходы и взносы; `kind = 'income'` из него убран, чтобы не было двух правд об одном факте.
```

В `### RecurringItem` заменить первую фразу на: «Повторяющиеся расход/взнос (аренда, подписка, платёж по долгу) с RRULE-подобным расписанием. Питает прогноз и автозаполнение плана периода. Доходы — в `IncomeSource`.»

В `## Инварианты (для тестов)` дописать пункты:

```markdown
7. Ритм задаёт границы периодов; источники дохода их не меняют — история планов не переезжает при добавлении источника.
8. Приход в день `endsOn` относится к следующему периоду (интервал полуоткрытый).
9. Курс недоступен → приход попадает в `unresolved`, а не в молчаливый ноль.
10. `irregular` не участвует в плане; `variable` планируется по нижней оценке.
```

- [ ] **Step 3: `04-web-ux.md`**

Заменить пункт 2 списка «Онбординг»:

```markdown
2. «Когда приходят деньги?» — два блока. Сначала **ритм планирования**: два раза в месяц (числа редактируемые), раз в месяц N-го, цикл в N недель от реальной даты выплаты — у каждого варианта превью ближайших дат, которые реально сгенерит планировщик, плюс правило переноса выплаты с выходного. Затем **сколько приходит**: список выплат (метка · число · сумма или % от оклада), предзаполненный числами ритма. Дальше пропускаемый вопрос «есть ещё источники дохода?» — подработка, разовый гонорар, «когда как».
```

- [ ] **Step 4: Проверить, что доки не разошлись с кодом**

```bash
grep -n "expected_income_minor" docs/02-data-schema.md   # должен остаться только в pay_periods
grep -rn "period_anchors" docs/ | grep -v "ритм"          # не должно быть описаний «якоря выплат»
grep -rn "paydayPresets\|пресет" docs/04-web-ux.md        # пресетов в описании онбординга быть не должно
```

- [ ] **Step 5: Коммит**

```bash
git add docs/01-domain-model.md docs/02-data-schema.md docs/04-web-ux.md
git commit -m "docs: модель дохода — ритм, источники, инварианты"
```

---

## Task 13: Смоук реального флоу и закрытие issues

Правило №2: не объявлять готовым без фактической проверки; правило «смоук реального флоу, а не по коду должно работать».

- [ ] **Step 1: Полный прогон проверок**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS во всех воркспейсах.

- [ ] **Step 2: Поднять api и web**

```bash
cd apps/api && DATABASE_URL='postgres://multa:multa_dev_password@localhost:5432/multa' BETTER_AUTH_SECRET='dev_secret_at_least_16_chars_xx' API_PORT=3000 WEB_ORIGIN='http://localhost:5173' BETTER_AUTH_URL='http://localhost:3000' npx tsx src/server.ts
```

(в фоне; **не** `tsx watch`), затем:

```bash
cd apps/web && VITE_API_URL='http://localhost:3000' npx vite --port 5173 --host
```

- [ ] **Step 3: Пройти флоу в браузере**

Через chrome-devtools MCP (`new_page` → `http://localhost:5173/?fresh=1`): регистрация нового пользователя → шаг валюты → шаг дохода: сменить ритм на «раз в месяц» и убедиться, что число редактируется и превью пересчитывается; вернуть «два раза в месяц» 10/25; вписать суммы 80000 и 120000; пройти дальше и дойти до плана.

React controlled-inputs заполнять не `fill`, а `evaluate_script`: нативный value-сеттер + `dispatchEvent(new Event('input', { bubbles: true }))` — иначе `onChange` не срабатывает.

Expected: на «Сегодня» ожидаемый доход равен сумме выплат **текущего** периода (80 000, если сегодня между 10-м и 25-м; 120 000, если между 25-м и 10-м), а не сумме обеих.

- [ ] **Step 4: Проверить второй источник и настройки**

В настройках убедиться: ритм отображается тем же редактором, список источников показывает две выплаты, удаление работает. Затем через API добавить недельную подработку и проверить, что доход периода вырос, а **границы периода не сдвинулись**:

```bash
curl -s -b cookies.txt -X POST http://localhost:3000/v1/income-sources \
  -H 'Content-Type: application/json' \
  -d '{"label":"Подработка","currency":"RUB","schedule":{"kind":"every-weeks","weeks":1,"startsOn":"2026-08-07"},"amount":{"kind":"absolute","amountMinor":"1500000"},"stability":"variable"}'
curl -s -b cookies.txt http://localhost:3000/v1/plan/current | head -c 400
```

Expected: `period` тот же, `incomeMinor` вырос на 2–3 подработки, `income.events` перечисляет приходы по датам.

- [ ] **Step 5: Прогнать Prettier по затронутому**

```bash
pnpm prettier --write "packages/core/src/income*.ts" "packages/core/src/periods.ts" "apps/api/src/income/*.ts" "apps/api/src/routes/income.ts" "apps/web/src/components/{RhythmPicker,IncomeSourceList}.tsx" "apps/web/src/lib/income*.ts" "apps/web/src/screens/{Onboarding,Settings}.tsx"
```

- [ ] **Step 6: Финальный коммит и закрытие issues**

```bash
git add -A && git commit -m "chore: prettier по файлам модели дохода"
gh issue comment 21 --body "Развязка принята в #26: каноническая таблица доходов — \`income_sources\`; \`recurring_items.kind\` больше не допускает \`'income'\`, значит этот issue строит только расходную часть."
gh issue close 27 --comment "Закрыто вместе с #26: пресеты выплат удалены, числа и дата якоря редактируемые, под выбором — превью реальных дат из generatePeriods."
gh issue close 26 --comment "Готово: ритм планирования (workspaces.period_anchors + payday_weekend_rule) отделён от источников дохода (income_sources). Доход периода считается по событиям источников, план 10–25 и 25–10 различается. Спека: docs/superpowers/specs/2026-07-30-income-sources-design.md"
```

---

## Self-Review

**Покрытие спеки:**

| Требование спеки | Задача |
|---|---|
| Ритм — настройка воркспейса, `period_anchors` остаётся | 4, 6 |
| `payday_weekend_rule` на воркспейсе, дефолт `before` | 4, 5, 6 |
| `income_sources` плоской таблицей | 4, 6 |
| `expected_income_minor` удалена с воркспейса | 4, 7 |
| `recurring_items.kind` без `'income'` | 4, 12 |
| Типы `IncomeSource`/`Schedule`/`Amount`/`Event` | 2 |
| `amountOfSource`, `percentOfMinor` | 2 (+ DRY в 7) |
| `incomeEventsIn` (полуоткрытость, кламп, выходные, срок жизни, irregular, one-off) | 2 |
| `expectedIncomeForPeriod` + `unresolved` | 3 |
| `rhythmMismatches` | 3, 10 |
| `weekendRule` в `PeriodConfig` и сдвиг до сборки периодов | 1 |
| CRUD `/v1/income-sources` | 6 |
| `POST /v1/onboarding/income` атомарно | 6 |
| `PATCH /v1/workspace` (ритм + правило) | 6 |
| Блок `income` в `/v1/plan/current`, доход по периоду | 7 |
| Гейт онбординга «ритм + активный источник» | 6, 9 |
| Zod: discriminatedUnion, day 1..31, percent (0,100], minor строкой | 5 |
| Шаг: ритм с превью → суммы → доп. источники | 10 |
| Редактируемые числа и обязательная дата якоря (#27) | 10 |
| Тот же редактор в настройках, `paydayPresets.ts` удалён | 10, 11 |
| i18n ru+en, старые ключи удалены | 8 |
| Тесты core / api / web | 1, 2, 3, 5, 9 |
| Доки 01/02/04 | 12 |
| Смоук реального флоу | 13 |

**Не покрыто спекой намеренно:** блок 3 шага («ещё источники») в Task 10 отрисован кнопками-заготовками только в разметке первого блока выплат; полноценный экран доп. источников добавляется тем же `IncomeSourceList` в настройках (Task 11) — отдельного визарда для него нет, и это соответствует «пропускаемо» из спеки.

**Согласованность типов:** `IncomeSource`/`IncomeEvent` (Task 2) — единственное определение, `apps/api/src/income/store.ts` возвращает именно его; `RhythmForm`/`PayoutForm` (Task 9) используются в Task 10–11 под теми же именами; `rhythmToConfig` → `PeriodConfig` (Task 1) → `generatePeriods` — одна цепочка без переименований.
